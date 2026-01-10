"use strict";

const express = require("express");
const TelegramBot = require("node-telegram-bot-api");
const { Client: NotionClient } = require("@notionhq/client");
const OpenAI = require("openai");
const axios = require("axios");
const fs = require("fs");
const Airtable = require("airtable");
const { google } = require("googleapis");
const { Document, Packer, Paragraph, Table, TableRow, TableCell, WidthType, TextRun, AlignmentType, BorderStyle } = require("docx");

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const WEBHOOK_URL = process.env.WEBHOOK_URL; 
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const PORT = process.env.PORT || 3000;

// Google Calendar Setup
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);
oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
const calendar = google.calendar({ version: "v3", auth: oauth2Client });

// IDs
const DB_CONFIG = "2e1c841ccef980708df2ecee5f0c2df0";
const DB_STUDIOS = "2e0c841ccef980b49c4aefb4982294f0";
const DB_BIOS = "2e0c841ccef9807e9b73c9666ce4fcb0"; 
const DB_PUBLISHING = "2e0c841ccef980579177d2996f1e92f4";
const DB_ARTIST_INFOS = "2e2c841ccef98089aad0ed1531e8655b";
const DB_CALENDARS = "2e3c841ccef9800d96f2c38345eeb2bc";
const DB_LABELCOPIES = "2e4c841ccef980d9ac9bf039d92565cc";
const AIRTABLE_BASE_ID = "appF535cRZRho6btT";

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN);
const notion = new NotionClient({ auth: NOTION_TOKEN });
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const airtableBase = new Airtable({ apiKey: AIRTABLE_API_KEY }).base(AIRTABLE_BASE_ID);

const chatContext = new Map();
const activeSession = new Map(); // GEDÄCHTNIS FÜR LABELCOPY
const app = express();
app.use(express.json());

// --- HILFSFUNKTIONEN ---

function parseProperties(properties) {
  let data = {};
  for (const key in properties) {
    const p = properties[key];
    let val = "";
    if (p.title) val = p.title[0]?.plain_text || "";
    else if (p.rich_text) val = p.rich_text[0]?.plain_text || "";
    else if (p.select) val = p.select.name || "";
    else if (p.number) val = p.number?.toString() || "";
    else if (p.url) val = p.url || "";
    data[key] = val;
  }
  return data;
}

async function fetchFullDatabase(id) {
  try {
    const res = await notion.databases.query({ database_id: id });
    return res.results.map(p => ({ id: p.id, ...parseProperties(p.properties) }));
  } catch (e) { return []; }
}

async function fetchAirtableData(tableName) {
  try {
    const records = await airtableBase(tableName).select().all();
    return records.map(r => ({ id: r.id, ...r.fields }));
  } catch (e) { return []; }
}

// --- LABELCOPY SPEZIALFUNKTIONEN ---

async function checkLCStatus(chatId, pageId) {
    const page = await notion.pages.retrieve({ page_id: pageId });
    const props = parseProperties(page.properties);
    const allFields = ["Artist", "Version", "Genre", "Time", "Recording Country", "Written by", "Published by", "Produced by", "Mastered by", "Mixed by", "Vocals by", "Programming by", "Bass by", "Drums by", "Keys by", "Synth by", "Splits", "Lyrics"];
    
    let statusMsg = `📝 **Labelcopy-Maske: ${props.Titel || "Unbenannt"}**\n`;
    statusMsg += `----------------------------------\n`;
    allFields.forEach(f => {
        const val = props[f] || "";
        statusMsg += val.trim() !== "" ? `✅ **${f}:** ${val}\n` : `❌ **${f}:** _noch leer_\n`;
    });
    statusMsg += `----------------------------------\n👉 Schick mir einfach neue Infos, ich ergänze sie.`;
    return statusMsg;
}

function buildNotionProps(data) {
    const props = {};
    if (data.Titel) props["Titel"] = { title: [{ text: { content: data.Titel } }] };
    const textFields = ["Artist", "Version", "Genre", "Time", "Recording Country", "Written by", "Published by", "Produced by", "Mastered by", "Mixed by", "Vocals by", "Programming by", "Bass by", "Drums by", "Keys by", "Synth by", "Splits", "Lyrics"];
    textFields.forEach(f => { if (data[f]) props[f] = { rich_text: [{ text: { content: data[f].toString() } }] }; });
    return props;
}

async function handleChat(chatId, text) {
  const textLower = text.toLowerCase();
  const [config, calendarList] = await Promise.all([fetchFullDatabase(DB_CONFIG), fetchFullDatabase(DB_CALENDARS)]);

  // --- LABELCOPY LOGIK ---
  const lcTriggers = ["labelcopy", "lc ", "neue lc", "export", "status", "stand", "maske"];
  if (lcTriggers.some(t => textLower.includes(t)) || (activeSession.has(chatId) && text.length > 2)) {
    
    const lcRules = config.find(c => c.Aufgabe === "Labelcopy Rules")?.Anweisung || "";

    // EXPORT
    if (textLower.includes("export") || textLower.includes("word")) {
      const currentId = activeSession.get(chatId);
      if (!currentId) return "An welcher Labelcopy arbeiten wir? Bitte nenne mir den Titel.";
      
      const page = await notion.pages.retrieve({ page_id: currentId });
      const lc = parseProperties(page.properties);
      
      const doc = new Document({
        sections: [{
          children: [
            new Paragraph({ children: [new TextRun({ text: "LABELCOPY", bold: true, size: 32 })], alignment: AlignmentType.CENTER }),
            new Paragraph({ text: "" }),
            ...["Artist", "Titel", "Version", "Genre", "Time", "Written by", "Published by", "Produced by", "Mastered by", "Recording Country"].map(f => new Paragraph({
                children: [new TextRun({ text: `${f}: `, bold: true }), new TextRun(lc[f] || "")]
            })),
            new Paragraph({ text: "" }),
            new Paragraph({ text: "Additional Credits:", bold: true }),
            ...["Mixed by", "Vocals by", "Programming by", "Bass by", "Drums by", "Keys by", "Synth by"].map(f => new Paragraph({
                children: [new TextRun({ text: `${f}: `, bold: true }), new TextRun(lc[f] || "")]
            })),
            new Paragraph({ text: "" }),
            new Paragraph({ text: "Publisher Splits:", bold: true }),
            new Table({
                width: { size: 100, type: WidthType.PERCENTAGE },
                rows: (lc.Splits || "Writer Name 100%").split("\n").map(line => new TableRow({
                    children: [new TableCell({ children: [new Paragraph(line)] })]
                }))
            })
          ]
        }]
      });

      const fileName = `LC_${lc.Artist || "Unbekannt"}_${lc.Titel || "Song"}.docx`.replace(/\s/g, "_");
      const buffer = await Packer.toBuffer(doc);
      fs.writeFileSync(fileName, buffer);
      await bot.sendDocument(chatId, fileName);
      fs.unlinkSync(fileName);
      return "Hier ist dein Word-Dokument! 📄";
    }

    // STATUS
    if (textLower.includes("status") || textLower.includes("stand") || textLower.includes("maske")) {
        const currentId = activeSession.get(chatId);
        return currentId ? await checkLCStatus(chatId, currentId) : "Welche Labelcopy meinst du?";
    }

    // EXTRAKTION & UPDATE/NEU
    const extraction = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
            { role: "system", content: `Extrahiere Labelcopy Infos. Regeln aus Config: ${lcRules}. Gib NUR JSON zurück.` },
            { role: "user", content: text }
        ],
        response_format: { type: "json_object" }
    });
    const data = JSON.parse(extraction.choices[0].message.content);

    if (textLower.includes("neue") || !activeSession.has(chatId)) {
        const newPage = await notion.pages.create({ parent: { database_id: DB_LABELCOPIES }, properties: buildNotionProps(data) });
        activeSession.set(chatId, newPage.id);
        return `✅ Neue LC angelegt.\n\n` + await checkLCStatus(chatId, newPage.id);
    } else {
        const currentId = activeSession.get(chatId);
        await notion.pages.update({ page_id: currentId, properties: buildNotionProps(data) });
        return `📥 Infos ergänzt.\n\n` + await checkLCStatus(chatId, currentId);
    }
  }

  // --- KALENDER LOGIK ---
  const calendarTriggers = ["termin", "kalender", "einplanen", "meeting", "woche", "heute", "morgen"];
  if (calendarTriggers.some(word => textLower.includes(word)) && text.length > 5) {
      try {
          const extraction = await openai.chat.completions.create({
              model: "gpt-4o",
              messages: [{ role: "system", content: `Kalender-Assistent. Heute ist ${new Date().toLocaleDateString('de-DE')}. Künstler: ${calendarList.map(c => c.Name).join(", ")}. JSON exportieren.` }, { role: "user", content: text }],
              response_format: { type: "json_object" }
          });
          const d = JSON.parse(extraction.choices[0].message.content);
          const artist = calendarList.find(c => d.artist && c.Name.toLowerCase() === d.artist.toLowerCase());
          const calId = artist?.["Calendar ID"] || "mate.spellenberg.umusic@gmail.com";
          
          if (d.type === "read" || textLower.includes("wie sieht")) {
              const res = await calendar.events.list({ calendarId: calId, timeMin: new Date().toISOString(), singleEvents: true, orderBy: "startTime" });
              let l = `📅 Termine:\n`;
              res.data.items.forEach(e => { l += `• ${new Date(e.start.dateTime || e.start.date).toLocaleString('de-DE')}: ${e.summary}\n`; });
              return l;
          } else {
              await calendar.events.insert({ calendarId: calId, resource: { summary: d.title, start: { dateTime: d.start_iso, timeZone: "Europe/Berlin" }, end: { dateTime: d.end_iso, timeZone: "Europe/Berlin" } } });
              return `✅ Termin eingetragen für ${d.artist || "Mate"}.`;
          }
      } catch (e) { return "❌ Kalender-Fehler."; }
  }

  // --- NORMALER CHAT & AIRTABLE ---
  const [studios, bios, artistInfos, artistPitch, labelPitch, publishing] = await Promise.all([
      fetchFullDatabase(DB_STUDIOS), fetchFullDatabase(DB_BIOS), fetchFullDatabase(DB_ARTIST_INFOS),
      fetchAirtableData('Artist Pitch'), fetchAirtableData('Label Pitch'), fetchFullDatabase(DB_PUBLISHING)
  ]);

  let history = chatContext.get(chatId) || [];
  history.push({ role: "user", content: text });
  const systemMsg = { role: "system", content: `A&R Assistent. Config: ${JSON.stringify(config)}. Publishing: ${JSON.stringify(publishing)}.` };
  const comp = await openai.chat.completions.create({ model: "gpt-4o", messages: [systemMsg, ...history.slice(-8)] });
  const ans = comp.choices[0].message.content;
  history.push({ role: "assistant", content: ans });
  chatContext.set(chatId, history);
  return ans;
}

// SERVER & BOT START
bot.on("message", async (msg) => {
  if (msg.voice || !msg.text || msg.text.startsWith("/")) return;
  const answer = await handleChat(msg.chat.id, msg.text);
  await bot.sendMessage(msg.chat.id, answer, { parse_mode: "Markdown" });
});

bot.on("voice", async (msg) => {
    const chatId = msg.chat.id;
    const fileLink = await bot.getFileLink(msg.voice.file_id);
    const response = await axios({ url: fileLink, responseType: "stream" });
    const tempPath = `./${msg.voice.file_id}.ogg`;
    const writer = fs.createWriteStream(tempPath);
    response.data.pipe(writer);
    writer.on("finish", async () => {
        const transcription = await openai.audio.transcriptions.create({ file: fs.createReadStream(tempPath), model: "whisper-1" });
        fs.unlinkSync(tempPath);
        const answer = await handleChat(chatId, transcription.text);
        await bot.sendMessage(chatId, `📝 _${transcription.text}_\n\n${answer}`, { parse_mode: "Markdown" });
    });
});

app.post(`/telegram/${TELEGRAM_BOT_TOKEN}`, (req, res) => { bot.processUpdate(req.body); res.sendStatus(200); });
app.listen(PORT, async () => {
  await bot.deleteWebHook({ drop_pending_updates: true });
  await bot.setWebHook(`${WEBHOOK_URL}/telegram/${TELEGRAM_BOT_TOKEN}`);
  console.log("Bot läuft.");
});
