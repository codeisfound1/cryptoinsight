"use strict";

const { TelegramClient } = require("telegram");
const { StringSession }  = require("telegram/sessions");

const apiId   = parseInt(process.env.TELEGRAM_API_ID, 10);
const apiHash = process.env.TELEGRAM_API_HASH;
const session = process.env.TELEGRAM_SESSION;

if (!apiId || !apiHash || !session) {
  console.error("❌ Thiếu TELEGRAM_API_ID, TELEGRAM_API_HASH hoặc TELEGRAM_SESSION");
  process.exit(1);
}

(async () => {
  const client = new TelegramClient(new StringSession(session), apiId, apiHash, {
    connectionRetries: 3,
  });

  try {
    await client.connect();
    console.log("✅ Kết nối thành công!\n");

    const entity   = await client.getEntity("@WatcherGuru");
    const messages = await client.getMessages(entity, { limit: 3 });

    console.log(`📲 3 tin mới nhất từ @WatcherGuru:\n${"─".repeat(50)}`);
    messages.forEach((msg, i) => {
      const date = new Date(msg.date * 1000).toLocaleString("vi-VN");
      const text = (msg.message || "(không có text)").slice(0, 200);
      console.log(`\n[${i + 1}] 🕐 ${date}\n${text}`);
    });

    console.log("\n✅ Test PASSED — Session hoạt động tốt!");
  } catch (e) {
    console.error("❌ Test FAILED:", e.message);
    process.exit(1);
  } finally {
    await client.disconnect();
  }
})();
