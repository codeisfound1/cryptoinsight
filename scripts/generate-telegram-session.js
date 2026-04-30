#!/usr/bin/env node
// scripts/generate-telegram-session.js
//
// Chạy script này MỘT LẦN trên máy tính của bạn để tạo TELEGRAM_SESSION string.
// Sau đó lưu chuỗi đó vào GitHub Secret tên "TELEGRAM_SESSION".
//
// Cách dùng:
//   cd scripts
//   npm install
//   TELEGRAM_API_ID=123456 TELEGRAM_API_HASH=abcdef1234567890abcdef node generate-telegram-session.js
//
// Sau khi chạy, bạn sẽ được yêu cầu:
//   1. Nhập số điện thoại Telegram (có +84 ở đầu)
//   2. Nhập mã OTP gửi về Telegram
//   3. Script in ra SESSION string → copy vào GitHub Secret TELEGRAM_SESSION

"use strict";

const readline = require("readline");

async function main() {
  const apiId   = process.env.TELEGRAM_API_ID   ? parseInt(process.env.TELEGRAM_API_ID, 10) : null;
  const apiHash = process.env.TELEGRAM_API_HASH  || null;

  if (!apiId || !apiHash) {
    console.error("❌ Thiếu TELEGRAM_API_ID hoặc TELEGRAM_API_HASH.");
    console.error("   Cách dùng: TELEGRAM_API_ID=xxx TELEGRAM_API_HASH=yyy node generate-telegram-session.js");
    process.exit(1);
  }

  const { TelegramClient } = require("telegram");
  const { StringSession }  = require("telegram/sessions");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise(res => rl.question(q, res));

  console.log("=".repeat(60));
  console.log("📱  Telegram Session Generator cho CryptoInsight");
  console.log("=".repeat(60));
  console.log("Bạn sẽ cần đăng nhập Telegram MỘT LẦN để lấy session string.");
  console.log("Session này sẽ được lưu làm GitHub Secret để CI tự động dùng.\n");

  const session = new StringSession(""); // Session trống — sẽ được tạo mới
  const client  = new TelegramClient(session, apiId, apiHash, {
    connectionRetries: 3,
  });

  await client.start({
    phoneNumber: async () => {
      return await ask("📞 Nhập số điện thoại Telegram (VD: +84912345678): ");
    },
    password: async () => {
      return await ask("🔐 Nhập mật khẩu 2FA (nếu có, bỏ trống nếu không): ");
    },
    phoneCode: async () => {
      return await ask("📨 Nhập mã OTP từ Telegram: ");
    },
    onError: (err) => {
      console.error("❌ Lỗi xác thực:", err.message);
    },
  });

  const sessionString = client.session.save();

  console.log("\n" + "=".repeat(60));
  console.log("✅  Đăng nhập thành công!\n");
  console.log("📋  SESSION STRING (copy toàn bộ dòng dưới vào GitHub Secret):");
  console.log("=".repeat(60));
  console.log(sessionString);
  console.log("=".repeat(60));
  console.log("\n📌  Cách lưu vào GitHub Secret:");
  console.log("   1. Vào repo GitHub → Settings → Secrets and variables → Actions");
  console.log("   2. Nhấn 'New repository secret'");
  console.log("   3. Name: TELEGRAM_SESSION");
  console.log("   4. Secret: paste chuỗi ở trên");
  console.log("   5. Nhấn 'Add secret'\n");
  console.log("⚠️  Giữ bí mật chuỗi này — ai có chuỗi này có thể đọc tài khoản Telegram của bạn!\n");

  await client.disconnect();
  rl.close();
}

main().catch(err => {
  console.error("❌ Lỗi:", err.message);
  process.exit(1);
});
