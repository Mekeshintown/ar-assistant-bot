"use strict";

const express = require("express");
const TelegramBot = require("node-telegram-bot-api");
const { Client: NotionClient } = require("@notionhq/client");
const OpenAI = require("openai");
const axios = require("axios");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Document, Packer, Paragraph, TextRun } = require("docx");
const Airtable = require("airtable");
const { google } = require("googleapis"); // NEU hinzugefügt

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const WEBHOOK_URL = process.env.WEBHOOK_URL; 
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const LABELCOPY_DB_ID = process.env.LABELCOPY_DB_ID;
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

const activeSession = new Map(); // Labelcopy Sessions pro Chat

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



// --- LABELCOPY MODULE ---

function buildNotionProps(data) {
  const props = {};
  const notionFields = ["Artist", "Version", "Genre", "Time", "Recording Country", "Written by", "Published by", "Produced by", "Mastered by", "Mixed by", "Vocals by", "Programming by", "Bass by", "Drums by", "Keys by", "Synth by", "Splits", "Lyrics"];

  if (data.Titel !== undefined && data.Titel !== null) {
    props["Titel"] = { title: [{ text: { content: String(data.Titel) } }] };
  }

  notionFields.forEach(f => {
    const incomingValue = (data[f] !== undefined) ? data[f] : data[String(f).toLowerCase()];
    if (incomingValue !== undefined && incomingValue !== null) {
      let val = incomingValue;
      if (typeof val === "object") {
        val = Object.entries(val).map(([k, v]) => `${k}: ${v}`).join("\n");
      }
      props[f] = { rich_text: [{ text: { content: String(val) } }] };
    }
  });

  return props;
}

function normalizeLabelcopyKeys(obj) {
  if (!obj || typeof obj !== "object") return obj;

  const aliases = {
    // Mixed by
    "mixer": "Mixed by",
    "mix": "Mixed by",
    "abmischung": "Mixed by",
    "abgemischt": "Mixed by",
    "abgemischt von": "Mixed by",
    "mixed by": "Mixed by",

    // Mastered by
    "master": "Mastered by",
    "mastering": "Mastered by",
    "gemastert": "Mastered by",
    "mastered by": "Mastered by",

    // Produced by
    "producer": "Produced by",
    "produktion": "Produced by",
    "produced by": "Produced by",

    // Written by
    "writer": "Written by",
    "songwriter": "Written by",
    "geschrieben von": "Written by",
    "written by": "Written by",

    // Published by
    "verlag": "Published by",
    "publisher": "Published by",
    "published by": "Published by",

    // Splits
    "split": "Splits",
    "splits": "Splits",
    "anteile": "Splits",
    "shares": "Splits",

    // Lyrics
    "text": "Lyrics",
    "lyrics": "Lyrics",

    // Artist
    "künstler": "Artist",
    "artist": "Artist",

    // Titel
    "title": "Titel",
    "titel": "Titel"
  };

  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const keyLower = String(k).toLowerCase().trim();
    const canon = aliases[keyLower] || k;
    out[canon] = v;
  }
  return out;
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
  msg += `----------------------------------\n`;
  msg += `👉 *Infos einfach hier reinschreiben (z.B. "Mix von Tobias", "Splits 50/50").* \n`;
  msg += `👉 *Sagen Sie **"Exportieren"**, um das Word-File zu erhalten.*\n`;
  msg += `👉 *Sagen Sie **"Fertig"**, um die Session zu schließen.*`;
  return msg;
}

async function createLabelcopyPageInNotion(artist, titel) {
  if (!LABELCOPY_DB_ID) throw new Error("LABELCOPY_DB_ID fehlt in ENV.");
  const properties = buildNotionProps({ Artist: artist, Titel: titel });
  const created = await notion.pages.create({
    parent: { database_id: LABELCOPY_DB_ID },
    properties
  });
  return created.id;
}

async function extractLabelcopyFieldsFromText(text) {
  const allowed = ["Artist", "Titel", "Version", "Genre", "Time", "Recording Country", "Written by", "Published by", "Produced by", "Mastered by", "Mixed by", "Vocals by", "Programming by", "Bass by", "Drums by", "Keys by", "Synth by", "Splits", "Lyrics"];

  const extraction = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      {
        role: "system",
        content:
          `Extrahiere aus dem User-Text Labelcopy-Felder als JSON.\n` +
          `Sei flexibel bei Synonymen (z.B. "Mixer"/"Abmischung" => "Mixed by").\n` +
          `Erlaubte Keys: ${allowed.join(", ")}.\n` +
          `Wenn etwas nicht sicher ist, lass es weg.\n` +
          `Splits darf STRING oder Objekt sein (wird später konvertiert).\n` +
          `Gib NUR ein JSON-Objekt zurück.`
      },
      { role: "user", content: text }
    ],
    response_format: { type: "json_object" }
  });

  let obj = {};
  try { obj = JSON.parse(extraction.choices[0].message.content); } catch (e) { obj = {}; }
  obj = normalizeLabelcopyKeys(obj);
  return obj;
}

async function exportLabelcopyDocx(chatId, pageId) {
  const page = await notion.pages.retrieve({ page_id: pageId });
  const props = parseProperties(page.properties);

  const order = ["Artist", "Titel", "Version", "Genre", "Time", "Recording Country", "Written by", "Published by", "Produced by", "Mastered by", "Mixed by", "Vocals by", "Programming by", "Bass by", "Drums by", "Keys by", "Synth by", "Splits", "Lyrics"];
  const titleLine = `${props.Artist || "Artist"} – ${props.Titel || "Titel"}`;

  const doc = new Document({
    sections: [
      {
        properties: {},
        children: [
          new Paragraph({ children: [new TextRun({ text: `Labelcopy – ${titleLine}`, bold: true })] }),
          new Paragraph({ text: "" }),
          ...order.map((k) =>
            new Paragraph({
              children: [
                new TextRun({ text: `${k}: `, bold: true }),
                new TextRun({ text: props[k] || "" })
              ]
            })
          )
        ]
      }
    ]
  });

  const buffer = await Packer.toBuffer(doc);
  const safeArtist = (props.Artist || "Artist").replace(/[^\w\-]+/g, "_");
  const safeTitle = (props.Titel || "Titel").replace(/[^\w\-]+/g, "_");
  const filename = `Labelcopy_${safeArtist}_${safeTitle}.docx`;
  const filePath = path.join(os.tmpdir(), filename);

  fs.writeFileSync(filePath, buffer);
  await bot.sendDocument(chatId, filePath, { caption: `📄 Export: **${props.Artist || ""} – ${props.Titel || ""}**`, parse_mode: "Markdown" });

  try { fs.unlinkSync(filePath); } catch (e) {}
}


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

 // --- KALENDER LOGIK (VERSION: PRO-DISPLAY & INVITES) ---
  const textLower = text.toLowerCase();
  const session = activeSession.get(chatId);
  const calendarTriggers = ["termin", "kalender", "einplanen", "meeting", "woche", "heute", "morgen", "anstehen", "zeit", "plan", "session", "studio"];
  

  // --- LABELCOPY WORKFLOW (modular, ohne Kalender/Gmail/Airtable zu brechen) ---
  const lcTriggers = ["labelcopy anlegen", "lc anlegen"];
  const airtableTriggers = ["speichere", "adden", "adde", "hinzufügen", "eintragen"];

  // Start
  if (lcTriggers.some(t => textLower.includes(t))) {
    activeSession.set(chatId, { step: "awaiting_artist" });
    return "Alles klar! Welcher **Künstler**? 🎤";
  }

  // Session schließen
  if (session && (textLower.includes("fertig") || textLower.includes("abbrechen") || textLower.includes("cancel"))) {
    activeSession.delete(chatId);
    return "✅ Alles klar — Labelcopy-Session geschlossen.";
  }

  // Export
  if (session && session.step === "active" && (textLower.includes("exportieren") || textLower.includes("export"))) {
    try {
      await exportLabelcopyDocx(chatId, session.pageId);
      return "✅ Export ist raus. Wenn du noch was ändern willst: einfach schreiben (Session bleibt offen).";
    } catch (e) {
      console.error("Export Error:", e);
      return "❌ Export-Fehler. Prüfe `LABELCOPY_DB_ID` und Notion-Rechte.";
    }
  }

  // Während Session aktiv: Eingaben als Labelcopy-Daten interpretieren,
  // außer es ist klar ein globaler Kalender- oder Airtable-Speicher-Befehl.
  const looksLikeGlobalCalendar = calendarTriggers.some(word => textLower.includes(word)) && text.length > 5;
  const looksLikeAirtableSave = airtableTriggers.some(word => textLower.includes(word)) && !textLower.includes("termin");

  if (session && !looksLikeGlobalCalendar && !looksLikeAirtableSave) {
    if (session.step === "awaiting_artist") {
      session.artist = text.trim();
      session.step = "awaiting_title";
      activeSession.set(chatId, session);
      return `Notiert: **${session.artist}** ✅\nWie heißt der **Titel**?`;
    }

    if (session.step === "awaiting_title") {
      session.title = text.trim();
      try {
        const pageId = await createLabelcopyPageInNotion(session.artist, session.title);
        session.pageId = pageId;
        session.step = "active";
        activeSession.set(chatId, session);
        return await showFullMask(chatId, pageId);
      } catch (e) {
        console.error("Labelcopy Create Error:", e);
        activeSession.delete(chatId);
        return "❌ Konnte Labelcopy nicht anlegen. Prüfe `LABELCOPY_DB_ID` und Notion-Rechte.";
      }
    }

    if (session.step === "active") {
      try {
        const updateData = await extractLabelcopyFieldsFromText(text);
        if (updateData && Object.keys(updateData).length > 0) {
          await notion.pages.update({ page_id: session.pageId, properties: buildNotionProps(updateData) });
        }
        return await showFullMask(chatId, session.pageId);
      } catch (e) {
        console.error("Labelcopy Update Error:", e);
        return "❌ Konnte Felder nicht updaten. Versuch z.B. „Mixed by: Tobias“ oder „Splits 50/50“.";
      }
    }
  }


  if (calendarTriggers.some(word => textLower.includes(word)) && text.length > 5) {
    try {
      const extraction = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          { 
            role: "system", 
            content: `Du bist ein Kalender-Assistent. Heute ist ${new Date().toLocaleDateString('de-DE', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}.
            Künstler: ${calendarList.map(c => c.Name).join(", ")}.
            
            Aufgabe:
            1. type: "read" (Abfragen) oder "write" (Eintragen).
            2. artist: Name aus der Liste.
            3. start_iso & end_iso: ISO-Strings (YYYY-MM-DDTHH:mm:ss).
            4. title: Titel (nur write).
            5. attendees: Extrahiere E-Mail-Adressen, falls der User jemanden einladen will (als Array).
            
            Gib NUR JSON zurück.` 
          },
          { role: "user", content: text }
        ],
        response_format: { type: "json_object" }
      });

      const data = JSON.parse(extraction.choices[0].message.content);
      const artistEntry = calendarList.find(c => data.artist && c.Name.toLowerCase().trim() === data.artist.toLowerCase().trim());
      const calId = (artistEntry && artistEntry["Calendar ID"]) ? artistEntry["Calendar ID"].trim() : "mate.spellenberg.umusic@gmail.com";
      const artistName = artistEntry ? artistEntry.Name : (data.artist || "Mate");

      const formatForGoogle = (dateStr) => {
        if (!dateStr) return new Date().toISOString();
        return dateStr.length === 19 ? `${dateStr}Z` : dateStr;
      };

      // --- FALL A: TERMINE LESEN (MIT VERBESSERTER ANZEIGE) ---
      if (data.type === "read" || textLower.includes("wie sieht") || textLower.includes("was steht") || textLower.includes("zeit")) {
        const response = await calendar.events.list({
          calendarId: calId,
          timeMin: formatForGoogle(data.start_iso),
          timeMax: formatForGoogle(data.end_iso),
          singleEvents: true,
          orderBy: "startTime",
        });

        const events = response.data.items;
        if (!events || events.length === 0) return `📅 Keine Termine für **${artistName}** im Zeitraum gefunden.`;

        let list = `📅 **Termine für ${artistName}:**\n`;
        events.forEach(e => {
          const start = new Date(e.start.dateTime || e.start.date);
          const end = new Date(e.end.dateTime || e.end.date);
          
          // Formatierung Wochentag & Datum
          const dateStr = start.toLocaleString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' });
          
          // Prüfen ob Ganztägig oder Mehrtägig
          const isAllDay = !e.start.dateTime;
          const isMultiDay = (end - start) > 24 * 60 * 60 * 1000;

          if (isMultiDay) {
            const endStr = end.toLocaleString('de-DE', { day: '2-digit', month: '2-digit' });
            list += `• ${dateStr} bis ${endStr}: **${e.summary}** 🗓️\n`;
          } else {
            const timeStr = isAllDay ? "Ganztägig" : start.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
            list += `• ${dateStr} (${timeStr}): **${e.summary}**\n`;
          }
        });
        return list;
      } 
      
      // --- FALL B: TERMIN EINTRAGEN (MIT EINLADUNGEN) ---
      else {
        const event = {
          summary: data.title || "Neuer Termin",
          start: { dateTime: formatForGoogle(data.start_iso), timeZone: "Europe/Berlin" },
          end: { dateTime: formatForGoogle(data.end_iso) || new Date(new Date(formatForGoogle(data.start_iso)).getTime() + 60 * 60000).toISOString(), timeZone: "Europe/Berlin" },
          // Einladungen hinzufügen
          attendees: data.attendees ? data.attendees.map(email => ({ email })) : []
        };

        await calendar.events.insert({ 
          calendarId: calId, 
          resource: event,
          sendUpdates: data.attendees ? "all" : "none" // Verschickt Mails an Teilnehmer
        });

        let msg = `✅ Termin eingetragen für **${artistName}**\n📌 ${data.title}\n⏰ ${new Date(formatForGoogle(data.start_iso)).toLocaleString('de-DE')}`;
        if (data.attendees && data.attendees.length > 0) msg += `\n✉️ Einladungen an: ${data.attendees.join(", ")}`;
        return msg;
      }

    } catch (err) {
      console.error("Calendar Error:", err);
      return "❌ Kalender-Fehler. Bitte prüfe Künstler und Zeitraum.";
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
