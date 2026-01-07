const TelegramBot = require("node-telegram-bot-api");
const OpenAI = require("openai");
const http = require("http");

const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("OK");
}).listen(PORT, () => {
  console.log("HTTP server listening on", PORT);
});

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!TELEGRAM_BOT_TOKEN) throw new Error("Missing TELEGRAM_BOT_TOKEN");
if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

bot.onText(/^\/start$/, (msg) => {
  bot.sendMessage(msg.chat.id, "A&R Assistant ist online. Schreib mir einfach.");
});

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  if (!text || text.startsWith("/")) return;

  try {
    await bot.sendChatAction(chatId, "typing");

    const resp = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: [
        { role: "system", content: "Du bist ein persönlicher A&R-Assistent." },
        { role: "user", content: text }
      ]
    });

    const answer = (resp.output_text || "").trim() || "Keine Antwort erhalten.";
    await bot.sendMessage(chatId, answer);
  } catch (e) {
    console.error(e);
    await bot.sendMessage(chatId, "Fehler. Check Render Logs.");
  }
});
