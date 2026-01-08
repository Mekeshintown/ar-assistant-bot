"use strict";

const express = require("express");
const TelegramBot = require("node-telegram-bot-api");
const { Client: NotionClient } = require("@notionhq/client");
const OpenAI = require("openai");
const axios = require("axios"); // Für den Audio-Download
const fs = require("fs");

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const WEBHOOK_URL = process.env.WEBHOOK_URL; 
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const PORT = process.env.PORT || 3000;

const DB_CONFIG = "2e1c841ccef980708df2ecee5f0c2df0";
const DB_STUDIOS = "2e0c841ccef980b49c4aefb4982294f0";
const DB_BIOS = "2e0c841ccef9807e9b73c9666ce4fcb0";
const DB_PUBLISHING = "2e0c841ccef980579177d2996f1e92f4";

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN);
const notion = new NotionClient({ auth: NOTION_TOKEN });
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// Einfacher Speicher für den Chat-Verlauf (Memory)
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

async function fetchFullDatabase(databaseId) {
  try {
    const response = await notion.databases.query({ database_id: databaseId });
    return response.results.map(page => parseProperties(page.properties));
  } catch (e) { return []; }
}

// Zentrale Funktion für die KI-Antwort (mit Memory)
async function handleChat(chatId, text) {
  const [config, studios, bios, publishing] = await Promise.all([
    fetchFullDatabase(DB_CONFIG),
    fetchFullDatabase(DB_STUDIOS),
    fetchFullDatabase(DB_BIOS),
    fetchFullDatabase(DB_PUBLISHING)
  ]);

  // Hol den bisherigen Verlauf oder starte neu
  let history = chatContext.get(chatId) || [];
  history.push({ role: "user", content: text });

  // Wir halten die History kurz (letzte 5 Nachrichten), damit es nicht zu teuer/langsam wird
  if (history.length > 6) history.shift();

  const systemMessage = { 
    role: "system", 
    content: `Du bist der A&R Assistent der L'Agentur. Antworte sachlich und professionell. 
    Du hast Zugriff auf: BIOS: ${JSON.stringify(bios)}, IPIs: ${JSON.stringify(publishing)}, STUDIOS: ${JSON.stringify(studios)}, CONFIG: ${JSON.stringify(config)}.
    WICHTIG: Erinnere dich an die vorherigen Nachrichten im Chat, um Korrekturen (z.B. Datumsänderungen) zu verstehen.` 
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

// Handler für Text
bot.on("message", async (msg) => {
  if (msg.voice) return; // Voice wird separat behandelt
  if (!msg.text || msg.text.startsWith("/")) return;
  
  const answer = await handleChat(msg.chat.id, msg.text);
  await bot.sendMessage(msg.chat.id, answer);
});

// Handler für Sprachnachrichten (Whisper Integration)
bot.on("voice", async (msg) => {
  const chatId = msg.chat.id;
  try {
    await bot.sendMessage(chatId, "Ich höre kurz rein... 🎧");
    
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
      
      fs.unlinkSync(tempPath); // Temp Datei löschen
      
      const answer = await handleChat(chatId, `(Sprachnachricht): ${transcription.text}`);
      await bot.sendMessage(chatId, `📝 *Transkript:* _${transcription.text}_\n\n${answer}`, { parse_mode: "Markdown" });
    });
  } catch (err) {
    await bot.sendMessage(chatId, "Konnte die Sprachnachricht leider nicht verarbeiten.");
  }
});

app.post(`/telegram/${TELEGRAM_BOT_TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

app.listen(PORT, async () => {
  await bot.deleteWebHook({ drop_pending_updates: true });
  await bot.setWebHook(`${WEBHOOK_URL}/telegram/${TELEGRAM_BOT_TOKEN}`);
});
