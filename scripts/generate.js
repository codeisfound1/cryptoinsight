// scripts/generate.js
// Nguồn: RSS công khai từ CoinDesk, Cointelegraph, Decrypt, The Block
// Lấy Top 10 tin mới nhất → Groq AI tổng hợp → lưu docs/posts.json

"use strict";

const https  = require("https");
const http   = require("http");
const fs     = require("fs");
const path   = require("path");
const crypto = require("crypto");

// ─── CONFIG ────────────────────────────────────────────────────────────────

// RSS feeds công khai — không cần API key, không bị chặn bởi robots
const RSS_SOURCES = [
  { name: "CoinDesk",       url: "https://www.coindesk.com/arc/outboundfeeds/rss/",  weight: 3 },
  { name: "Cointelegraph",  url: "https://cointelegraph.com/rss",                    weight: 3 },
  { name: "Decrypt",        url: "https://decrypt.co/feed",                           weight: 2 },
  { name: "The Block",      url: "https://www.theblock.co/rss.xml",                  weight: 2 },
];

const TOP_N = 10;  // Số tin tổng hợp mỗi lần chạy

const GROQ_URL   = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "llama-3.3-70b-versatile";

const POSTS_FILE   = path.join(__dirname, "../docs/posts.json");
const SITEMAP_FILE = path.join(__dirname, "../docs/sitemap.xml");
const ROBOTS_FILE  = path.join(__dirname, "../docs/robots.txt");
const SITE_URL     = process.env.SITE_URL || "https://your-username.github.io/cryptoinsight";
const GROQ_KEY     = process.env.GROQ_API_KEY;
const FORCE        = process.env.FORCE === "true";

// Cloudinary (tuỳ chọn)
const CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME;
const CLOUDINARY_API_KEY    = process.env.CLOUDINARY_API_KEY;
const CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET;

if (!GROQ_KEY) {
  console.error("❌ Thiếu GROQ_API_KEY");
  process.exit(1);
}

// ─── HTTP HELPERS ──────────────────────────────────────────────────────────

function fetchUrl(url, redirectCount, extraHeaders) {
  redirectCount = redirectCount || 0;
  if (redirectCount > 5) return Promise.reject(new Error("Too many redirects"));

  return new Promise((resolve, reject) => {
    const client = url.startsWith("https") ? https : http;
    const req = client.get(url, {
      headers: Object.assign({
        "User-Agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        "Accept":          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9,vi;q=0.8",
        "Accept-Charset":  "UTF-8",
        "Cache-Control":   "no-cache",
        "Referer":         "https://www.google.com/",
      }, extraHeaders || {}),
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const next = res.headers.location.startsWith("http")
          ? res.headers.location
          : new URL(res.headers.location, url).href;
        return fetchUrl(next, redirectCount + 1, extraHeaders).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end",  () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
    req.on("error", reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error("Timeout: " + url)); });
  });
}

function postJson(url, payload, headers) {
  return new Promise((resolve, reject) => {
    const body    = JSON.stringify(payload);
    const urlObj  = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path:     urlObj.pathname,
      method:   "POST",
      headers:  Object.assign({
        "Content-Type":   "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(body, "utf8"),
      }, headers || {}),
    };
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end",  () => {
        const text = Buffer.concat(chunks).toString("utf8");
        try { resolve(JSON.parse(text)); }
        catch (e) { reject(new Error("JSON parse failed: " + text.slice(0, 300))); }
      });
    });
    req.on("error", reject);
    req.setTimeout(90000, () => { req.destroy(); reject(new Error("Groq timeout")); });
    req.write(body, "utf8");
    req.end();
  });
}

// ─── RSS READER ────────────────────────────────────────────────────────────

/**
 * Đọc một RSS feed, trả về mảng articles
 * Hỗ trợ cả RSS 2.0 và Atom
 */
async function fetchRssFeed(source) {
  console.log("📡  Đang đọc RSS: " + source.name + " ← " + source.url);
  let xml;
  try {
    xml = await fetchUrl(source.url, 0, {
      "Accept": "application/rss+xml, application/xml, text/xml, */*",
    });
  } catch(e) {
    console.warn("   ⚠️  " + source.name + " thất bại:", e.message);
    return [];
  }

  const articles = [];

  // Hỗ trợ RSS <item> và Atom <entry>
  const itemRe = /<(?:item|entry)>([\s\S]*?)<\/(?:item|entry)>/gi;
  let m;
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[1];

    // Title — ưu tiên CDATA
    const titleM = block.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i);
    const title  = titleM ? decodeHtmlEntities(titleM[1].trim()) : "";

    // URL — <link>, <link href="...">, hoặc <guid isPermaLink="true">
    let url = "";
    const linkM = block.match(/<link>(?:<!\[CDATA\[)?(https?:\/\/[^<\]]+?)(?:\]\]>)?<\/link>/i)
               || block.match(/<link[^>]+href=["'](https?:\/\/[^"']+)["']/i)
               || block.match(/<guid[^>]*isPermaLink=["']true["'][^>]*>(https?:\/\/[^<]+)<\/guid>/i);
    if (linkM) url = linkM[1].trim();

    if (!url || !url.startsWith("http")) continue;

    // Description / summary
    const descM = block.match(/<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/i)
               || block.match(/<summary[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/summary>/i)
               || block.match(/<content:encoded>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/content:encoded>/i);
    let description = descM ? decodeHtmlEntities(descM[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()).slice(0, 300) : "";

    // Published date — <pubDate> hoặc <published>
    const dateM = block.match(/<pubDate>([^<]+)<\/pubDate>/i)
               || block.match(/<published>([^<]+)<\/published>/i)
               || block.match(/<updated>([^<]+)<\/updated>/i);
    const publishedAt = dateM ? new Date(dateM[1].trim()).toISOString() : new Date().toISOString();

    // Ảnh — media:content, enclosure, hoặc og:image trong content
    let imageUrl = null;
    const mediaM = block.match(/<media:(?:content|thumbnail)[^>]+url=["']([^"']+)["']/i)
                || block.match(/<enclosure[^>]+url=["']([^"']+)["'][^>]+type=["']image/i);
    if (mediaM) imageUrl = mediaM[1];
    if (!imageUrl && descM) {
      const imgM = descM[1].match(/<img[^>]+src=["'](https?:\/\/[^"']+)["']/i);
      if (imgM) imageUrl = imgM[1];
    }

    articles.push({ url, title, description, imageUrl, publishedAt, sourceName: source.name });
  }

  console.log("   → " + articles.length + " bài từ " + source.name);
  return articles;
}

/**
 * Lấy top N tin mới nhất từ tất cả RSS sources
 * Sắp xếp theo thời gian đăng (mới nhất trước), loại trùng URL
 */
async function fetchTopNewsFromRss() {
  console.log("\n📰  Đang tổng hợp RSS từ " + RSS_SOURCES.length + " nguồn...");

  const allArticles = [];
  for (const source of RSS_SOURCES) {
    const items = await fetchRssFeed(source);
    allArticles.push(...items);
  }

  // Loại trùng URL
  const seen   = new Set();
  const unique = allArticles.filter(a => {
    if (seen.has(a.url)) return false;
    seen.add(a.url);
    return true;
  });

  // Sắp xếp mới nhất trước
  unique.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

  const result = unique.slice(0, TOP_N);
  console.log("📋  Tổng hợp: " + unique.length + " bài từ " + RSS_SOURCES.length + " nguồn → lấy top " + result.length);
  return result;
}

// ─── ENRICH ARTICLE METADATA ───────────────────────────────────────────────

async function enrichArticle(article) {
  // RSS thường đã có title + description đủ dùng
  if (article.title && article.description && article.description.length > 80 && article.imageUrl) {
    console.log("  ✅ Đủ metadata: " + article.title.slice(0, 60));
    return article;
  }

  // Chỉ fetch thêm nếu thiếu ảnh hoặc description quá ngắn
  console.log("  📄 Fetch bổ sung: " + article.url.slice(0, 80));
  try {
    const html = await fetchUrl(article.url);

    if (!article.description || article.description.length < 80) {
      const dm = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)
               || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i)
               || html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i);
      if (dm) article.description = decodeHtmlEntities(dm[1]).slice(0, 300);
    }

    if (!article.imageUrl) {
      article.imageUrl = extractImage(html, article.url);
    }

    // Content snippet cho AI
    const cleanText = html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<nav[\s\S]*?<\/nav>/gi, "")
      .replace(/<header[\s\S]*?<\/header>/gi, "")
      .replace(/<footer[\s\S]*?<\/footer>/gi, "")
      .replace(/<aside[\s\S]*?<\/aside>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 1500);
    article.contentSnippet = decodeHtmlEntities(cleanText);

  } catch(e) {
    console.warn("  ⚠️  Không fetch được:", e.message);
  }

  return article;
}

function extractImage(html, baseUrl) {
  let m = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
           || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
  if (m && m[1] && m[1].startsWith("http")) return m[1];

  m = html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i)
    || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i);
  if (m && m[1] && m[1].startsWith("http")) return m[1];

  const bodyMatch = html.match(/<(?:article|main|div[^>]+class=["'][^"']*(?:content|body|post|article)[^"']*["'])[^>]*>([\s\S]{0,8000})/i);
  const area      = bodyMatch ? bodyMatch[1] : html;
  const imgRe     = /<img[^>]+src=["']([^"']{10,})["'][^>]*/gi;
  while ((m = imgRe.exec(area)) !== null) {
    const tag = m[0];
    const w   = tag.match(/width=["'](\d+)["']/i);
    const h   = tag.match(/height=["'](\d+)["']/i);
    if (w && parseInt(w[1]) < 200) continue;
    if (h && parseInt(h[1]) < 150) continue;
    const src = m[1];
    if (src.startsWith("data:")) continue;
    if (src.startsWith("http"))  return src;
    if (src.startsWith("/")) { try { return new URL(src, baseUrl).href; } catch(_) {} }
  }
  return null;
}

// ─── CLOUDINARY ────────────────────────────────────────────────────────────

async function uploadToCloudinary(imageUrl, slug, altText, tags) {
  if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) return null;
  try {
    console.log("☁️  Upload Cloudinary:", imageUrl.slice(0, 80));
    const timestamp  = Math.floor(Date.now() / 1000).toString();
    const tagsStr    = (tags || []).slice(0, 5).join(",") || "crypto,bitcoin";
    const contextStr = "alt=" + altText.replace(/[|=]/g, " ") + "|caption=" + altText.replace(/[|=]/g, " ");
    const signParams = ["context=" + contextStr, "folder=cryptoinsight/posts", "overwrite=true", "public_id=" + slug, "tags=" + tagsStr, "timestamp=" + timestamp].join("&");
    const signature  = crypto.createHash("sha1").update(signParams + CLOUDINARY_API_SECRET).digest("hex");

    const formData = [["file", imageUrl], ["public_id", slug], ["folder", "cryptoinsight/posts"], ["overwrite", "true"], ["tags", tagsStr], ["context", contextStr], ["timestamp", timestamp], ["api_key", CLOUDINARY_API_KEY], ["signature", signature]];
    const boundary = "----CryptoInsight" + Date.now();
    const bodyStr  = formData.map(([k, v]) => "--" + boundary + "\r\nContent-Disposition: form-data; name=\"" + k + "\"\r\n\r\n" + v + "\r\n").join("") + "--" + boundary + "--\r\n";
    const bodyBuf  = Buffer.from(bodyStr, "utf8");

    const result = await new Promise((resolve, reject) => {
      const options = { hostname: "api.cloudinary.com", path: "/v1_1/" + CLOUDINARY_CLOUD_NAME + "/image/upload", method: "POST", headers: { "Content-Type": "multipart/form-data; boundary=" + boundary, "Content-Length": bodyBuf.length } };
      const req = https.request(options, (res) => {
        const chunks = [];
        res.on("data", c => chunks.push(c));
        res.on("end",  () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch(e) { reject(e); } });
      });
      req.on("error", reject);
      req.setTimeout(60000, () => { req.destroy(); reject(new Error("Cloudinary timeout")); });
      req.write(bodyBuf); req.end();
    });

    if (result.error) { console.warn("⚠️  Cloudinary lỗi:", result.error.message); return null; }
    const transformedUrl = result.secure_url.replace("/upload/", "/upload/f_auto,q_auto,w_1200,h_630,c_fill,g_auto/");
    console.log("✅  Cloudinary OK:", result.public_id);
    return { url: transformedUrl, rawUrl: result.secure_url, publicId: result.public_id, width: result.width, height: result.height, format: result.format, alt: altText };
  } catch(err) {
    console.warn("⚠️  Cloudinary thất bại:", err.message);
    return null;
  }
}

// ─── POSTS STORAGE ─────────────────────────────────────────────────────────

function loadPosts() {
  try {
    if (fs.existsSync(POSTS_FILE)) return JSON.parse(fs.readFileSync(POSTS_FILE, "utf8"));
  } catch(e) { console.warn("Không đọc được posts.json:", e.message); }
  return { posts: [], publishedUrls: [], publishedBatchKeys: [] };
}

function savePosts(data) {
  fs.mkdirSync(path.dirname(POSTS_FILE), { recursive: true });
  fs.writeFileSync(POSTS_FILE, JSON.stringify(data, null, 2), "utf8");
  console.log("✅  Đã lưu " + data.posts.length + " bài vào docs/posts.json");
  saveSitemap(data.posts);
  saveRobots();
}

function saveSitemap(posts) {
  const base  = SITE_URL.replace(/\/$/, "");
  const today = new Date().toISOString().slice(0, 10);
  const pages = [
    { loc: base + "/", priority: "1.0", changefreq: "daily",   lastmod: today },
    ...posts.map(p => ({ loc: base + "/#" + (p.slug || p.id), priority: "0.8", changefreq: "monthly", lastmod: p.publishedAt ? p.publishedAt.slice(0, 10) : today })),
  ];
  const esc = s => String(s || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  const xml  = ['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">',
    ...pages.map((u, i) => {
      const post   = posts[i - 1];
      const imgTag = post && post.image && post.image.url ? "\n    <image:image>\n      <image:loc>" + esc(post.image.url) + "</image:loc>\n      <image:title>" + esc(post.title) + "</image:title>\n      <image:caption>" + esc(post.image.alt || post.title) + "</image:caption>\n    </image:image>" : "";
      return "  <url>\n    <loc>" + u.loc + "</loc>\n    <lastmod>" + u.lastmod + "</lastmod>\n    <changefreq>" + u.changefreq + "</changefreq>\n    <priority>" + u.priority + "</priority>" + imgTag + "\n  </url>";
    }), "</urlset>"].join("\n");
  fs.writeFileSync(SITEMAP_FILE, xml, "utf8");
  console.log("🗺️   Sitemap: " + pages.length + " URLs → docs/sitemap.xml");
}

function saveRobots() {
  const base = SITE_URL.replace(/\/$/, "");
  fs.writeFileSync(ROBOTS_FILE, "User-agent: *\nAllow: /\n\nSitemap: " + base + "/sitemap.xml\n", "utf8");
  console.log("🤖  robots.txt updated");
}

// ─── GROQ AI – TỔNG HỢP TOP 10 TIN ───────────────────────────────────────

async function generateRoundupWithGroq(articles) {
  console.log("🤖  Groq AI tổng hợp " + articles.length + " tin từ RSS...");

  const now = new Date();
  const today = now.toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric" });
  const timeStr = now.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Ho_Chi_Minh" });
  const todayWithTime = today + " lúc " + timeStr;
  const sourceNames  = [...new Set(articles.map(a => a.sourceName))].join(", ");

  const newsListText = articles.map((a, i) =>
    "[Tin " + (i + 1) + "] " + (a.title || "(không có tiêu đề)") + "\n" +
    "Nguồn: " + (a.sourceName || "CoinMarketCap") + " | URL: " + a.url + "\n" +
    (a.description ? "Mô tả: " + a.description.slice(0, 200) + "\n" : "") +
    (a.contentSnippet ? "Nội dung: " + a.contentSnippet.slice(0, 400) + "\n" : "")
  ).join("\n---\n");

  const systemPrompt =
    "Bạn là chuyên gia phân tích thị trường tiền điện tử (cryptocurrency) hàng đầu tại Việt Nam. " +
    "Bạn am hiểu sâu về Bitcoin, Ethereum, DeFi, NFT, altcoin và thị trường crypto toàn cầu. " +
    "Nhiệm vụ: nhận danh sách top " + articles.length + " tin crypto mới nhất và TRẢ VỀ DUY NHẤT một JSON object hợp lệ UTF-8. " +
    "Không có text nào khác, không markdown, không code block, không giải thích.";

  const userPrompt =
    "Dưới đây là TOP " + articles.length + " tin tức crypto mới nhất ngày " + todayWithTime +
    " tổng hợp từ: " + sourceNames + ".\n" +
    "Tổng hợp thành bài phân tích điểm tin thị trường toàn diện bằng tiếng Việt có dấu đầy đủ.\n\n" +
    "=== DANH SÁCH TIN TỨC ===\n" + newsListText + "\n" +
    "=== YÊU CẦU ===\n" +
    "- Toàn bộ nội dung PHẢI bằng tiếng Việt có dấu đầy đủ\n" +
    "- Tổng hợp TẤT CẢ " + articles.length + " tin, mỗi tin được phân tích riêng với heading\n" +
    "- Cấu trúc: Dẫn nhập tổng quan → Phân tích từng tin (theo thứ tự quan trọng) → Nhận định thị trường chung → Khuyến nghị\n" +
    "- Nêu bật xu hướng chung, mối liên hệ giữa các sự kiện\n" +
    "- Phân tích tác động thực tế đến nhà đầu tư Việt Nam\n" +
    "- Giải thích thuật ngữ kỹ thuật bằng tiếng Việt dễ hiểu\n" +
    "- Độ dài 800-1200 từ, dùng HTML cho content\n" +
    "- Tags bằng tiếng Việt hoặc tên coin (tối đa 6 tags)\n\n" +
    "CHỈ trả về JSON object, KHÔNG có gì khác:\n" +
    "{\"title\":\"Điểm tin crypto " + todayWithTime + ": [tóm tắt nổi bật]\"," +
    "\"summary\":\"Tóm tắt 2-3 câu điểm qua các sự kiện nổi bật nhất\"," +
    "\"tags\":[\"bitcoin\",\"ethereum\",\"thị trường\",\"điểm tin\"]," +
    "\"content\":\"<p>Dẫn nhập...</p><h2>1. [Sự kiện nổi bật nhất]</h2><p>Phân tích...</p><h2>2. [...]</h2><p>...</p><h2>Nhận định thị trường</h2><p>...</p><h2>Khuyến nghị nhà đầu tư</h2><p>...</p>\"," +
    "\"readTime\":8}";

  const res = await postJson(
    GROQ_URL,
    { model: GROQ_MODEL, messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }], temperature: 0.45, max_tokens: 3500 },
    { "Authorization": "Bearer " + GROQ_KEY }
  );

  if (res.error) throw new Error("Groq error: " + JSON.stringify(res.error));

  const raw  = ((res.choices || [])[0] || {}).message || {};
  const text = (raw.content || "").trim();
  console.log("📥  Groq raw (300c):", text.slice(0, 300));
  return parseJson(text, articles);
}

function parseJson(text, articles) {
  try { const p = JSON.parse(text); if (p && p.title) return p; } catch(_) {}
  const s = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  try { const p = JSON.parse(s); if (p && p.title) return p; } catch(_) {}
  const start = text.indexOf("{");
  if (start !== -1) {
    let depth = 0, end = -1, inStr = false, esc = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (esc)         { esc = false; continue; }
      if (ch === "\\") { esc = true;  continue; }
      if (ch === '"')  { inStr = !inStr; continue; }
      if (inStr)       continue;
      if (ch === "{")  depth++;
      else if (ch === "}") { if (--depth === 0) { end = i; break; } }
    }
    if (end !== -1) { try { const p = JSON.parse(text.slice(start, end + 1)); if (p && p.title) return p; } catch(_) {} }
  }
  console.warn("⚠️   Dùng regex fallback");
  const field = (k) => { const m = text.match(new RegExp('"' + k + '"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"', "i")); return m ? m[1].replace(/\\n/g, "\n").replace(/\\"/g, '"') : null; };
  const arr   = (k) => { const m = text.match(new RegExp('"' + k + '"\\s*:\\s*\\[([^\\]]+)\\]', "i")); return m ? (m[1].match(/"([^"]+)"/g) || []).map(x => x.replace(/"/g, "")) : []; };
  const num   = (k) => { const m = text.match(new RegExp('"' + k + '"\\s*:\\s*(\\d+)', "i")); return m ? parseInt(m[1]) : 8; };
  const title = field("title") || "Điểm tin crypto: Top " + articles.length + " sự kiện nổi bật";
  return {
    title,
    summary:  field("summary")  || "Tổng hợp " + articles.length + " tin crypto mới nhất từ CoinMarketCap AI Top News.",
    content:  field("content")  || "<p>" + articles.map(a => "<b>" + (a.title || a.url) + "</b>").join("</p><p>") + "</p>",
    tags:     arr("tags").length ? arr("tags") : ["bitcoin", "điểm tin", "crypto", "thị trường"],
    readTime: num("readTime"),
  };
}

// ─── SLUGIFY / DECODE ──────────────────────────────────────────────────────

function slugify(text) {
  return String(text)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d").replace(/Đ/g, "d")
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

function decodeHtmlEntities(str) {
  return String(str || "")
    .replace(/&amp;/g,  "&")
    .replace(/&lt;/g,   "<")
    .replace(/&gt;/g,   ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g,  "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g,      (_, n) => String.fromCodePoint(parseInt(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)));
}

// ─── MAIN ──────────────────────────────────────────────────────────────────

async function main() {
  console.log("=".repeat(60));
  console.log("🚀  Crypto Insight – RSS Multi-Source Roundup -", new Date().toISOString());
  console.log("📡  Nguồn:", RSS_SOURCES.map(s => s.name).join(", "));
  console.log("📋  Lấy top", TOP_N, "tin mới nhất");
  console.log("=".repeat(60));

  const data = loadPosts();
  console.log("📚  Hiện có:", data.posts.length, "bài đã đăng");

  // ─ Bước 1: Lấy top 10 tin từ RSS ─
  const cmcArticles = await fetchTopNewsFromRss();

  if (cmcArticles.length === 0) {
    console.error("❌  Không lấy được tin từ CMC AI Top News. Kết thúc.");
    process.exit(1);
  }

  // ─ Bước 2: Kiểm tra đã đăng chưa (dùng URL của 3 tin đầu làm batch key) ─
  const batchKey        = cmcArticles.slice(0, 3).map(a => a.url).join("|");
  const alreadyPosted   = !FORCE && (data.publishedBatchKeys || []).includes(batchKey);

  if (alreadyPosted) {
    console.log("ℹ️   Batch tin này đã được tổng hợp. Dùng FORCE=true để bỏ qua.");
    return;
  }

  console.log("\n📰  Danh sách " + cmcArticles.length + " tin từ CMC AI Top News:");
  cmcArticles.forEach((a, i) => console.log("  [" + (i + 1) + "] " + (a.title || a.url).slice(0, 70)));

  // ─ Bước 3: Enrich từng bài ─
  console.log("\n🔍  Enriching metadata...");
  const enriched = [];
  for (const article of cmcArticles) {
    try   { enriched.push(await enrichArticle(article)); }
    catch (e) { console.warn("  ⚠️  Bỏ qua:", e.message); enriched.push(article); }
  }

  // ─ Bước 4: Chọn ảnh đại diện (bài đầu tiên có ảnh) ─
  const representativeArticle = enriched.find(a => a.imageUrl) || enriched[0];
  console.log("\n🖼️   Ảnh đại diện:", representativeArticle.imageUrl || "(không có)");

  // ─ Bước 5: Groq tổng hợp ─
  const generated = await generateRoundupWithGroq(enriched);

  // ─ Bước 6: Tạo post ─
  const slug = slugify(generated.title || "diem-tin-crypto-top-" + TOP_N + "-" + Date.now());
  const tags = (generated.tags && generated.tags.length) ? generated.tags : ["bitcoin", "điểm tin", "crypto", "thị trường"];

  let imageObj = null;
  if (representativeArticle.imageUrl) {
    const altText    = (generated.title || "Top tin crypto").slice(0, 120);
    const cloudResult = await uploadToCloudinary(representativeArticle.imageUrl, slug, altText, tags);
    imageObj = cloudResult || { url: representativeArticle.imageUrl, rawUrl: representativeArticle.imageUrl, alt: altText };
  }

  // Thêm danh sách nguồn vào cuối bài (không dùng link để tối ưu SEO)
  const sourcesList      = enriched.map((a, i) =>
    '<li>[' + (i + 1) + '] ' +
    (a.title || a.sourceName || "RSS").replace(/</g, "&lt;").replace(/>/g, "&gt;") +
    ' — <em>' + (a.sourceName || "RSS") + '</em></li>'
  ).join("\n");
  const contentWithSources = (generated.content || "") +
    "\n<h2>Nguồn tin tham khảo</h2>\n<ol>\n" + sourcesList + "\n</ol>";

  const post = {
    id:               Date.now().toString(),
    title:            generated.title   || "Điểm tin crypto: Top " + TOP_N + " sự kiện",
    summary:          generated.summary || "",
    content:          contentWithSources,
    tags,
    readTime:         generated.readTime || 8,
    image:            imageObj,
    sourceUrl:        enriched[0].url,
    sourceTitle:      enriched.map(a => a.sourceName).filter((v,i,a) => a.indexOf(v)===i).join(" / "),
    articleCount:     enriched.length,
    articlesIncluded: enriched.map(a => ({ title: a.title, url: a.url, source: a.sourceName })),
    publishedAt:      new Date().toISOString(),
    slug,
  };

  data.posts             = data.posts             || [];
  data.publishedUrls     = data.publishedUrls     || [];
  data.publishedBatchKeys = data.publishedBatchKeys || [];

  data.posts.unshift(post);
  enriched.forEach(a => { if (a.url && !data.publishedUrls.includes(a.url)) data.publishedUrls.push(a.url); });
  data.publishedBatchKeys.push(batchKey);
  if (data.publishedBatchKeys.length > 200) data.publishedBatchKeys = data.publishedBatchKeys.slice(-200);

  savePosts(data);

  console.log("\n🎉  Đã đăng:", post.title);
  console.log("📊  Tổng hợp:", post.articleCount, "tin từ", RSS_SOURCES.map(s => s.name).join(", "));
  if (post.image) console.log("🖼️   Thumbnail:", post.image.url);
  console.log("🏷️   Tags:", post.tags.join(", "));
  console.log("=".repeat(60));
}

main().catch(err => {
  console.error("❌  Lỗi nghiêm trọng:", err.message);
  process.exit(1);
});
