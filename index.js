"use strict";

const express = require("express");
const TelegramBot = require("node-telegram-bot-api");
const { Client: NotionClient } = require("@notionhq/client");
const OpenAI = require("openai");
const axios = require("axios");
const fs = require("fs");
const Airtable = require("airtable");
const { google } = require("googleapis");
const { Document, Packer, Paragraph, Table, TableRow, TableCell, WidthType, AlignmentType, TextRun } = require("docx"); // NEU: Word-Support

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

// DEINE IDs
const DB_CONFIG = "2e1c841ccef980708df2ecee5f0c2df0";
const DB_STUDIOS = "2e0c841ccef980b49c4aefb4982294f0";
const DB_BIOS = "2e0c841ccef9807e9b73c9666ce4fcb0"; 
const DB_PUBLISHING = "2e0c841ccef980579177d2996f1e92f4";
const DB_ARTIST_INFOS = "2e2c841ccef98089aad0ed1531e8655b";
const DB_CALENDARS = "2e3c841ccef9800d96f2c38345eeb2bc";
const DB_LABELCOPIES = "2e4c841ccef980d9ac9bf039d92565cc"; // NEU: Labelcopy-DB
const AIRTABLE_BASE_ID = "appF535cRZRho6btT";

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN);
const notion = new NotionClient({ auth: NOTION_TOKEN });
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const airtableBase = new Airtable({ apiKey: AIRTABLE_API_KEY }).base(AIRTABLE_BASE_ID);

const chatContext = new Map();
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
    else if (p.phone_number) val = p.phone_number || ""; 
    else if (p.url) val = p.url || "";
    else if (p.select) val = p.select.name || "";
    else if (p.email) val = p.email || "";
    else if (p.number) val = p.number?.toString() || "";
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
  } catch (e) { 
    console.log(`Airtable Fehler bei ${tableName}:`, e.message);
    return []; 
  }
}

// --- CORE LOGIK ---

async function handleChat(chatId, text) {
  const fetchSafely = async (id) => {
    try { return await fetchFullDatabase(id); } catch (e) { return []; }
  };

  const [config, calendarList] = await Promise.all([
    fetchSafely(DB_CONFIG),
    fetchSafely(DB_CALENDARS)
  ]);

  const textLower = text.toLowerCase();

  // --- 1. LABELCOPY LOGIK ---
  const lcTriggers = ["labelcopy", "lc anlegen", "neue lc", "exportieren", "word datei"];
  if (lcTriggers.some(word => textLower.includes(word))) {
    
    // FALL: EXPORTIEREN
    if (textLower.includes("exportieren") || textLower.includes("word datei")) {
      const allLCs = await fetchSafely(DB_LABELCOPIES);
      const lc = allLCs[0]; // Nimmt die oberste/neueste
      if (!lc) return "Keine Labelcopy zum Exportieren gefunden.";

      const doc = new Document({
        sections: [{
          properties: {},
          children: [
            new Paragraph({ children: [new TextRun({ text: "Labelcopy", bold: true, size: 32 })] }),
            new Paragraph({ text: `Artist: ${lc.Artist || ""}` }),
            new Paragraph({ text: `Title: ${lc.Titel || ""}` }),
            new Paragraph({ text: `Genre: ${lc.Genre || ""}` }),
            new Paragraph({ text: `Time: ${lc.Time || ""}` }),
            new Paragraph({ text: `Written by: ${lc["Written by"] || ""}` }),
            new Paragraph({ text: `Produced by: ${lc["Produced by"] || ""}` }),
            new Paragraph({ text: `Mastered by: ${lc["Mastered by"] || ""}` }),
            new Paragraph({ text: `Mixed by: ${lc["Mixed by"] || ""}` }),
            new Paragraph({ text: "" }),
            new Paragraph({ text: "Publisher Splits:", bold: true }),
            new Table({
                width: { size: 100, type: WidthType.PERCENTAGE },
                rows: (lc.Splits || "").split("\n").map(line => new TableRow({
                    children: [new TableCell({ children: [new Paragraph(line)] })]
                }))
            })
          ],
        }],
      });

      const fileName = `Labelcopy_${lc.Artist}_${lc.Titel}.docx`.replace(/\s/g, "_");
      const buffer = await Packer.toBuffer(doc);
      fs.writeFileSync(fileName, buffer);
      
      await bot.sendDocument(chatId, fileName);
      fs.unlinkSync(fileName);
      return "Hier ist deine fertige Labelcopy! 📄";
    }

    // FALL: NEU ANLEGEN ODER UPDATEN
    const lcRules = config.find(c => c.Aufgabe === "Labelcopy Rules")?.Anweisung || "";
    
    const extraction = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { 
          role: "system", 
          content: `Du bist ein Labelcopy-Assistent. 
          Regeln: ${lcRules}
          Extrahiere alle Infos für die Spalten: Titel, Artist, Version, Genre, Time, Recording Country, Written by, Published by, Produced by, Mastered by, Mixed by, Vocals by, Programming by, Bass by, Drums by, Keys by, Synth by, Splits, Lyrics.
          Gib NUR ein JSON Objekt zurück.` 
        },
        { role: "user", content: text }
      ],
      response_format: { type: "json_object" }
    });

    const result = JSON.parse(extraction.choices[0].message.content);
    
    // In Notion anlegen
    const properties = {
        "Titel": { title: [{ text: { content: result.Titel || "Unbenannt" } }] },
        "Status": { select: { name: "In Arbeit" } }
    };
    
    // Dynamisch alle anderen Felder füllen die GPT gefunden hat
    const fields = ["Artist", "Version", "Genre", "Time", "Recording Country", "Written by", "Published by", "Produced by", "Mastered by", "Mixed by", "Vocals by", "Programming by", "Bass by", "Drums by", "Keys by", "Synth by", "Splits", "Lyrics"];
    fields.forEach(f => {
      if (result[f]) properties[f] = { rich_text: [{ text: { content: result[f] } }] };
    });

    await notion.pages.create({ parent: { database_id: DB_LABELCOPIES }, properties });

    return `✅ Labelcopy für **${result.Artist || ""} - ${result.Titel || ""}** angelegt.\n\n` +
           `Ich habe die Standard-Credits laut deinen Regeln geprüft und eingetragen. Sobald du fertig bist, sag einfach "Exportieren".`;
  }

  // --- 2. KALENDER LOGIK ---
  const calendarTriggers = ["termin", "kalender", "einplanen", "meeting", "woche", "heute", "morgen", "anstehen", "zeit", "plan", "session", "studio"];
  if (calendarTriggers.some(word => textLower.includes(word)) && text.length > 5) {
    // ... (Hier bleibt dein bestehender Kalender-Code identisch)
    try {
      const extraction = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          { role: "system", content: `Du bist ein Kalender-Assistent. Heute ist ${new Date().toLocaleDateString('de-DE', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}. Künstler: ${calendarList.map(c => c.Name).join(", ")}. Gib NUR JSON zurück.` },
          { role: "user", content: text }
        ],
        response_format: { type: "json_object" }
      });
      const data = JSON.parse(extraction.choices[0].message.content);
      const artistEntry = calendarList.find(c => data.artist && c.Name.toLowerCase().trim() === data.artist.toLowerCase().trim());
      const calId = (artistEntry && artistEntry["Calendar ID"]) ? artistEntry["Calendar ID"].trim() : "mate.spellenberg.umusic@gmail.com";
      const formatForGoogle = (dateStr) => (!dateStr ? new Date().toISOString() : (dateStr.length === 19 ? `${dateStr}Z` : dateStr));

      if (data.type === "read" || textLower.includes("wie sieht") || textLower.includes("was steht")) {
        const response = await calendar.events.list({ calendarId: calId, timeMin: formatForGoogle(data.start_iso), timeMax: formatForGoogle(data.end_iso), singleEvents: true, orderBy: "startTime" });
        const events = response.data.items;
        if (!events || events.length === 0) return `📅 Keine Termine gefunden.`;
        let list = `📅 **Termine:**\n`;
        events.forEach(e => {
          const start = new Date(e.start.dateTime || e.start.date);
          list += `• ${start.toLocaleString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}: **${e.summary}**\n`;
        });
        return list;
      } else {
        await calendar.events.insert({ calendarId: calId, resource: { summary: data.title || "Neuer Termin", start: { dateTime: formatForGoogle(data.start_iso), timeZone: "Europe/Berlin" }, end: { dateTime: formatForGoogle(data.end_iso) || new Date(new Date(formatForGoogle(data.start_iso)).getTime() + 3600000).toISOString(), timeZone: "Europe/Berlin" }, attendees: data.attendees ? data.attendees.map(email => ({ email })) : [] }, sendUpdates: data.attendees ? "all" : "none" });
        return `✅ Termin eingetragen für **${data.artist || "Mate"}**.`;
      }
    } catch (err) { return "❌ Kalender-Fehler."; }
  }

  // --- 3. NORMALER CHAT & AIRTABLE ---
  // (Dein bestehender Airtable- und GPT-Chat Code folgt hier...)
  const [studios, bios, artistInfos, artistPitch, labelPitch, publishing] = await Promise.all([
    fetchSafely(DB_STUDIOS), fetchSafely(DB_BIOS), fetchSafely(DB_ARTIST_INFOS),
    fetchAirtableData('Artist Pitch'), fetchAirtableData('Label Pitch'), fetchSafely(DB_PUBLISHING)
  ]);

  let history = chatContext.get(chatId) || [];
  history.push({ role: "user", content: text });
  if (history.length > 8) history.shift();
  
  const systemMessage = { 
    role: "system", 
    content: `Du bist der A&R Assistent der L'Agentur. Antworte professionell. Wissensdatenbank: Publishing: ${JSON.stringify(publishing)}, Artist-Infos: ${JSON.stringify(artistInfos)}, Bios: ${JSON.stringify(bios)}.` 
  };

  const completion = await openai.chat.completions.create({ model: "gpt-4o", messages: [systemMessage, ...history] });
  const answer = completion.choices[0].message.content;
  history.push({ role: "assistant", content: answer });
  chatContext.set(chatId, history);
  return answer;
}

// --- BOT EVENTS & SERVER ---
bot.on("message", async (msg) => {
  if (msg.voice || !msg.text || msg.text.startsWith("/")) return;
  const answer = await handleChat(msg.chat.id, msg.text);
  await bot.sendMessage(msg.chat.id, answer, { parse_mode: "Markdown" });
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
      const transcription = await openai.audio.transcriptions.create({ file: fs.createReadStream(tempPath), model: "whisper-1" });
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
  console.log("Bot läuft.");
});
