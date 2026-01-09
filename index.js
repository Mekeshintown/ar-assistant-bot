"use strict";

const express = require("express");
const TelegramBot = require("node-telegram-bot-api");
const { Client: NotionClient } = require("@notionhq/client");
const OpenAI = require("openai");
const axios = require("axios");
const fs = require("fs");
const Airtable = require("airtable");
const { google } = require("googleapis"); // NEU hinzugefügt

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const WEBHOOK_URL = process.env.WEBHOOK_URL; 
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const PORT = process.env.PORT || 3000;

// Google Calendar Setup (NEU)
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
const DB_CALENDARS = "2e3c841ccef9800d96f2c38345eeb2bc"; // NEU: Deine Kalender-Tabelle
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
    return res.results.map(p => parseProperties(p.properties));
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

  // Laden aller Daten
  const [config, studios, bios, artistInfos, artistPitch, labelPitch, publishing, calendarList] = await Promise.all([
    fetchSafely(DB_CONFIG),
    fetchSafely(DB_STUDIOS),
    fetchSafely(DB_BIOS),
    fetchSafely(DB_ARTIST_INFOS),
    fetchAirtableData('Artist Pitch'),
    fetchAirtableData('Label Pitch'),
    fetchSafely(DB_PUBLISHING),
    fetchSafely(DB_CALENDARS) // NEU: Lädt deine Kalender-IDs aus Notion
  ]);

  // 2. CHECK: KALENDER EINTRAGEN
  const calendarTriggers = ["termin", "kalender", "einplanen", "meeting", "studio-termin"];
  if (calendarTriggers.some(word => text.toLowerCase().includes(word)) && text.length > 15) {
    try {
      const extraction = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          { 
            role: "system", 
            content: `Du bist ein Kalender-Assistent. Heute ist ${new Date().toLocaleDateString('de-DE', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}.
            Verfügbare Kalender (Künstler): ${calendarList.map(c => c.Name).join(", ")}.
            Extrahiere: title, start_iso (ISO String), artist (Name aus der Liste), duration (in Minuten, Standard 60).
            Gib NUR ein valides JSON Objekt zurück.` 
          },
          { role: "user", content: text }
        ],
        response_format: { type: "json_object" }
      });

      const data = JSON.parse(extraction.choices[0].message.content);
      
      // Suchlogik angepasst auf "Calendar ID" (mit Leerzeichen)
      const artistEntry = calendarList.find(c => 
        data.artist && c.Name && c.Name.toLowerCase().trim() === data.artist.toLowerCase().trim()
      );
      
      // Wenn in Notion gefunden, nimm die ID. Sonst nimm deine Email als Standard.
      const calId = (artistEntry && artistEntry["Calendar ID"]) ? artistEntry["Calendar ID"] : "mate.spellenberg.umusic@gmail.com";
      
      const event = {
        summary: data.title,
        start: { dateTime: data.start_iso, timeZone: "Europe/Berlin" },
        end: { 
          dateTime: new Date(new Date(data.start_iso).getTime() + (data.duration || 60) * 60000).toISOString(), 
          timeZone: "Europe/Berlin" 
        }
      };

      await calendar.events.insert({ calendarId: calId.trim(), resource: event });
      return `✅ Termin eingetragen für **${artistEntry ? artistEntry.Name : "Mate (Standard)"}**\n📌 ${data.title}\n⏰ ${new Date(data.start_iso).toLocaleString('de-DE')}`;
    } catch (err) {
      console.error("Calendar Error Details:", err);
      return "❌ Fehler beim Eintragen. Bitte nenne Künstler, Datum und Uhrzeit.";
    }
  }

  // --- CHECK: SOLL ETWAS GESPEICHERT WERDEN? (Airtable) ---
  const triggerWords = ["speichere", "adden", "adde", "hinzufügen", "eintragen"];
  if (triggerWords.some(word => text.toLowerCase().includes(word)) && !text.toLowerCase().includes("termin")) {
    try {
      const extraction = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          { 
            role: "system", 
            content: `Du bist ein Daten-Extraktor. Extrahiere Kontaktdaten.
            Mögliche Felder: Artist_Name, Contact_FirstName, Contact_LastName, Email, Label_Name, Genre, Prio.
            Gib NUR ein valides JSON Objekt zurück.
            Entscheide ob es in die Tabelle "Artist Pitch" oder "Label Pitch" gehört (Key: "table").` 
          },
          { role: "user", content: text }
        ],
        response_format: { type: "json_object" }
      });

      const result = JSON.parse(extraction.choices[0].message.content);
      const tableName = result.table || (text.toLowerCase().includes("label") ? "Label Pitch" : "Artist Pitch");
      
      let finalFields = {};
      if (tableName === "Artist Pitch") {
        if (result.Artist_Name) finalFields.Artist_Name = result.Artist_Name;
        if (result.Contact_FirstName) finalFields.Contact_FirstName = result.Contact_FirstName;
        if (result.Contact_LastName) finalFields.Contact_LastName = result.Contact_LastName;
        if (result.Email) finalFields.Email = result.Email;
        if (result.Genre) finalFields.Genre = result.Genre;
        if (result.Prio) finalFields.Prio = result.Prio;
      } else {
        if (result.Label_Name) finalFields.Label_Name = result.Label_Name;
        if (result.Contact_FirstName) finalFields.Contact_FirstName = result.Contact_FirstName;
        if (result.Contact_LastName) finalFields.Contact_LastName = result.Contact_LastName;
        if (result.Email) finalFields.Email = result.Email;
      }

      await airtableBase(tableName).create([{ fields: finalFields }]);
      return `✅ Erfolgreich gespeichert in ${tableName}:\n\n👤 ${finalFields.Contact_FirstName || ""} ${finalFields.Contact_LastName || ""}\n📧 ${finalFields.Email}`;
    } catch (error) {
      console.error("Airtable Save Error:", error);
      return "❌ Fehler beim Speichern in Airtable.";
    }
  }

  // --- NORMALER CHAT / PITCH LOGIK ---
  let history = chatContext.get(chatId) || [];
  history.push({ role: "user", content: text });
  if (history.length > 8) history.shift();
  
  const pitchRules = config.find(c => c.Key === "Pitch_Rules")?.Value || "";
  const sonstigeRegeln = config.filter(c => c.Key !== "Pitch_Rules");

  const systemMessage = { 
    role: "system", 
    content: `Du bist der A&R Assistent der L'Agentur. Antworte professionell und präzise.
    
    ### UNBEDINGT BEACHTEN: PITCH REGELN ###
    ${pitchRules}

    ### WEITERE RICHTLINIEN ###
    ${JSON.stringify(sonstigeRegeln)}

    ### WISSENSDATENBANK ###
    - PUBLISHING (IPI Nummern, Verlage, Anteile): ${JSON.stringify(publishing)}
    - ARTIST PITCH (Emails/Prio/Genre): ${JSON.stringify(artistPitch)}
    - LABEL PITCH (A&Rs/Label): ${JSON.stringify(labelPitch)}
    - ARTIST INFOS: ${JSON.stringify(artistInfos)}
    - BIOS: ${JSON.stringify(bios)}
    - STUDIOS: ${JSON.stringify(studios)}

    DEINE AUFGABEN:
    1. Wenn nach IPI Nummern, Verlagen oder Song-Anteilen gefragt wird, schau zuerst in PUBLISHING.
    2. Wenn nach Emails/Manager gefragt wird, schau in ARTIST PITCH. Nenne Vorname + Email.
    3. Wenn nach Rundmail-Listen gefragt wird (z.B. "Alle A-List im Dance Pop"), gib NUR die E-Mails getrennt durch Komma aus.
    4. Wenn nach A&Rs oder Labels gefragt wird, schau in LABEL PITCH.
    5. Nur wenn explizit ein Pitch verlangt wird (z.B. "Schreib einen Pitch"), entwirf Betreff und Text basierend auf den Artist-Daten und den Pitch_Rules aus der Config.
    6. Beachte alle Formatierungsregeln (Bio:, Spotify Links pur) aus deiner Config.` 
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
  console.log("Bot läuft und hört auf Notion, Airtable & Kalender.");
});
