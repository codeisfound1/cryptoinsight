// scripts/generate.js
// Chạy bởi GitHub Actions: crawl CoinMarketCap Bitcoin News → Groq AI → lưu docs/posts.json
// Nguồn: https://coinmarketcap.com/currencies/bitcoin/#News

"use strict";

const https = require("https");
const http  = require("http");
const fs    = require("fs");
const path  = require("path");
const crypto = require("crypto");

// ─── CONFIG ────────────────────────────────────────────────────────────────
// Nguồn tin tức chính: CoinMarketCap Bitcoin News
const SOURCE_URLS = [
  "https://coinmarketcap.com/currencies/bitcoin/#News",
  "https://coinmarketcap.com/headlines/news/",
  "https://coinmarketcap.com/currencies/ethereum/#News",
];

const GROQ_URL    = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL  = "llama-3.3-70b-versatile";
const POSTS_FILE   = path.join(__dirname, "../docs/posts.json");
const SITEMAP_FILE = path.join(__dirname, "../docs/sitemap.xml");
const ROBOTS_FILE  = path.join(__dirname, "../docs/robots.txt");
const SITE_URL     = process.env.SITE_URL || "https://your-username.github.io/cryptoinsight";
const GROQ_KEY    = process.env.GROQ_API_KEY;
const FORCE       = process.env.FORCE === "true";

// Cloudinary config (tuỳ chọn)
const CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME;
const CLOUDINARY_API_KEY    = process.env.CLOUDINARY_API_KEY;
const CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET;

if (!GROQ_KEY) {
  console.error("❌ Thiếu GROQ_API_KEY");
  process.exit(1);
}

// ─── HTTP HELPERS ──────────────────────────────────────────────────────────

function fetchUrl(url, redirectCount) {
  redirectCount = redirectCount || 0;
  if (redirectCount > 5) return Promise.reject(new Error("Too many redirects"));

  return new Promise((resolve, reject) => {
    const client = url.startsWith("https") ? https : http;
    const req = client.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9,vi;q=0.8",
        "Accept-Charset": "UTF-8",
        "Cache-Control": "no-cache",
        "Referer": "https://www.google.com/",
      },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const next = res.headers.location.startsWith("http")
          ? res.headers.location
          : new URL(res.headers.location, url).href;
        return fetchUrl(next, redirectCount + 1).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end",  () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
    req.on("error", reject);
    req.setTimeout(25000, () => { req.destroy(); reject(new Error("Timeout: " + url)); });
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

// ─── CLOUDINARY UPLOAD ─────────────────────────────────────────────────────

async function uploadToCloudinary(imageUrl, slug, altText, tags) {
  if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
    console.log("⚠️  Cloudinary chưa cấu hình — dùng URL gốc");
    return null;
  }
  try {
    console.log("☁️  Upload ảnh lên Cloudinary:", imageUrl);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const tagsStr   = (tags || []).slice(0, 5).join(",") || "crypto,bitcoin";
    const contextStr = "alt=" + altText.replace(/[|=]/g, " ") + "|caption=" + altText.replace(/[|=]/g, " ");
    const signParams = [
      "context=" + contextStr,
      "folder=cryptoinsight/posts",
      "overwrite=true",
      "public_id=" + slug,
      "tags=" + tagsStr,
      "timestamp=" + timestamp,
    ].join("&");
    const signature = crypto.createHash("sha1")
      .update(signParams + CLOUDINARY_API_SECRET)
      .digest("hex");

    const formData = [
      ["file",      imageUrl],
      ["public_id", slug],
      ["folder",    "cryptoinsight/posts"],
      ["overwrite", "true"],
      ["tags",      tagsStr],
      ["context",   contextStr],
      ["timestamp", timestamp],
      ["api_key",   CLOUDINARY_API_KEY],
      ["signature", signature],
    ];
    const boundary = "----CryptoInsight" + Date.now();
    const bodyStr  = formData.map(([k, v]) =>
      "--" + boundary + "\r\nContent-Disposition: form-data; name=\"" + k + "\"\r\n\r\n" + v + "\r\n"
    ).join("") + "--" + boundary + "--\r\n";
    const bodyBuf  = Buffer.from(bodyStr, "utf8");

    const result = await new Promise((resolve, reject) => {
      const options = {
        hostname: "api.cloudinary.com",
        path:     "/v1_1/" + CLOUDINARY_CLOUD_NAME + "/image/upload",
        method:   "POST",
        headers:  { "Content-Type": "multipart/form-data; boundary=" + boundary, "Content-Length": bodyBuf.length },
      };
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
  } catch (err) {
    console.warn("⚠️  Cloudinary thất bại:", err.message, "→ dùng URL gốc");
    return null;
  }
}

// ─── POSTS STORAGE ─────────────────────────────────────────────────────────

function loadPosts() {
  try {
    if (fs.existsSync(POSTS_FILE)) return JSON.parse(fs.readFileSync(POSTS_FILE, "utf8"));
  } catch (e) { console.warn("Không đọc được posts.json:", e.message); }
  return { posts: [], publishedUrls: [] };
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
    { loc: base + "/", priority: "1.0", changefreq: "daily", lastmod: today },
    ...posts.map(p => ({
      loc:        base + "/#" + (p.slug || p.id),
      priority:   "0.8",
      changefreq: "monthly",
      lastmod:    p.publishedAt ? p.publishedAt.slice(0, 10) : today,
    })),
  ];
  const esc = s => String(s || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"',
    '        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">',
    ...pages.map((u, i) => {
      const post = posts[i - 1];
      const imgTag = post && post.image && post.image.url
        ? "\n    <image:image>\n" +
          "      <image:loc>" + post.image.url + "</image:loc>\n" +
          "      <image:title>" + esc(post.title) + "</image:title>\n" +
          "      <image:caption>" + esc(post.image.alt || post.title) + "</image:caption>\n" +
          "    </image:image>" : "";
      return "  <url>\n    <loc>" + u.loc + "</loc>\n    <lastmod>" + u.lastmod +
             "</lastmod>\n    <changefreq>" + u.changefreq + "</changefreq>\n    <priority>" +
             u.priority + "</priority>" + imgTag + "\n  </url>";
    }),
    "</urlset>",
  ].join("\n");
  fs.writeFileSync(SITEMAP_FILE, xml, "utf8");
  console.log("🗺️   Sitemap: " + pages.length + " URLs → docs/sitemap.xml");
}

function saveRobots() {
  const base = SITE_URL.replace(/\/$/, "");
  fs.writeFileSync(ROBOTS_FILE, "User-agent: *\nAllow: /\n\nSitemap: " + base + "/sitemap.xml\n", "utf8");
  console.log("🤖  robots.txt updated");
}

// ─── CRAWL COINMARKETCAP ───────────────────────────────────────────────────

/**
 * CoinMarketCap render nặng bằng JS, nên ta dùng chiến lược:
 * 1) Thử scrape trang Bitcoin news trực tiếp để lấy link tin tức bên ngoài
 * 2) Nếu không được, fetch các trang tin tức crypto uy tín khác
 * 3) Fallback: dùng danh sách RSS/API công khai
 */
async function crawlArticleList() {
  console.log("🔍  Đang tìm bài viết từ CoinMarketCap & các nguồn crypto...");

  const allLinks = new Set();

  // ─ Thử 1: Lấy links từ CMC Bitcoin news page ─
  try {
    const cmcHtml = await fetchUrl("https://coinmarketcap.com/currencies/bitcoin/");
    const linkRe  = /href="(https?:\/\/(?!coinmarketcap\.com)[^"]{20,})"[^>]*>[^<]{10,}/g;
    let m;
    while ((m = linkRe.exec(cmcHtml)) !== null) {
      const url = m[1];
      if (isNewsUrl(url)) allLinks.add(url);
      if (allLinks.size >= 15) break;
    }
    console.log("   CMC Bitcoin page → " + allLinks.size + " links");
  } catch (e) {
    console.warn("   CMC Bitcoin page thất bại:", e.message);
  }

  // ─ Thử 2: CoinDesk RSS ─
  if (allLinks.size < 5) {
    try {
      const rss = await fetchUrl("https://www.coindesk.com/arc/outboundfeeds/rss/");
      const itemRe = /<link>([^<]+)<\/link>/g;
      let m;
      while ((m = itemRe.exec(rss)) !== null) {
        const url = m[1].trim();
        if (url.startsWith("http") && isNewsUrl(url)) allLinks.add(url);
        if (allLinks.size >= 15) break;
      }
      console.log("   CoinDesk RSS → " + allLinks.size + " links tổng");
    } catch (e) {
      console.warn("   CoinDesk RSS thất bại:", e.message);
    }
  }

  // ─ Thử 3: Decrypt.co RSS ─
  if (allLinks.size < 5) {
    try {
      const rss = await fetchUrl("https://decrypt.co/feed");
      const itemRe = /<link>([^<]+)<\/link>/g;
      let m;
      while ((m = itemRe.exec(rss)) !== null) {
        const url = m[1].trim();
        if (url.startsWith("http") && isNewsUrl(url)) allLinks.add(url);
        if (allLinks.size >= 15) break;
      }
      console.log("   Decrypt RSS → " + allLinks.size + " links tổng");
    } catch (e) {
      console.warn("   Decrypt RSS thất bại:", e.message);
    }
  }

  // ─ Thử 4: Cointelegraph RSS ─
  if (allLinks.size < 5) {
    try {
      const rss = await fetchUrl("https://cointelegraph.com/rss");
      const itemRe = /<link>([^<]+)<\/link>/g;
      let m;
      while ((m = itemRe.exec(rss)) !== null) {
        const url = m[1].trim();
        if (url.startsWith("http") && isNewsUrl(url)) allLinks.add(url);
        if (allLinks.size >= 15) break;
      }
      console.log("   Cointelegraph RSS → " + allLinks.size + " links tổng");
    } catch (e) {
      console.warn("   Cointelegraph RSS thất bại:", e.message);
    }
  }

  const result = Array.from(allLinks).slice(0, 12);
  console.log("📋  Tổng cộng tìm thấy " + result.length + " bài để xử lý");
  return result;
}

function isNewsUrl(url) {
  // Lọc các URL trông giống bài viết tin tức
  const bad = ["/tag/", "/author/", "/category/", "/page/", "twitter.com", "facebook.com",
               "youtube.com", "t.me", "discord", ".jpg", ".png", ".pdf", "mailto:"];
  if (bad.some(b => url.includes(b))) return false;
  // URL phải có path dài (slug bài viết)
  try {
    const u = new URL(url);
    return u.pathname.length > 10;
  } catch(_) { return false; }
}

// ─── EXTRACT IMAGE ─────────────────────────────────────────────────────────

function extractImage(html, baseUrl) {
  // og:image
  let m = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
           || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
  if (m && m[1] && m[1].startsWith("http")) return m[1];

  // twitter:image
  m = html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i)
    || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i);
  if (m && m[1] && m[1].startsWith("http")) return m[1];

  // First large img in body
  const bodyMatch = html.match(/<(?:article|main|div[^>]+class=["'][^"']*(?:content|body|post|article)[^"']*["'])[^>]*>([\s\S]{0,8000})/i);
  const area = bodyMatch ? bodyMatch[1] : html;
  const imgRe = /<img[^>]+src=["']([^"']{10,})["'][^>]*/gi;
  while ((m = imgRe.exec(area)) !== null) {
    const tag = m[0];
    const w = tag.match(/width=["'](\d+)["']/i);
    const h = tag.match(/height=["'](\d+)["']/i);
    if (w && parseInt(w[1]) < 200) continue;
    if (h && parseInt(h[1]) < 150) continue;
    const src = m[1];
    if (src.startsWith("data:")) continue;
    if (src.startsWith("http")) return src;
    if (src.startsWith("/")) {
      try { return new URL(src, baseUrl).href; } catch(_) {}
    }
  }
  return null;
}

// ─── CRAWL ARTICLE CONTENT ─────────────────────────────────────────────────

async function crawlArticleContent(url) {
  console.log("📄  Đang đọc:", url);
  const html = await fetchUrl(url);

  // Title
  let title = "";
  const h1 = html.match(/<h1[^>]*>\s*([^<]+)\s*<\/h1>/i);
  if (h1) title = decodeHtmlEntities(h1[1].trim());
  if (!title) {
    const t = html.match(/<title>([^<]+)<\/title>/i);
    if (t) title = decodeHtmlEntities(t[1].replace(/\s*[-|].*$/, "").trim());
  }

  // Description
  let description = "";
  const dm = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)
           || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i);
  if (dm) description = decodeHtmlEntities(dm[1]);

  // OG description fallback
  if (!description) {
    const ogd = html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i);
    if (ogd) description = decodeHtmlEntities(ogd[1]);
  }

  // Image
  const imageUrl = extractImage(html, url);
  console.log(imageUrl ? "🖼️   Ảnh: " + imageUrl.slice(0, 80) : "⚠️   Không tìm thấy ảnh, dùng fallback");

  // Clean text content
  const content = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<header[\s\S]*?<\/header>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "")
    .replace(/<aside[\s\S]*?<\/aside>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 4000);

  // Detect coin mentions for better tagging
  const text = (title + " " + description + " " + content).toLowerCase();
  const coinMentions = [];
  if (text.includes("bitcoin") || text.includes(" btc")) coinMentions.push("bitcoin");
  if (text.includes("ethereum") || text.includes(" eth")) coinMentions.push("ethereum");
  if (text.includes("solana") || text.includes(" sol")) coinMentions.push("solana");
  if (text.includes("defi"))   coinMentions.push("defi");
  if (text.includes("nft"))    coinMentions.push("nft");
  if (text.includes("altcoin")) coinMentions.push("altcoin");

  // Detect source name
  let sourceTitle = "Crypto News";
  try {
    const domain = new URL(url).hostname.replace("www.", "");
    if (domain.includes("coindesk"))       sourceTitle = "CoinDesk";
    else if (domain.includes("cointelegraph")) sourceTitle = "Cointelegraph";
    else if (domain.includes("decrypt"))   sourceTitle = "Decrypt";
    else if (domain.includes("coinmarketcap")) sourceTitle = "CoinMarketCap";
    else if (domain.includes("bitcoin"))   sourceTitle = "Bitcoin Magazine";
    else sourceTitle = domain;
  } catch(_) {}

  return {
    url,
    title:       title || "Tin tức tiền điện tử",
    description: description || "",
    imageUrl,
    content:     decodeHtmlEntities(content),
    coinMentions,
    sourceTitle,
  };
}

function decodeHtmlEntities(str) {
  return String(str || "")
    .replace(/&amp;/g,  "&")
    .replace(/&lt;/g,   "<")
    .replace(/&gt;/g,   ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g,  "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g,    (_, n) => String.fromCodePoint(parseInt(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)));
}

// ─── GROQ AI ───────────────────────────────────────────────────────────────

async function generateWithGroq(article) {
  console.log("🤖  Đang tạo bài phân tích với Groq:", article.title);

  const systemPrompt =
    "Bạn là chuyên gia phân tích thị trường tiền điện tử (cryptocurrency) tại Việt Nam. " +
    "Bạn am hiểu sâu về Bitcoin, Ethereum, DeFi, NFT, và thị trường crypto toàn cầu. " +
    "Nhiệm vụ: nhận thông tin bài viết gốc tiếng Anh và TRẢ VỀ DUY NHẤT một JSON object hợp lệ, " +
    "mã hóa UTF-8. Không có text nào khác, không markdown, không code block, không giải thích.";

  const userPrompt =
    "Dựa trên bài viết crypto tiếng Anh dưới đây, hãy viết một bài phân tích chuyên sâu bằng tiếng Việt có dấu đầy đủ, " +
    "sau đó trả về JSON.\n\n" +
    "NGUỒN GỐC:\n" +
    "Tiêu đề: " + article.title + "\n" +
    "Mô tả: " + article.description + "\n" +
    "Nội dung: " + article.content.slice(0, 3000) + "\n\n" +
    "YÊU CẦU:\n" +
    "- Toàn bộ nội dung PHẢI bằng tiếng Việt có dấu đầy đủ\n" +
    "- Dịch và viết lại hoàn toàn, không sao chép tiếng Anh\n" +
    "- Phân tích chuyên sâu: tác động thị trường, ý nghĩa với nhà đầu tư Việt Nam\n" +
    "- Giải thích thuật ngữ kỹ thuật bằng tiếng Việt dễ hiểu\n" +
    "- Thêm góc nhìn thực tiễn về thị trường crypto Việt Nam\n" +
    "- Độ dài 600-800 từ\n" +
    "- Tags phải bằng tiếng Việt hoặc tên coin (bitcoin, ethereum, v.v.)\n\n" +
    "CHỈ trả về JSON object dưới đây, KHÔNG có gì khác:\n" +
    '{"title":"Tiêu đề bài phân tích tiếng Việt",' +
    '"summary":"Tóm tắt 2 câu tiếng Việt nêu bật điểm quan trọng nhất",' +
    '"tags":["bitcoin","thị trường","phân tích"],' +
    '"content":"<p>Đoạn mở đầu...</p><h2>Diễn biến thị trường</h2><p>Nội dung...</p>' +
    '<h2>Tác động và phân tích</h2><p>Nội dung...</p>' +
    '<h2>Khuyến nghị cho nhà đầu tư</h2><p>Lời khuyên...</p>",' +
    '"readTime":6}';

  const res = await postJson(
    GROQ_URL,
    {
      model: GROQ_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user",   content: userPrompt   },
      ],
      temperature: 0.45,
      max_tokens:  2500,
    },
    { "Authorization": "Bearer " + GROQ_KEY }
  );

  if (res.error) throw new Error("Groq error: " + JSON.stringify(res.error));

  const raw  = ((res.choices || [])[0] || {}).message || {};
  const text = (raw.content || "").trim();
  console.log("📥  Groq raw (300c):", text.slice(0, 300));
  return parseJson(text, article);
}

function parseJson(text, article) {
  // Direct parse
  try { const p = JSON.parse(text); if (p && p.title) return p; } catch(_) {}
  // Strip code fences
  const s = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  try { const p = JSON.parse(s); if (p && p.title) return p; } catch(_) {}
  // Bracket extraction
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
    if (end !== -1) {
      try { const p = JSON.parse(text.slice(start, end + 1)); if (p && p.title) return p; } catch(_) {}
    }
  }
  // Regex fallback
  console.warn("⚠️   Dùng regex fallback");
  const field = (k) => {
    const m = text.match(new RegExp('"' + k + '"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"', "i"));
    return m ? m[1].replace(/\\n/g, "\n").replace(/\\"/g, '"') : null;
  };
  const arr = (k) => {
    const m = text.match(new RegExp('"' + k + '"\\s*:\\s*\\[([^\\]]+)\\]', "i"));
    return m ? (m[1].match(/"([^"]+)"/g) || []).map(x => x.replace(/"/g, "")) : [];
  };
  const num = (k) => { const m = text.match(new RegExp('"' + k + '"\\s*:\\s*(\\d+)', "i")); return m ? parseInt(m[1]) : 6; };
  const title = field("title") || article.title;
  if (!title) throw new Error("Không parse được Groq response:\n" + text.slice(0, 400));
  return {
    title,
    summary:  field("summary")  || article.description || "",
    content:  field("content")  || "<p>" + (article.content || "").slice(0, 600) + "</p>",
    tags:     arr("tags").length ? arr("tags") : (article.coinMentions.length ? article.coinMentions : ["crypto"]),
    readTime: num("readTime"),
  };
}

// ─── SLUGIFY ───────────────────────────────────────────────────────────────

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

// ─── MAIN ──────────────────────────────────────────────────────────────────

async function main() {
  console.log("=".repeat(56));
  console.log("🚀  Crypto Insight Generator bắt đầu -", new Date().toISOString());
  console.log("📰  Nguồn: CoinMarketCap Bitcoin News & các RSS crypto");
  console.log("=".repeat(56));

  const data = loadPosts();
  console.log("📚  Hiện có:", data.posts.length, "bài, đã dùng:", (data.publishedUrls || []).length, "URL");

  const urls    = await crawlArticleList();
  const newUrls = FORCE
    ? urls
    : urls.filter(u => !(data.publishedUrls || []).includes(u));

  if (!newUrls.length) {
    console.log("ℹ️   Không có bài mới. Kết thúc.");
    return;
  }

  console.log("✨  Xử lý bài chưa đăng:", newUrls[0]);
  const article = await crawlArticleContent(newUrls[0]);

  if (!article.content || article.content.length < 80) {
    console.warn("⚠️   Nội dung quá ngắn, bỏ qua:", article.url);
    data.publishedUrls = (data.publishedUrls || []).concat([article.url]);
    savePosts(data);
    return;
  }

  const generated = await generateWithGroq(article);

  const slug = slugify(generated.title || article.title);
  const tags  = (generated.tags && generated.tags.length) ? generated.tags : (article.coinMentions.length ? article.coinMentions : ["crypto"]);

  // Upload ảnh lên Cloudinary (tuỳ chọn)
  let imageObj = null;
  if (article.imageUrl) {
    const altText    = (generated.title || article.title).slice(0, 120);
    const cloudResult = await uploadToCloudinary(article.imageUrl, slug, altText, tags);
    imageObj = cloudResult || { url: article.imageUrl, rawUrl: article.imageUrl, alt: altText };
  }

  const post = {
    id:          Date.now().toString(),
    title:       generated.title   || article.title,
    summary:     generated.summary || "",
    content:     generated.content || "",
    tags,
    readTime:    generated.readTime || 6,
    image:       imageObj,
    sourceUrl:   article.url,
    sourceTitle: article.sourceTitle || "CoinMarketCap",
    publishedAt: new Date().toISOString(),
    slug,
  };

  data.posts = data.posts || [];
  data.publishedUrls = data.publishedUrls || [];
  data.posts.unshift(post);
  data.publishedUrls.push(article.url);
  savePosts(data);

  console.log("🎉  Đã đăng:", post.title);
  if (post.image) console.log("🖼️   Thumbnail:", post.image.url);
  console.log("🏷️   Tags:", post.tags.join(", "));
  console.log("=".repeat(56));
}

main().catch(err => {
  console.error("❌  Lỗi nghiêm trọng:", err.message);
  process.exit(1);
});
