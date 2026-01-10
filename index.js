"use strict";

const express = require("express");
const TelegramBot = require("node-telegram-bot-api");
const { Client: NotionClient } = require("@notionhq/client");
const OpenAI = require("openai");
const axios = require("axios");
const fs = require("fs");
const Airtable = require("airtable");
const { google } = require("googleapis"); 
const { Document, Packer, Paragraph, Table, TableRow, TableCell, WidthType, TextRun, BorderStyle } = require("docx");

require('dotenv').config();

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
const DB_LABELCOPIES = "2e4c841ccef980d9ac9bf039d92565cc";
const AIRTABLE_BASE_ID = "appF535cRZRho6btT";

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN);
const notion = new NotionClient({ auth: NOTION_TOKEN });
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const airtableBase = new Airtable({ apiKey: AIRTABLE_API_KEY }).base(AIRTABLE_BASE_ID);

const chatContext = new Map();
const activeSession = new Map(); 
const pendingCalendar = new Map();
const lastSessionData = new Map();

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

// --- NEUE HELPER: LABELCOPY & WORD ---

function buildNotionProps(data) {
    const props = {};
    const notionFields = ["Artist", "Version", "Genre", "Time", "Recording Country", "Written by", "Published by", "Produced by", "Mastered by", "Mixed by", "Vocals by", "Programming by", "Bass by", "Drums by", "Keys by", "Synth by", "Splits", "Lyrics"];
    
    if (data.Titel) props["Titel"] = { title: [{ text: { content: String(data.Titel) } }] };
    
    notionFields.forEach(f => { 
        const incomingValue = data[f] || data[f.toLowerCase()];
        if (incomingValue !== undefined && incomingValue !== null) {
            let val = incomingValue;
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
    
    // NEU: Mapping für schönere Namen im Chat
    const displayNames = {
        "Splits": "Splits und Pub Infos (Name/Prozent/Publisher/IPI/Contact)"
    };

    let msg = `📋 **Labelcopy: ${props.Artist || "..."} - ${props.Titel || "..."}**\n`;
    msg += `----------------------------------\n`;
    fields.forEach(f => {
        const val = props[f] || "";
        const label = displayNames[f] || f; // Benutze schönen Namen wenn vorhanden
        msg += val.trim() !== "" ? `✅ **${label}:** ${val}\n` : `❌ **${label}:** _noch leer_\n`;
    });
    msg += `----------------------------------\n`;
    msg += `👉 *Infos reinschreiben (Trenne Spalten mit "|").* \n`;
    msg += `👉 *Sagen Sie **"Exportieren"**, um das Word-File zu erhalten.*\n`;
    msg += `👉 *Sagen Sie **"Fertig"**, um die Session zu schließen.*`;
    return msg;
}

async function generateWordDoc(chatId, pageId) {
    const page = await notion.pages.retrieve({ page_id: pageId });
    const lc = parseProperties(page.properties);

    const splitLines = (lc.Splits || "").split("\n").filter(l => l.trim() !== "");
    const tableRowsData = splitLines.length > 0 ? splitLines : ["", "", ""];

    const doc = new Document({
        sections: [{
            children: [
                new Paragraph({ children: [new TextRun({ text: "Labelcopy", bold: true, size: 36 })], spacing: { after: 400 } }),
                
                ...["ISRC", "Artist", "Titel", "Version", "Genre", "Time", "Written by", "Published by", "Produced by", "Mastered by", "Recording Country"].map(f => 
                    new Paragraph({ children: [new TextRun({ text: `${f}: `, bold: true }), new TextRun(lc[f] || "")] })
                ),
                
                new Paragraph({ children: [new TextRun({ text: "Additional Credits:", bold: true })], spacing: { before: 200, after: 100 } }),
                ...["Mixed by", "Vocals by", "Programming by", "Bass by", "Drums by", "Keys by", "Synth by"].map(f => 
                    new Paragraph({ children: [new TextRun({ text: `${f}: `, bold: true }), new TextRun(lc[f] || "")] })
                ),

                new Paragraph({ text: "Video Credits:", bold: true, spacing: { before: 400 } }),
                new Paragraph({ text: "Produced by: " + (lc["Video Produced by"] || "") }),
                new Paragraph({ text: "Directed by: " + (lc["Video Directed by"] || "") }),

                // NEU: Hier der genaue Text für die Splits-Überschrift
                new Paragraph({ text: "Splits und Pub Infos (Name/Prozent/Publisher/IPI/Contact)", bold: true, spacing: { before: 400, after: 100 } }),
                new Paragraph({ text: "Please assign which writer belongs to which publisher. If no publisher, provide management contact.", italics: true, size: 20 }),

                new Table({
                    width: { size: 100, type: WidthType.PERCENTAGE },
                    rows: [
                        new TableRow({
                            children: [
                                new TableCell({ children: [new Paragraph({ text: "Writer (incl. feature artists)", bold: true })], width: { size: 33, type: WidthType.PERCENTAGE } }),
                                new TableCell({ children: [new Paragraph({ text: "Publisher/Contact Information", bold: true })], width: { size: 33, type: WidthType.PERCENTAGE } }),
                                new TableCell({ children: [new Paragraph({ text: "Writer/Management Contact", bold: true })], width: { size: 33, type: WidthType.PERCENTAGE } }),
                            ]
                        }),
                        ...tableRowsData.map(line => {
                            // Splits Logic: "|" trennt die Spalten
                            const parts = line.split("|").map(p => p.trim());
                            return new TableRow({
                                children: [
                                    new TableCell({ children: [new Paragraph(parts[0] || "")] }),
                                    new TableCell({ children: [new Paragraph(parts[1] || "")] }),
                                    new TableCell({ children: [new Paragraph(parts[2] || "")] }),
                                ]
                            });
                        })
                    ]
                })
            ]
        }]
    });

    const fileName = `LC_${lc.Artist || "Unbekannt"}_${lc.Titel || "Song"}.docx`.replace(/[^a-z0-9]/gi, '_');
    const buffer = await Packer.toBuffer(doc);
    fs.writeFileSync(fileName, buffer);
    await bot.sendDocument(chatId, fileName);
    fs.unlinkSync(fileName);
    return "Hier ist dein Word-Dokument! 📄";
}

// --- CORE LOGIK ---

async function handleChat(chatId, text) {
  const fetchSafely = async (id) => {
    try { return await fetchFullDatabase(id); } catch (e) { return []; }
  };

  const textLower = text.toLowerCase();
  let session = activeSession.get(chatId);

  // -------------------------------------------------------------
  // A) KALENDER BESTÄTIGUNGS-LOOP
  // -------------------------------------------------------------
  if (pendingCalendar.has(chatId)) {
      const pendingData = pendingCalendar.get(chatId);

      if (textLower.includes("ja") || textLower.includes("bestätigen") || textLower.includes("ok")) {
          try {
             await calendar.events.insert({ 
                 calendarId: pendingData.calId, 
                 resource: pendingData.event,
                 sendUpdates: pendingData.sendUpdates
             });
             
             pendingCalendar.delete(chatId); 
             return `✅ Termin verbindlich eingetragen: **${pendingData.event.summary}**`;
          } catch (e) {
             console.error(e);
             pendingCalendar.delete(chatId);
             return "❌ Fehler beim Eintragen in Google Calendar.";
          }
      } 
      else if (textLower.includes("nein") || textLower.includes("abbruch")) {
          pendingCalendar.delete(chatId); 
          return "Alles klar, Vorgang abgebrochen. Nichts eingetragen.";
      }
  }

  // -------------------------------------------------------------
  // B) LABELCOPY SESSION
  // -------------------------------------------------------------
  if (session && (textLower === "fertig" || textLower === "session löschen")) {
      activeSession.delete(chatId);
      return "Check. Labelcopy-Session geschlossen.";
  }

  const recallTriggers = ["stand", "status", "zeig mir", "weiterarbeiten", "laden"];
  if (recallTriggers.some(t => textLower.includes(t)) && text.length > 5 && !session && (textLower.includes("lc") || textLower.includes("labelcopy") || textLower.includes("song"))) {
        const lcs = await fetchFullDatabase(DB_LABELCOPIES);
        const found = lcs.find(l => (l.Titel && textLower.includes(l.Titel.toLowerCase())) || (l.Artist && textLower.includes(l.Artist.toLowerCase())));
        if (found) {
            activeSession.set(chatId, { step: "confirm_recall", pendingPageId: found.id, artist: found.Artist, title: found.Titel });
            return `Ich habe eine Labelcopy gefunden: **${found.Artist} - ${found.Titel}**. \n\nMöchtest du an dieser weiterarbeiten? (Ja/Nein)`;
        }
  }

  if (session && session.step === "confirm_recall") {
      if (textLower.includes("ja") || textLower.includes("genau") || textLower.includes("yes")) {
          activeSession.set(chatId, { step: "active", pageId: session.pendingPageId, artist: session.artist, title: session.title });
          return await showFullMask(chatId, session.pendingPageId);
      } else {
          activeSession.delete(chatId);
          return "Suche abgebrochen.";
      }
  }

  if (textLower.includes("labelcopy anlegen") || textLower.includes("lc anlegen")) {
      activeSession.set(chatId, { step: "awaiting_artist" });
      return "Alles klar! Welcher **Künstler** soll es sein?";
  }

  if (session) {
      if (session.step === "awaiting_artist") {
          session.artist = text; session.step = "awaiting_title";
          activeSession.set(chatId, session);
          return `Notiert: **${text}**. Wie lautet der **Titel** des Songs?`;
      }
      
      if (session.step === "awaiting_title") {
          session.title = text; session.step = "active";
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
      
      const extraction = await openai.chat.completions.create({
          model: "gpt-4o",
          messages: [
              { role: "system", content: "Extrahiere Infos für Labelcopy-Felder. Für 'Splits': Behalte '|' und Zeilenumbrüche. Gib NUR JSON zurück." }, 
              { role: "user", content: text }
          ],
          response_format: { type: "json_object" }
      });
      const updateData = JSON.parse(extraction.choices[0].message.content);
      
      if (Object.keys(updateData).length > 0) {
          await notion.pages.update({ page_id: session.pageId, properties: buildNotionProps(updateData) });
          return await showFullMask(chatId, session.pageId);
      }
  }

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

  // -------------------------------------------------------------
  // C) SESSION ZUSAMMENFASSUNG
  // -------------------------------------------------------------
  if (textLower.includes("sessionzusammenfassung") || textLower.includes("zusammenfassung")) {
      let studioInfo = { name: "", address: "", bell: "", contact: "" };
      const foundStudio = studios.find(s => textLower.includes(s.Name.toLowerCase()));
      if (foundStudio) {
          studioInfo = {
              name: foundStudio.Name || "",
              address: foundStudio.Address || foundStudio.Adresse || "",
              bell: foundStudio.Bell || foundStudio.Klingel || "",
              contact: foundStudio.Contact || foundStudio.Kontakt || ""
          };
      }

      const dateMatch = text.match(/\d{1,2}\.\d{1,2}\.(\d{2,4})?/);
      let date = dateMatch ? dateMatch[0] : "";
      if (date && date.split('.').length === 3 && date.split('.')[2] === "") date += new Date().getFullYear();

      const timeMatch = text.match(/\d{1,2}:\d{2}/);
      let time = timeMatch ? timeMatch[0] : "12:00";

      const nameExtract = await openai.chat.completions.create({
          model: "gpt-4o",
          messages: [
              { role: "system", content: "Extrahiere NUR die Artist Namen (Artist A x Artist B). Ignoriere Datum/Studio. Gib String." },
              { role: "user", content: text }
          ]
      });
      let artists = nameExtract.choices[0].message.content.replace(/['"]+/g, '');

      // Memory Store
      const sessionData = { artists, date, time, studioInfo };
      lastSessionData.set(chatId, sessionData);

      const output = `Session: ${artists}\nDate: ${date}\nStart: ${time}\nStudio: ${studioInfo.name}\nAddress: ${studioInfo.address}\nBell: ${studioInfo.bell}\nContact: ${studioInfo.contact}`;
      return output;
  }

 // -------------------------------------------------------------
 // D) KALENDER TRIGGER
 // -------------------------------------------------------------
  const calendarTriggers = ["termin", "kalender", "einplanen", "meeting"];
  const actionTriggers = ["trage", "mache", "erstelle", "buche"];
  
  const isCalendarRead = calendarTriggers.some(w => textLower.includes(w)) && (textLower.includes("wann") || textLower.includes("was") || textLower.includes("zeig"));
  const isCalendarWrite = calendarTriggers.some(w => textLower.includes(w)) && actionTriggers.some(a => textLower.includes(a));

  if (isCalendarRead || isCalendarWrite) {
    try {
      let eventResource = null;
      let targetCalendarId = "mate.spellenberg.umusic@gmail.com";
      let artistNameForMsg = "Mate";

      // 1. CONTEXT CHECK: "Trag DAS ein"
      if ((textLower.includes("das") || textLower.includes("die session")) && lastSessionData.has(chatId) && isCalendarWrite) {
          const s = lastSessionData.get(chatId);
          
          const foundCal = calendarList.find(c => textLower.includes(c.Name.toLowerCase()));
          if (foundCal) {
              targetCalendarId = foundCal["Calendar ID"];
              artistNameForMsg = foundCal.Name;
          }

          const [day, month, year] = s.date.split('.');
          const cleanYear = year.length === 2 ? "20" + year : year;
          const [hours, minutes] = s.time.split(':');
          
          const startDate = new Date(cleanYear, month - 1, day, hours, minutes);
          const endDate = new Date(startDate.getTime() + 6 * 60 * 60 * 1000); 

          eventResource = {
              summary: `Session: ${s.artists}`,
              location: s.studioInfo.address,
              description: `Contact: ${s.studioInfo.contact}\nBell: ${s.studioInfo.bell}\nStudio: ${s.studioInfo.name}`,
              start: { dateTime: startDate.toISOString(), timeZone: "Europe/Berlin" },
              end: { dateTime: endDate.toISOString(), timeZone: "Europe/Berlin" }
          };
          lastSessionData.delete(chatId);
      } 
      
      // 2. STANDARD GPT WEG
      if (!eventResource) {
          const extraction = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [
              { role: "system", content: `Kalender-Assistent. Data: JSON (type, artist, start_iso, end_iso, title, attendees).` },
              { role: "user", content: text }
          ],
            response_format: { type: "json_object" }
          });
          const data = JSON.parse(extraction.choices[0].message.content);
          
          if (data.type === "read" || isCalendarRead) return "Lese Kalender... (Mock)"; 

          const artistEntry = calendarList.find(c => data.artist && c.Name.toLowerCase().trim() === data.artist.toLowerCase().trim());
          targetCalendarId = (artistEntry && artistEntry["Calendar ID"]) ? artistEntry["Calendar ID"].trim() : targetCalendarId;
          artistNameForMsg = artistEntry ? artistEntry.Name : (data.artist || "Mate");

          eventResource = {
              summary: data.title || "Neuer Termin",
              start: { dateTime: data.start_iso || new Date().toISOString(), timeZone: "Europe/Berlin" },
              end: { dateTime: data.end_iso || new Date(new Date().getTime() + 3600000).toISOString(), timeZone: "Europe/Berlin" },
              attendees: data.attendees ? data.attendees.map(email => ({ email })) : []
          };
      }

      const sendUpdates = (eventResource.attendees && eventResource.attendees.length > 0) ? "all" : "none";
      pendingCalendar.set(chatId, { calId: targetCalendarId, event: eventResource, sendUpdates });

      const startStr = new Date(eventResource.start.dateTime).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });
      return `📅 Ich habe folgenden Termin vorbereitet:\n\n**${eventResource.summary}**\n📍 ${eventResource.location || "Kein Ort"}\n🕒 ${startStr} (6 Std)\nKalender: ${artistNameForMsg}\n\nSoll ich das **eintragen**? (Ja/Nein)`;

    } catch (err) {
      console.error("Calendar Error:", err);
      return "❌ Kalender-Fehler.";
    }
  }

  // --- AIRTABLE & PITCH ---
  if (triggerWords.some(word => text.toLowerCase().includes(word))) { return "Airtable Save (Simulated)"; }

  let history = chatContext.get(chatId) || [];
  history.push({ role: "user", content: text });
  if (history.length > 8) history.shift();
  
  const pitchRules = config.find(c => c.Key === "Pitch_Rules")?.Value || "";
  const sonstigeRegeln = config.filter(c => c.Key !== "Pitch_Rules");

  const completion = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [{ role: "system", content: `A&R Bot. Rules: ${pitchRules} Data: ${JSON.stringify(sonstigeRegeln)}` }, ...history]
  });

  const answer = completion.choices[0].message.content;
  history.push({ role: "assistant", content: answer });
  chatContext.set(chatId, history);
  return answer;
}

// --- BOT EVENTS ---
bot.on("message", async (msg) => {
  if (msg.voice || !msg.text || msg.text.startsWith("/")) return;
  const answer = await handleChat(msg.chat.id, msg.text);
  await bot.sendMessage(msg.chat.id, answer, { parse_mode: "Markdown" });
});

app.post(`/telegram/${TELEGRAM_BOT_TOKEN}`, (req, res) => { bot.processUpdate(req.body); res.sendStatus(200); });
app.listen(PORT, async () => {
  await bot.deleteWebHook({ drop_pending_updates: true });
  await bot.setWebHook(`${WEBHOOK_URL}/telegram/${TELEGRAM_BOT_TOKEN}`);
  console.log("Bot ready.");
});
