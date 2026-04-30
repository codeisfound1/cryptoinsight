"use strict";
 
const { TelegramClient }    = require("telegram");
const { StringSession }     = require("telegram/sessions");
const { ConnectionTCPFull } = require("telegram/network/connection/TCPFull");
 
const apiId   = parseInt(process.env.TELEGRAM_API_ID, 10);
const apiHash = process.env.TELEGRAM_API_HASH;
const session = process.env.TELEGRAM_SESSION;
 
if (!apiId || !apiHash || !session) {
  console.error("❌ Thiếu biến môi trường:");
  if (!apiId)   console.error("   - TELEGRAM_API_ID");
  if (!apiHash) console.error("   - TELEGRAM_API_HASH");
  if (!session) console.error("   - TELEGRAM_SESSION");
  process.exit(1);
}
 
(async () => {
  console.log("=".repeat(50));
  console.log("🧪  Test Telegram Session – @WatcherGuru");
  console.log("=".repeat(50));
  console.log("API_ID  :", apiId);
  console.log("API_HASH:", apiHash.slice(0, 6) + "...");
  console.log("SESSION :", session.slice(0, 10) + "... (length: " + session.length + ")");
  console.log("");
 
  const client = new TelegramClient(
    new StringSession(session),
    apiId,
    apiHash,
    {
      connectionRetries: 5,
      useWSS: false,
      connection: ConnectionTCPFull,
      timeout: 30,
    }
  );
 
  try {
    console.log("🔌  Đang kết nối...");
    await client.connect();
    console.log("✅  Kết nối thành công!\n");
 
    console.log("📡  Đang lấy entity @WatcherGuru...");
    const entity = await client.getEntity("@WatcherGuru");
    console.log("✅  Kênh:", entity.title, "| ID:", entity.id.toString());
    console.log("   Subscribers:", entity.participantsCount || "N/A");
    console.log("");
 
    console.log("📨  Lấy 3 tin mới nhất...");
    const messages = await client.getMessages(entity, { limit: 3 });
    console.log("─".repeat(50));
 
    messages.forEach((msg, i) => {
      const date = new Date(msg.date * 1000).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });
      const text = (msg.message || "(không có text)").trim();
      const urlMatch = text.match(/https?:\/\/[^\s]+/);
      console.log(`\n[${i + 1}] 🕐 ${date}`);
      console.log("    " + text.slice(0, 200).replace(/\n/g, "\n    "));
      if (urlMatch) console.log("    🔗 URL:", urlMatch[0]);
    });
 
    console.log("\n" + "=".repeat(50));
    console.log("✅  Test PASSED — Session hoạt động tốt!");
    console.log("=".repeat(50));
 
  } catch (e) {
    console.error("\n❌  Test FAILED:", e.message);
    process.exit(1);
  } finally {
    await client.disconnect();
  }
})();
 
