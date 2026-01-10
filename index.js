"use strict";

const express = require("express");
const TelegramBot = require("node-telegram-bot-api");
const { Client: NotionClient } = require("@notionhq/client");
const OpenAI = require("openai");
const axios = require("axios");
const fs = require("fs");
const Airtable = require("airtable");
const { google } = require("googleapis");
const { Document, Packer, Paragraph, Table, TableRow, TableCell, WidthType, TextRun, AlignmentType } = require("docx");

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const WEBHOOK_URL = process.env.WEBHOOK_URL; 
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const PORT = process.env.PORT || 3000;

// Google Calendar Setup (Exakt wie in deiner Basis)
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
const DB_LABELCOPIES = "2e4c841ccef980d9ac9bf039d92565cc";
const AIRTABLE_BASE_ID = "appF535cRZRho6btT";

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN);
const notion = new NotionClient({ auth: NOTION_TOKEN });
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const airtableBase = new Airtable({ apiKey: AIRTABLE_API_KEY }).base(AIRTABLE_BASE_ID);

const chatContext = new Map();
const activeSession = new Map(); 
const app = express();
app.use(express.json());

// --- HILFSFUNKTIONEN (Exakt aus deiner Basis übernommen) ---

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
  } catch (e) { return []; }
}

// --- ZUSATZ: LABELCOPY HELPER (Damit handleChat sauber bleibt) ---

function buildNotionProps(data) {
    const props = {};
    const fields = ["Artist", "Version", "Genre", "Time", "Recording Country", "Written by", "Published by", "Produced by", "Mastered by", "Mixed by", "Vocals by", "Programming by", "Bass by", "Drums by", "Keys by", "Synth by", "Splits", "Lyrics"];
    if (data.Titel) props["Titel"] = { title: [{ text: { content: String(data.Titel) } }] };
    fields.forEach(f => { 
        if (data[f] || data[f.toLowerCase()]) {
            let val = data[f] || data[f.toLowerCase()];
            if (typeof val === 'object') val = JSON.stringify(val);
            props[f] = { rich_text: [{ text: { content: String(val) } }] }; 
        }
    });
    return props;
}

async function showFullMask(chatId, pageId) {
    const page = await notion.pages.retrieve({ page_id: pageId });
    const props = parseProperties(page.properties);
    const fields = ["Artist", "Titel", "Version", "Genre", "Time", "Recording Country", "Written by", "Published by", "Produced by", "Mastered by", "Mixed by", "Vocals by", "Programming by", "Bass by", "Drums by", "Keys by", "Synth by", "Splits", "Lyrics"];
    let msg = `📋 **Labelcopy: ${props.Artist || "..."} - ${props.Titel || "..."}**\n`;
    msg += `----------------------------------\n`;
    fields.forEach(f => {
        const val = props[f] || "";
        msg += val.trim() !== "" ? `✅ **${f}:** ${val}\n` : `❌ **${f}:** _noch leer_\n`;
    });
    msg += `----------------------------------\n👉 *Infos schreiben, "Exportieren" oder "Fertig" sagen.*`;
    return msg;
}

// --- CORE LOGIK ---

async function handleChat(chatId, text) {
  const textLower = text.toLowerCase();
  let session = activeSession.get(chatId);

  // LABELCOPY SESSION STOPP
  if (session && (textLower === "fertig" || textLower === "session löschen")) {
    activeSession.delete(chatId);
    return "Check. Session geschlossen. Ich bin wieder im normalen Modus.";
  }

  const fetchSafely = async (id) => {
    try { return await fetchFullDatabase(id); } catch (e) { return []; }
  };

  // Original Fetching (Exakt wie in deiner Datei)
  const [config, studios, bios, artistInfos, artistPitch, labelPitch, publishing, calendarList] = await Promise.all([
    fetchSafely(DB_CONFIG),
    fetchSafely(DB_STUDIOS),
    fetchSafely(DB_BIOS),
    fetchSafely(DB_ARTIST_INFOS),
    fetchAirtableData('Artist Pitch'),
    fetchAirtableData('Label Pitch'),
    fetchSafely(DB_PUBLISHING),
    fetchSafely(DB_CALENDARS)
  ]);

  // LABELCOPY RECALL
  const recallTriggers = ["stand", "status", "zeig mir", "weiterarbeiten"];
  if (recallTriggers.some(t => textLower.includes(t)) && text.length > 5 && !session) {
    const lcs = await fetchFullDatabase(DB_LABELCOPIES);
    const found = lcs.find(l => (l.Titel && textLower.includes(l.Titel.toLowerCase())) || (l.Artist && textLower.includes(l.Artist.toLowerCase())));
    if (found) {
      activeSession.set(chatId, { step: "confirm_recall", pendingPageId: found.id, artist: found.Artist, title: found.Titel });
      return `Ich habe eine Labelcopy gefunden: **${found.Artist} - ${found.Titel}**. \n\nMöchtest du an dieser weiterarbeiten? (Ja/Nein)`;
    }
  }

  if (session && session.step === "confirm_recall") {
    if (textLower.includes("ja") || textLower.includes("yes")) {
      activeSession.set(chatId, { step: "active", pageId: session.pendingPageId, artist: session.artist, title: session.title });
      return await showFullMask(chatId, session.pendingPageId);
    } else { activeSession.delete(chatId); return "Suche abgebrochen."; }
  }

  // LABELCOPY TRIGGER
  if (textLower.includes("labelcopy anlegen") || textLower.includes("lc anlegen")) {
    activeSession.set(chatId, { step: "awaiting_artist" });
    return "Alles klar! Welcher **Künstler** soll es sein?";
  }

  // LC WORKFLOW
  if (session) {
    if (session.step === "awaiting_artist") {
      session.artist = text; session.step = "awaiting_title";
      activeSession.set(chatId, session);
      return `Notiert: **${text}**. Wie lautet der **Titel** des Songs?`;
    }
    if (session.step === "awaiting_title") {
      session.title = text; session.step = "active";
      const newPage = await notion.pages.create({ parent: { database_id: DB_LABELCOPIES }, properties: buildNotionProps({ Artist: session.artist, Titel: session.title }) });
      session.pageId = newPage.id; activeSession.set(chatId, session);
      return await showFullMask(chatId, newPage.id);
    }
    
    const extraction = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [{ role: "system", content: "Extrahiere Labelcopy Felder als JSON. 'Abmischung' -> Mixed by etc." }, { role: "user", content: text }],
        response_format: { type: "json_object" }
    });
    const updateData = JSON.parse(extraction.choices[0].message.content);
    if (Object.keys(updateData).length > 0) {
        await notion.pages.update({ page_id: session.pageId, properties: buildNotionProps(updateData) });
        return await showFullMask(chatId, session.pageId);
    }
  }

  // --- KALENDER LOGIK (Exakt aus deiner Basis) ---
  const calendarTriggers = [\"termin\", \"kalender\", \"einplanen\", \"meeting\", \"woche\", \"heute\", \"morgen\", \"anstehen\", \"zeit\", \"plan\", \"session\", \"studio\"];
  
  if (calendarTriggers.some(word => textLower.includes(word)) && text.length > 5) {
    try {
      const extraction = await openai.chat.completions.create({
        model: \"gpt-4o\",
        messages: [
          { 
            role: \"system\", 
            content: `Du bist ein Kalender-Assistent. Heute ist ${new Date().toLocaleDateString('de-DE', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}.
            Künstler: ${calendarList.map(c => c.Name).join(\", \")}.
            
            Aufgabe:
          1. type: \"read\" (Abfragen) oder \"write\" (Eintragen).
          2. artist: Name aus der Liste.
          3. start_iso & end_iso: ISO-Strings.
          4. title: Titel (nur write).
          
          Gib NUR JSON zurück.` 
          },
          { role: \"user\", content: text }
        ],
        response_format: { type: \"json_object\" }
      });

      const data = JSON.parse(extraction.choices[0].message.content);
      const artistEntry = calendarList.find(c => data.artist && c.Name.toLowerCase().trim() === data.artist.toLowerCase().trim());
      const calId = (artistEntry && artistEntry[\"Calendar ID\"]) ? artistEntry[\"Calendar ID\"].trim() : \"mate.spellenberg.umusic@gmail.com\";
      const artistName = artistEntry ? artistEntry.Name : (data.artist || \"Mate\");

      const formatForGoogle = (dateStr) => {
        if (!dateStr) return new Date().toISOString();
        return dateStr.length === 19 ? `${dateStr}Z` : dateStr;
      };

      if (data.type === \"read\" || textLower.includes(\"wie sieht\") || textLower.includes(\"was steht\")) {
        const response = await calendar.events.list({
          calendarId: calId,
          timeMin: formatForGoogle(data.start_iso),
          timeMax: formatForGoogle(data.end_iso),
          singleEvents: true,
          orderBy: \"startTime\",
        });

        const events = response.data.items;
        if (!events || events.length === 0) return `📅 Keine Termine für **${artistName}** gefunden.`;

        let list = `📅 **Termine für ${artistName}:**\n`;
        events.forEach(e => {
          const start = new Date(e.start.dateTime || e.start.date);
          const dateStr = start.toLocaleString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' });
          const timeStr = !e.start.dateTime ? \"Ganztägig\" : start.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
          list += `• ${dateStr} (${timeStr}): **${e.summary}**\n`;
        });
        return list;
      } 
      else {
        await calendar.events.insert({ 
          calendarId: calId, 
          resource: { 
            summary: data.title, 
            start: { dateTime: formatForGoogle(data.start_iso), timeZone: \"Europe/Berlin\" }, 
            end: { dateTime: formatForGoogle(data.end_iso) || new Date(new Date(formatForGoogle(data.start_iso)).getTime() + 3600000).toISOString(), timeZone: \"Europe/Berlin\" } 
          } 
        });
        return `✅ Termin eingetragen für **${artistName}**`;
      }
    } catch (err) { return \"❌ Kalender-Fehler.\"; }
  }
  
  // --- AIRTABLE SAVE (Exakt aus deiner Basis) ---
  const triggerWords = [\"speichere\", \"adden\", \"adde\", \"hinzufügen\", \"eintragen\"];
  if (triggerWords.some(word => text.toLowerCase().includes(word)) && !text.toLowerCase().includes(\"termin\")) {
    try {
      const extraction = await openai.chat.completions.create({
        model: \"gpt-4o\",
        messages: [{ role: \"system\", content: `Extrahiere Kontaktdaten. JSON Key: \"table\" (Artist Pitch/Label Pitch).` }, { role: \"user\", content: text }],
        response_format: { type: \"json_object\" }
      });
      const result = JSON.parse(extraction.choices[0].message.content);
      const tableName = result.table || (text.toLowerCase().includes(\"label\") ? \"Label Pitch\" : \"Artist Pitch\");
      await airtableBase(tableName).create([{ fields: result }]);
      return `✅ Erfolgreich gespeichert in ${tableName}.`;
    } catch (error) { return \"❌ Airtable Fehler.\"; }
  }

  // --- NORMALER CHAT (Exakt aus deiner Basis) ---
  let history = chatContext.get(chatId) || [];
  history.push({ role: \"user\", content: text });
  if (history.length > 8) history.shift();
  
  const pitchRules = config.find(c => c.Key === \"Pitch_Rules\")?.Value || \"\";

  const systemMessage = { 
    role: \"system\", 
    content: `Du bist der A&R Assistent der L'Agentur. Antworte professionell und präzise.
    
    ### PITCH REGELN ###
    ${pitchRules}

    ### WISSENSDATENBANK ###
    - PUBLISHING: ${JSON.stringify(publishing)}
    - ARTIST PITCH: ${JSON.stringify(artistPitch)}
    - LABEL PITCH: ${JSON.stringify(labelPitch)}
    - ARTIST INFOS: ${JSON.stringify(artistInfos)}
    - BIOS: ${JSON.stringify(bios)}
    - STUDIOS: ${JSON.stringify(studios)}` 
  };

  const completion = await openai.chat.completions.create({ model: \"gpt-4o\", messages: [systemMessage, ...history] });
  const answer = completion.choices[0].message.content;
  history.push({ role: \"assistant\", content: answer });
  chatContext.set(chatId, history);
  return answer;
}

// --- BOT EVENTS & SERVER (Exakt aus deiner Basis) ---

bot.on(\"message\", async (msg) => {
  if (msg.voice || !msg.text || msg.text.startsWith(\"/\")) return;
  const answer = await handleChat(msg.chat.id, msg.text);
  await bot.sendMessage(msg.chat.id, answer, { parse_mode: \"Markdown\" });
});

bot.on(\"voice\", async (msg) => {
  const chatId = msg.chat.id;
  try {
    const fileLink = await bot.getFileLink(msg.voice.file_id);
    const response = await axios({ url: fileLink, responseType: \"stream\" });
    const tempPath = `./${msg.voice.file_id}.ogg`;
    const writer = fs.createWriteStream(tempPath);
    response.data.pipe(writer);
    writer.on(\"finish\", async () => {
      const transcription = await openai.audio.transcriptions.create({ file: fs.createReadStream(tempPath), model: \"whisper-1\" });
      fs.unlinkSync(tempPath);
      const answer = await handleChat(chatId, transcription.text);
      await bot.sendMessage(chatId, `📝 *Transkript:* _${transcription.text}_\n\n${answer}`, { parse_mode: \"Markdown\" });
    });
  } catch (err) { await bot.sendMessage(chatId, \"Fehler beim Audio.\"); }
});

app.post(`/telegram/${TELEGRAM_BOT_TOKEN}`, (req, res) => { bot.processUpdate(req.body); res.sendStatus(200); });
app.listen(PORT, async () => {
  await bot.deleteWebHook({ drop_pending_updates: true });
  await bot.setWebHook(`${WEBHOOK_URL}/telegram/${TELEGRAM_BOT_TOKEN}`);
  console.log(\"Bot läuft.\");
});
