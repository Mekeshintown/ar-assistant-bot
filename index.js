"use strict";

const express = require("express");
const TelegramBot = require("node-telegram-bot-api");
const { Client: NotionClient } = require("@notionhq/client");
const OpenAI = require("openai");

// ENV Variablen von Render
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const WEBHOOK_URL = process.env.WEBHOOK_URL; 
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const PORT = process.env.PORT || 3000;

// Notion IDs
const DB_CONFIG = "2e1c841ccef980708df2ecee5f0c2df0";
const DB_STUDIOS = "2e0c841ccef980b49c4aefb4982294f0";
const DB_BIOS = "2e0c841ccef9807e9b73c9666ce4fcb0";

const app = express();
app.use(express.json());

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN);
const notion = new NotionClient({ auth: NOTION_TOKEN });
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

const secretPath = `/telegram/${TELEGRAM_BOT_TOKEN}`;

// Hilfe-Funktion: Liest Texte aus Notion sauber aus
function getPlainText(prop) {
  if (prop?.title) return prop.title[0]?.plain_text || "";
  if (prop?.rich_text) return prop.rich_text[0]?.plain_text || "";
  return "";
}

// Sucht in Notion nach einem Namen
async function getNotionContext(dbId, searchTerm) {
  try {
    const res = await notion.databases.query({
      database_id: dbId,
      filter: { property: "Name", title: { contains: searchTerm } }
    });
    return res.results.map(page => {
      const p = page.properties;
      return JSON.stringify(p);
    }).join("\n");
  } catch (e) { return ""; }
}

// Telegram Nachrichten Handler
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  if (!msg.text || msg.text.startsWith("/")) return;

  try {
    // 1. Kontext aus Notion suchen (Studios & Bios)
    const studioInfo = await getNotionContext(DB_STUDIOS, msg.text);
    const bioInfo = await getNotionContext(DB_BIOS, msg.text);

    // 2. GPT-4o Antwort generieren
    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { 
          role: "system", 
          content: `Du bist ein A&R Assistent. Antworte locker im Music Business Style. 
          Nutze diese Infos falls relevant: Studios: ${studioInfo} Bios: ${bioInfo}` 
        },
        { role: "user", content: msg.text }
      ]
    });

    const answer = completion.choices[0].message.content;
    await bot.sendMessage(chatId, answer);

  } catch (err) {
    console.error("Fehler:", err.message);
    await bot.sendMessage(chatId, "Hatte kurz einen Hänger. Probier's nochmal!");
  }
});

// Webhook Endpunkt für Telegram
app.post(secretPath, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

app.get("/", (req, res) => res.send("A&R Bot läuft!"));

// Server Start
app.listen(PORT, async () => {
  console.log(`Server hört auf Port ${PORT}`);
  await bot.deleteWebHook({ drop_pending_updates: true });
  await bot.setWebHook(`${WEBHOOK_URL}${secretPath}`);
  console.log("Webhook erfolgreich gesetzt.");
});
