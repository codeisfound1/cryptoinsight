# 🪙 Crypto Insight AI

> Blog phân tích tiền điện tử tự động — crawl từ CoinMarketCap, viết lại bởi AI Groq, deploy trên GitHub Pages.

---

## 🚀 Tính Năng

- **Tự động crawl** tin tức từ [CoinMarketCap Bitcoin News](https://coinmarketcap.com/currencies/bitcoin/#News), CoinDesk, Cointelegraph, Decrypt
- **AI phân tích** bằng Groq (Llama 3.3 70B) — dịch và viết lại thành bài tiếng Việt chuyên sâu
- **Dark theme** cao cấp với ticker giá crypto real-time
- **Price cards** hiển thị BTC, ETH, BNB, SOL, XRP, ADA
- **Quản trị nội tuyến** — sửa/xoá bài, batch commit lên GitHub
- **SEO tốt** — Schema.org, sitemap.xml, robots.txt, og:image
- **Cloudinary** upload ảnh tự động (tuỳ chọn)
- **Deploy miễn phí** trên GitHub Pages

---

## ⚙️ Cài Đặt

### 1. Fork repo này

```bash
git clone https://github.com/YOUR_USERNAME/cryptoinsight
cd cryptoinsight
```

### 2. Tạo GitHub Secrets

Vào **Settings → Secrets and variables → Actions** và thêm:

| Secret | Mô tả | Bắt buộc |
|--------|-------|----------|
| `GROQ_API_KEY` | API key từ [console.groq.com](https://console.groq.com) | ✅ |
| `SITE_URL` | URL GitHub Pages của bạn | ✅ |
| `CLOUDINARY_CLOUD_NAME` | Tên cloud Cloudinary | ❌ |
| `CLOUDINARY_API_KEY` | API key Cloudinary | ❌ |
| `CLOUDINARY_API_SECRET` | API secret Cloudinary | ❌ |

### 3. Bật GitHub Pages

**Settings → Pages → Source → Deploy from branch → main → /docs**

### 4. Chạy thử

Vào **Actions → 🤖 Tạo bài crypto tự động → Run workflow**

---

## 📁 Cấu Trúc

```
cryptoinsight/
├── docs/
│   ├── index.html      # Trang web chính (dark crypto theme)
│   ├── posts.json      # Dữ liệu bài viết
│   ├── sitemap.xml     # SEO sitemap
│   └── robots.txt      # SEO robots
├── scripts/
│   ├── generate.js     # Script crawl + AI generate
│   └── package.json
└── .github/workflows/
    └── generate.yml    # GitHub Actions (chạy 2 lần/ngày)
```

---

## 🕐 Lịch Chạy Tự Động

- **7:00 sáng** (UTC+7) — crawl bài mới buổi sáng
- **19:00 tối** (UTC+7) — crawl bài mới buổi tối

---

## 🔧 Chạy Thủ Công

Từ giao diện web, nhấn **⚡ Đăng bài mới** và điền thông tin GitHub.

Hoặc từ terminal:
```bash
export GROQ_API_KEY=your_key
node scripts/generate.js
```

---

## 📰 Nguồn Dữ Liệu

1. [CoinMarketCap Bitcoin News](https://coinmarketcap.com/currencies/bitcoin/#News) *(nguồn chính)*
2. [CoinDesk RSS](https://www.coindesk.com/arc/outboundfeeds/rss/)
3. [Cointelegraph RSS](https://cointelegraph.com/rss)
4. [Decrypt RSS](https://decrypt.co/feed)

---

## ⚠️ Disclaimer

Nội dung chỉ mang tính tham khảo, không phải lời khuyên đầu tư tài chính.
