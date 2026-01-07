const http = require("http");
const TelegramBot = require("node-telegram-bot-api");
const OpenAI = require("openai");

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const PORT = process.env.PORT || 3000;

if (!TELEGRAM_BOT_TOKEN) throw new Error("Missing TELEGRAM_BOT_TOKEN");
if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");
if (!WEBHOOK_URL) throw new Error("Missing WEBHOOK_URL");

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN); // ✅ Webhook (kein polling)
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// Ein “geheimer” Pfad, damit nicht jeder dein Webhook-Endpoint raten kann
const secretPath = `/telegram/${TELEGRAM_BOT_TOKEN}`;

// HTTP Server für Render + Telegram Webhook
const server = http.createServer((req, res) => {
  // Telegram schickt Updates als POST an unseren secretPath
  if (req.method === "POST" && req.url === secretPath) {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const update = JSON.parse(body);
        bot.processUpdate(update);
      } catch (e) {
        console.error("Bad webhook payload:", e);
      }
      res.writeHead(200);
      res.end("OK");
    });
    return;
  }

  // Healthcheck Endpoint für Render
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("OK");
});

server.listen(PORT, async () => {
  console.log("HTTP server listening on", PORT);

  // Webhook setzen/überschreiben (kickt Polling komplett raus)
  const hookUrl = `${WEBHOOK_URL}${secretPath}`;
  await bot.setWebHook(hookUrl);
  console.log("Webhook set to", hookUrl);
});

// --- Bot Logik ---
bot.onText(/^\/start$/, (msg) => {
  bot.sendMessage(msg.chat.id, "Hallo! Wie kann ich dir als persönlicher A&R-Assistent heute helfen?");
});

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  if (!text || text.startsWith("/")) return;

  try {
    const resp = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: [
        { role: "system", content: "Du bist ein persönlicher A&R-Assistent." },
        { role: "user", content: text },
      ],
    });

    const answer = (resp.output_text || "").trim() || "Keine Antwort erhalten.";
    await bot.sendMessage(chatId, answer);
  } catch (e) {
    console.error("OpenAI error:", e?.response?.data || e);
    await bot.sendMessage(chatId, "Fehler. Check Render Logs.");
  }
});
