"use strict";

const express = require("express");
const TelegramBot = require("node-telegram-bot-api");
const { Client: NotionClient } = require("@notionhq/client");
const OpenAI = require("openai");
const axios = require("axios");
const fs = require("fs");

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const WEBHOOK_URL = process.env.WEBHOOK_URL; 
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const PORT = process.env.PORT || 3000;

const DB_CONFIG = "2e1c841ccef980708df2ecee5f0c2df0";
const DB_STUDIOS = "2e0c841ccef980b49c4aefb4982294f0";
const DB_BIOS = "2e1c841ccef9807e9b73c9666ce4fcb0";
const DB_PUBLISHING = "2e0c841ccef980579177d2996f1e92f4";
const DB_ARTIST_INFOS = "2e2c841ccef98089aad0ed1531e8655b";

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN);
const notion = new NotionClient({ auth: NOTION_TOKEN });
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

const chatContext = new Map();
const app = express();
app.use(express.json());

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

async function universalNotionSearch(query) {
  try {
    const response = await notion.search({
      query: query,
      sort: { direction: "descending", timestamp: "last_edited_time" },
      page_size: 5,
    });
    return response.results.map(res => {
      if (res.properties) return JSON.stringify(parseProperties(res.properties));
      return `Seite: ${res.url}`; 
    }).join("\n");
  } catch (e) { return ""; }
}

async function fetchFullDatabase(id) {
  try {
    const res = await notion.databases.query({ database_id: id });
    return res.results.map(p => parseProperties(p.properties));
  } catch (e) { return []; }
}

async function handleChat(chatId, text) {
  // Lädt alle 5 Datenbanken direkt und strukturiert
  const [config, studios, bios, publishing, artistInfos] = await Promise.all([
    fetchFullDatabase(DB_CONFIG),
    fetchFullDatabase(DB_STUDIOS),
    fetchFullDatabase(DB_BIOS),
    fetchFullDatabase(DB_PUBLISHING),
    fetchFullDatabase(DB_ARTIST_INFOS)
  ]);

  let history = chatContext.get(chatId) || [];
  history.push({ role: "user", content: text });
  if (history.length > 6) history.shift();

  const systemMessage = { 
    role: "system", 
    content: `Du bist der A&R Assistent der L'Agentur. Antworte professionell und sachlich.
    
    REGELN:
    1. Sessionzusammenfassungen & Labelcopys: Fehlende Infos = Zeile weglassen.
    2. Start-Zeit Standard: 12:00 Uhr.
    3. Nutze die Config zur Steuerung: ${JSON.stringify(config)}.
    
    DEIN WISSEN:
    - ARTIST KONTAKTE (Telefon): ${JSON.stringify(artistInfos)}
    - BIOS: ${JSON.stringify(bios)}
    - IPIs & PUBLISHING: ${JSON.stringify(publishing)}
    - STUDIOS: ${JSON.stringify(studios)}` 
  };

  const completion = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [systemMessage, ...history]
  });

  const answer = completion.choices[0].message.content;
  history.push({ role: "assistant", content: answer });
  chatContext.set(chatId, history);
  return answer;
}

bot.on("message", async (msg) => {
  if (msg.voice || !msg.text || msg.text.startsWith("/")) return;
  const answer = await handleChat(msg.chat.id, msg.text);
  await bot.sendMessage(msg.chat.id, answer);
});

bot.on("voice", async (msg) => {
  const chatId = msg.chat.id;
  try {
    const fileLink = await bot.getFileLink(msg.voice.file_id);
    const response = await axios({ url: fileLink, responseType: "stream" });
    const tempPath = `./${msg.voice.file_id}.ogg`;
    const writer = fs.createWriteStream(tempPath);
    response.data.pipe(writer);
    writer.on("finish", async () => {
      const transcription = await openai.audio.transcriptions.create({
        file: fs.createReadStream(tempPath),
        model: "whisper-1",
      });
      fs.unlinkSync(tempPath);
      const answer = await handleChat(chatId, transcription.text);
      await bot.sendMessage(chatId, `📝 *Transkript:* _${transcription.text}_\n\n${answer}`, { parse_mode: "Markdown" });
    });
  } catch (err) { await bot.sendMessage(chatId, "Fehler beim Audio."); }
});

app.post(`/telegram/${TELEGRAM_BOT_TOKEN}`, (req, res) => { bot.processUpdate(req.body); res.sendStatus(200); });
app.listen(PORT, async () => {
  await bot.deleteWebHook({ drop_pending_updates: true });
  await bot.setWebHook(`${WEBHOOK_URL}/telegram/${TELEGRAM_BOT_TOKEN}`);
});
