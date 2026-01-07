"use strict";

const express = require("express");
const TelegramBot = require("node-telegram-bot-api");
const { Client: NotionClient } = require("@notionhq/client");
const OpenAI = require("openai");

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const WEBHOOK_URL = process.env.WEBHOOK_URL; 
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const PORT = process.env.PORT || 3000;

// DEINE STRUKTUR: Notion DB IDs
const DB_CONFIG = "2e1c841ccef980708df2ecee5f0c2df0";
const DB_STUDIOS = "2e0c841ccef980b49c4aefb4982294f0";
const DB_BIOS = "2e0c841ccef9807e9b73c9666ce4fcb0";
// Falls du die Publishing/IPI ID hast, hier eintragen (Platzhalter unten):
const DB_PUBLISHING = "DEINE_IPI_DATABASE_ID_HIER_EINFÜGEN"; 

const app = express();
app.use(express.json());

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN);
const notion = new NotionClient({ auth: NOTION_TOKEN });
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

const secretPath = `/telegram/${TELEGRAM_BOT_TOKEN}`;

// HELPER: Extrahiert alle Daten aus einer Notion Zeile
function parseNotionProperties(properties) {
  let data = {};
  for (const key in properties) {
    const prop = properties[key];
    if (prop.title) data[key] = prop.title[0]?.plain_text || "";
    else if (prop.rich_text) data[key] = prop.rich_text[0]?.plain_text || "";
    else if (prop.url) data[key] = prop.url || "";
    else if (prop.select) data[key] = prop.select.name || "";
    else if (prop.multi_select) data[key] = prop.multi_select.map(s => s.name).join(", ");
  }
  return data;
}

// ZENTRALE FUNKTION: Holt alle Daten aus einer DB
async function fetchFullDatabase(databaseId) {
  try {
    if (!databaseId || databaseId.includes("HIER")) return [];
    const response = await notion.databases.query({ database_id: databaseId });
    return response.results.map(page => parseNotionProperties(page.properties));
  } catch (e) {
    console.error("Fehler beim Laden der DB:", databaseId, e.message);
    return [];
  }
}

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const userText = msg.text;
  if (!userText || userText.startsWith("/")) return;

  try {
    // 1. SYSTEM-CHECK: Wir laden das Wissen aus Notion
    const [config, studios, bios, publishing] = await Promise.all([
      fetchFullDatabase(DB_CONFIG),
      fetchFullDatabase(DB_STUDIOS),
      fetchFullDatabase(DB_BIOS),
      fetchFullDatabase(DB_PUBLISHING)
    ]);

    // 2. DER PLAN: GPT bekommt das gesamte Wissen als Kontext
    const systemInstruction = `
      Du bist der L'Agentur A&R Bot. Dein Tonfall: Music Industry Casual (professionell, locker, präzise).
      
      DEIN WISSEN (aus Notion):
      - REGELN/CONFIG: ${JSON.stringify(config)}
      - STUDIOS (Adresse, Kontakt, Klingel): ${JSON.stringify(studios)}
      - ARTIST BIOS & LINKS: ${JSON.stringify(bios)}
      - PUBLISHING/IPI: ${JSON.stringify(publishing)}
      
      ANWEISUNG:
      1. Nutze dieses Wissen, um Fragen zu beantworten.
      2. Wenn Infos fehlen, sag: "[INFO FEHLT]".
      3. Erstelle auf Anfrage Email-Vorlagen oder Session-Infos basierend auf diesen Daten.
      4. Antworte immer auf Deutsch (oder Englisch, falls der User Englisch schreibt).
    `;

    // 3. ANTWORT GENERIEREN
    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system", content: systemInstruction },
        { role: "user", content: userText }
      ],
      temperature: 0.7
    });

    await bot.sendMessage(chatId, completion.choices[0].message.content);

  } catch (error) {
    console.error("Fehler im Ablauf:", error);
    await bot.sendMessage(chatId, "Konnte die Notion-Daten gerade nicht sauber verknüpfen.");
  }
});

// WEBHOOK SETUP (Render)
app.post(secretPath, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

app.get("/", (req, res) => res.send("A&R Bot läuft stabil!"));

app.listen(PORT, async () => {
  await bot.deleteWebHook({ drop_pending_updates: true });
  await bot.setWebHook(`${WEBHOOK_URL}${secretPath}`);
  console.log(`Bot ist online auf Port ${PORT}`);
});
