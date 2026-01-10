"use strict";

const express = require("express");
const TelegramBot = require("node-telegram-bot-api");
const { Client: NotionClient } = require("@notionhq/client");
const OpenAI = require("openai");
const axios = require("axios");
const fs = require("fs");
const Airtable = require("airtable");
const { google } = require("googleapis"); 
// NEU: Für den Word-Export
const { Document, Packer, Paragraph, Table, TableRow, TableCell, WidthType, TextRun } = require("docx");

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
// NEU: Labelcopy DB ID
const DB_LABELCOPIES = "2e4c841ccef980d9ac9bf039d92565cc";
const AIRTABLE_BASE_ID = "appF535cRZRho6btT";

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN);
const notion = new NotionClient({ auth: NOTION_TOKEN });
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const airtableBase = new Airtable({ apiKey: AIRTABLE_API_KEY }).base(AIRTABLE_BASE_ID);

const chatContext = new Map();
// NEU: Session Management für Labelcopy
const activeSession = new Map(); 

const app = express();
app.use(express.json());

// --- HILFSFUNKTIONEN (BASIS) ---

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

// --- NEUE HELPER: LABELCOPY ---

function buildNotionProps(data) {
    const props = {};
    const notionFields = ["Artist", "Version", "Genre", "Time", "Recording Country", "Written by", "Published by", "Produced by", "Mastered by", "Mixed by", "Vocals by", "Programming by", "Bass by", "Drums by", "Keys by", "Synth by", "Splits", "Lyrics"];
    
    if (data.Titel) props["Titel"] = { title: [{ text: { content: String(data.Titel) } }] };
    
    // Iteriere über alle Felder und mappe sie
    notionFields.forEach(f => { 
        // Prüfe ob Daten da sind (auch lowercase Key Support)
        const incomingValue = data[f] || data[f.toLowerCase()];
        if (incomingValue !== undefined && incomingValue !== null) {
            let val = incomingValue;
            // Falls GPT ein Objekt/Array schickt, mache es zum String
            if (typeof val === 'object') {
                val = Object.entries(val).map(([k, v]) => `${k}: ${v}`).join("\n");
            }
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
        // Emoji Logik: Haken wenn voll, Kreuz wenn leer
        msg += val.trim() !== "" ? `✅ **${f}:** ${val}\n` : `❌ **${f}:** _noch leer_\n`;
    });
    msg += `----------------------------------\n`;
    msg += `👉 *Infos einfach hier reinschreiben (z.B. "Mix von Tobias").* \n`;
    msg += `👉 *Sagen Sie **"Exportieren"**, um das Word-File zu erhalten.*\n`;
    msg += `👉 *Sagen Sie **"Fertig"**, um die Session zu schließen.*`;
    return msg;
}

async function generateWordDoc(chatId, pageId) {
    const page = await notion.pages.retrieve({ page_id: pageId });
    const lc = parseProperties(page.properties);

    const doc = new Document({
        sections: [{
            children: [
                new Paragraph({ children: [new TextRun({ text: "Labelcopy", bold: true, size: 36 })], spacing: { after: 400 } }),
                ...["ISRC", "Artist", "Titel", "Version", "Genre", "Time", "Written by", "Published by", "Produced by", "Mastered by", "Recording Country"].map(f => 
                    new Paragraph({ children: [new TextRun({ text: `${f}: `, bold: true }), new TextRun(lc[f] || "")] })
                ),
                new Paragraph({ children: [new TextRun({ text: "Additional Credits:", bold: true })], spacing: { before: 200 } }),
                ...["Mixed by", "Vocals by", "Programming by", "Bass by", "Drums by", "Keys by", "Synth by"].map(f => 
                    new Paragraph({ children: [new TextRun({ text: `${f}: `, bold: true }), new TextRun(lc[f] || "")] })
                ),
                new Paragraph({ text: "Publisher Splits:", bold: true, spacing: { before: 400 } }),
                new Table({
                    width: { size: 100, type: WidthType.PERCENTAGE },
                    rows: (lc.Splits || "Writer 100%").split("\n").map(line => new TableRow({
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
    return "Hier ist dein Word-Dokument! 📄 Session beendet.";
}

// --- CORE LOGIK ---

async function handleChat(chatId, text) {
  const fetchSafely = async (id) => {
    try { return await fetchFullDatabase(id); } catch (e) { return []; }
  };

  const textLower = text.toLowerCase();
  let session = activeSession.get(chatId);

  // --- 1. LABELCOPY SESSION STEUERUNG (VOR ALLEM ANDEREN) ---
  
  // Abbruch
  if (session && (textLower === "fertig" || textLower === "session löschen")) {
      activeSession.delete(chatId);
      return "Check. Labelcopy-Session geschlossen. Ich bin wieder im normalen Modus.";
  }

  // Recall / Laden
  const recallTriggers = ["stand", "status", "zeig mir", "weiterarbeiten", "laden"];
  // Nur wenn KEINE Session aktiv ist und LC-Keywords fallen
  if (recallTriggers.some(t => textLower.includes(t)) && text.length > 5 && !session && (textLower.includes("lc") || textLower.includes("labelcopy") || textLower.includes("song"))) {
        const lcs = await fetchFullDatabase(DB_LABELCOPIES);
        const found = lcs.find(l => (l.Titel && textLower.includes(l.Titel.toLowerCase())) || (l.Artist && textLower.includes(l.Artist.toLowerCase())));
        if (found) {
            activeSession.set(chatId, { step: "confirm_recall", pendingPageId: found.id, artist: found.Artist, title: found.Titel });
            return `Ich habe eine Labelcopy gefunden: **${found.Artist} - ${found.Titel}**. \n\nMöchtest du an dieser weiterarbeiten? (Ja/Nein)`;
        }
  }

  // Recall Bestätigung
  if (session && session.step === "confirm_recall") {
      if (textLower.includes("ja") || textLower.includes("genau") || textLower.includes("yes")) {
          activeSession.set(chatId, { step: "active", pageId: session.pendingPageId, artist: session.artist, title: session.title });
          return await showFullMask(chatId, session.pendingPageId);
      } else {
          activeSession.delete(chatId);
          return "Alles klar, Suche abgebrochen.";
      }
  }

  // Neue LC anlegen
  if (textLower.includes("labelcopy anlegen") || textLower.includes("lc anlegen")) {
      activeSession.set(chatId, { step: "awaiting_artist" });
      return "Alles klar! Welcher **Künstler** soll es sein?";
  }

  // Aktiver LC Workflow
  if (session) {
      if (session.step === "awaiting_artist") {
          session.artist = text; session.step = "awaiting_title";
          activeSession.set(chatId, session);
          return `Notiert: **${text}**. Wie lautet der **Titel** des Songs?`;
      }
      
      if (session.step === "awaiting_title") {
          session.title = text; session.step = "active";
          // Presets laden (Optional, falls Config da ist)
          const configs = await fetchFullDatabase(DB_CONFIG);
          const rules = configs.find(c => c.Aufgabe === "Labelcopy Rules")?.Anweisung || "";
          
          const extraction = await openai.chat.completions.create({
              model: "gpt-4o",
              messages: [{ role: "system", content: `Regeln: ${rules}. Wenn Artist "${session.artist}" ist, fülle Presets. Gib JSON.` }, { role: "user", content: `Artist: ${session.artist}, Titel: ${session.title}` }],
              response_format: { type: "json_object" }
          });
          const presetData = JSON.parse(extraction.choices[0].message.content);
          
          const newPage = await notion.pages.create({ 
              parent: { database_id: DB_LABELCOPIES }, 
              properties: buildNotionProps({ ...presetData, Artist: session.artist, Titel: session.title }) 
          });
          
          session.pageId = newPage.id;
          activeSession.set(chatId, session);
          return await showFullMask(chatId, newPage.id);
      }

      if (textLower.includes("exportieren")) {
           const res = await generateWordDoc(chatId, session.pageId);
           activeSession.delete(chatId); 
           return res;
      }
      
      // Smart Input (Update der Felder)
      const extraction = await openai.chat.completions.create({
          model: "gpt-4o",
          messages: [
              { role: "system", content: "Extrahiere Infos für Labelcopy-Felder. Sei flexibel bei Begriffen (Abmischung=Mixed by etc.). 'Time' und 'Splits' sind Strings. Gib NUR JSON zurück." }, 
              { role: "user", content: text }
          ],
          response_format: { type: "json_object" }
      });
      const updateData = JSON.parse(extraction.choices[0].message.content);
      
      if (Object.keys(updateData).length > 0) {
          await notion.pages.update({ page_id: session.pageId, properties: buildNotionProps(updateData) });
          return await showFullMask(chatId, session.pageId);
      }
      // Falls nichts erkannt wurde, mache weiter im normalen Chat (Fallback)
  }

  // --- 2. BASIS LOGIK (KALENDER, AIRTABLE, CHAT) ---
  
  // Laden aller Daten (Original)
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

 // --- KALENDER LOGIK (Original) ---
  const calendarTriggers = ["termin", "kalender", "einplanen", "meeting", "woche", "heute", "morgen", "anstehen", "zeit", "plan", "session", "studio"];
  
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
          const dateStr = start.toLocaleString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' });
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
      else {
        const event = {
          summary: data.title || "Neuer Termin",
          start: { dateTime: formatForGoogle(data.start_iso), timeZone: "Europe/Berlin" },
          end: { dateTime: formatForGoogle(data.end_iso) || new Date(new Date(formatForGoogle(data.start_iso)).getTime() + 60 * 60000).toISOString(), timeZone: "Europe/Berlin" },
          attendees: data.attendees ? data.attendees.map(email => ({ email })) : []
        };

        await calendar.events.insert({ 
          calendarId: calId, 
          resource: event,
          sendUpdates: data.attendees ? "all" : "none" 
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
  
  // --- AIRTABLE SAVE (Original) ---
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

  // --- NORMALER CHAT / PITCH LOGIK (Original) ---
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

// --- BOT EVENTS & SERVER (Original) ---

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
