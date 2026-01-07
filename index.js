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

const DB_CONFIG = "2e1c841ccef980708df2ecee5f0c2df0";
const DB_STUDIOS = "2e0c841ccef980b49c4aefb4982294f0";
const DB_BIOS = "2e1c841ccef9807e9b73c9666ce4fcb0";
const DB_PUBLISHING = "2e0c841ccef980579177d2996f1e92f4";

const app = express();
app.use(express.json());

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN);
const notion = new NotionClient({ auth: NOTION_TOKEN });
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

const secretPath = `/telegram/${TELEGRAM_BOT_TOKEN}`;

function parseProperties(properties) {
  let data = {};
  for (const key in properties) {
    const p = properties[key];
    let val = "";
    if (p.title) val = p.title[0]?.plain_text || "";
    else if (p.rich_text) val = p.rich_text[0]?.plain_text || "";
    else if (p.url) val = p.url || "";
    else if (p.select) val = p.select.name || "";
    data[key] = val;
  }
  return data;
}

async function fetchFullDatabase(databaseId) {
  try {
    const response = await notion.databases.query({ database_id: databaseId });
    return response.results.map(page => parseProperties(page.properties));
  } catch (e) { return []; }
}

bot.on("message", async (msg) => {
  if (!msg.text || msg.text.startsWith("/")) return;

  try {
    const [config, studios, bios, publishing] = await Promise.all([
      fetchFullDatabase(DB_CONFIG),
      fetchFullDatabase(DB_STUDIOS),
      fetchFullDatabase(DB_BIOS),
      fetchFullDatabase(DB_PUBLISHING)
    ]);

    const systemPrompt = `
      Du bist der A&R Assistent der L'Agentur. 
      DEIN TONFALL: Sachlich, professionell und direkt. Vermeide Jugendsprache oder übertrieben lockere Sprüche.
      
      DEIN WISSEN:
      - Studios: ${JSON.stringify(studios)}
      - Artist Bios: ${JSON.stringify(bios)}
      - Publishing/IPI: ${JSON.stringify(publishing)}
      - Config: ${JSON.stringify(config)}

      AUFGABE:
      - Beantworte Fragen basierend auf den Notion-Daten.
      - Wenn Infos fehlen, nenne dies sachlich mit [INFO FEHLT].
      - Erstelle professionelle Session-Zusammenfassungen oder Infos.
    `;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "system", content: systemPrompt }, { role: "user", content: msg.text }]
    });

    await bot.sendMessage(msg.chat.id, completion.choices[0].message.content, { parse_mode: "Markdown" });
  } catch (err) {
    await bot.sendMessage(msg.chat.id, "Ein technischer Fehler ist aufgetreten.");
  }
});

app.post(secretPath, (req, res) => { bot.processUpdate(req.body); res.sendStatus(200); });
app.get("/", (req, res) => res.send("Bot Online"));

app.listen(PORT, async () => {
  await bot.deleteWebHook({ drop_pending_updates: true });
  await bot.setWebHook(`${WEBHOOK_URL}${secretPath}`);
  console.log("Bot einsatzbereit.");
});
