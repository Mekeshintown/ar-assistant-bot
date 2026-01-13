"use strict";

const express = require("express");
const TelegramBot = require("node-telegram-bot-api");
const { Client: NotionClient } = require("@notionhq/client");
const OpenAI = require("openai");
const axios = require("axios");
const fs = require("fs");
const Airtable = require("airtable");
const { google } = require("googleapis"); 

// DIESE ZEILE HIER IST NEU UND WICHTIG FÜR DIE LABELCOPY:
const { Document, Packer, Paragraph, Table, TableRow, TableCell, WidthType, TextRun } = require("docx");

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
const pendingCalendar = new Map(); // Für die Sicherheits-Schleife
const pendingAirtable = new Map(); // Für die Airtable-Bestätigung
const lastSessionData = new Map(); // Für das Session-Gedächtnis
const activeSession = new Map();
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

// --- LC HELPER: Baut die Notion-Datenstruktur ---
function buildNotionProps(data) {
    const props = {};
    const fields = ["Artist", "Version", "Genre", "Time", "Recording Country", "Written by", "Published by", "Produced by", "Mastered by", "Mixed by", "Vocals by", "Programming by", "Bass by", "Drums by", "Keys by", "Synth by", "Splits", "Lyrics"];
    
    if (data.Titel) props["Titel"] = { title: [{ text: { content: String(data.Titel) } }] };
    
    fields.forEach(f => { 
        const val = data[f] || data[f.toLowerCase()];
        if (val !== undefined && val !== null) {
            props[f] = { rich_text: [{ text: { content: String(val) } }] }; 
        }
    });
    return props;
}

// --- LC HELPER: Zeigt die Maske in Telegram ---
async function showFullMask(chatId, pageId) {
    const page = await notion.pages.retrieve({ page_id: pageId });
    const props = parseProperties(page.properties);
    const fields = ["Artist", "Titel", "Version", "Genre", "Time", "Recording Country", "Written by", "Published by", "Produced by", "Mastered by", "Mixed by", "Vocals by", "Programming by", "Bass by", "Drums by", "Keys by", "Synth by", "Splits", "Lyrics"];
    
    let msg = `📋 **Labelcopy: ${props.Artist || "..." } - ${props.Titel || "..."}**\n`;
    msg += `----------------------------------\n`;
    fields.forEach(f => {
        const val = props[f] || "";
        msg += val.trim() !== "" ? `✅ **${f}:** ${val}\n` : `❌ **${f}:** _noch leer_\n`;
    });
    msg += `----------------------------------\n`;
    msg += `👉 *Infos einfach hier reinschreiben.* \n`;
    msg += `👉 *Sagen Sie **"Exportieren"**, um das Word-File zu erhalten.*\n`;
    msg += `👉 *Sagen Sie **"Fertig"**, um die Session zu schließen.*`;
    return msg;
}

// --- LC HELPER: Erstellt das Word-Dokument ---
async function generateWordDoc(chatId, pageId) {
    const page = await notion.pages.retrieve({ page_id: pageId });
    const lc = parseProperties(page.properties);
    const doc = new Document({
        sections: [{
            children: [
                new Paragraph({ children: [new TextRun({ text: "Labelcopy", bold: true, size: 36 })], spacing: { after: 400 } }),
                ...["Artist", "Titel", "Version", "Genre", "Time", "Written by", "Published by", "Produced by", "Mastered by", "Recording Country"].map(f => 
                    new Paragraph({ children: [new TextRun({ text: `${f}: `, bold: true }), new TextRun(lc[f] || "")] })
                )
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


async function handleChat(chatId, text) {
  const fetchSafely = async (id) => {
    try { return await fetchFullDatabase(id); } catch (e) { return []; }
  };
  
const textLower = text.toLowerCase();
const DB_LABELCOPIES = "2e4c841ccef980d9ac9bf039d92565cc"; // Stelle sicher, dass die ID stimmt
let session = activeSession.get(chatId);
  
  // --- UNIVERSAL HELPER: MENÜ TEXT GENERIEREN ---
const renderMenu = (pendingData) => {
      const evt = pendingData.event;
      
      // DATUM: Wir nehmen einfach das, was im String steht (YYYY-MM-DD)
      const dPart = (evt.start.dateTime || "").split('T')[0] || "2026-01-01";
      const [y, m, d] = dPart.split('-');
      const dateStr = `${d}.${m}.${y}`;
      
      let timeStr = "Ganztägig";
      if (evt.start.dateTime) {
          // Wir schneiden die Zeit direkt aus dem ISO-String aus: "12:00:00" -> "12:00"
          const sTime = evt.start.dateTime.split('T')[1].substring(0, 5);
          const eTime = evt.end.dateTime.split('T')[1].substring(0, 5);
          timeStr = `${sTime} - ${eTime}`;
      }

      const guests = (evt.attendees || []).map(a => a.email).join(", ") || "-";

      return `📝 **Termin-Entwurf**\n\n` +
             `**Kalender:** ${pendingData.calName || "Mate"}\n` + 
             `**Titel:** ${evt.summary}\n` +
             `**Date:** ${dateStr}\n` +
             `**Zeit:** ${timeStr}\n` +
             `**Ort:** ${evt.location || "-"}\n` +
             `**Beschreibung:** ${evt.description || "-"}\n` +
             `**Einladen:** ${guests}\n\n` +
             `👉 *Ändern mit z.B.: "Zeit 14-16", "Ort Berlin"*\n\n` +
             `✅ **Ja** (Eintragen)\n` +
             `❌ **Abbruch** (Löschen)`;
  };
  
  
// --- 1. SICHERHEITS-LOOP & MENÜ-MODUS ---
  
  // A) AIRTABLE BESTÄTIGUNG
  if (pendingAirtable.has(chatId)) {
      const pending = pendingAirtable.get(chatId);
      if (textLower === "ja" || textLower === "ok") {
          try {
              // Erstellt den Eintrag in der extrahierten Tabelle (Artist Pitch oder Label Pitch)
              await airtableBase(pending.table).create([{ fields: pending.fields }]);
              pendingAirtable.delete(chatId);
              return `✅ Erfolgreich in **${pending.table}** gespeichert!`;
          } catch (e) { 
              console.error("Airtable Error:", e.message);
              return "❌ Airtable Fehler: " + e.message; 
          }
      } else if (textLower === "nein" || textLower === "abbruch") {
          pendingAirtable.delete(chatId);
          return "Speichern abgebrochen.";
      }
      // Falls der User während eines offenen Entwurfs etwas anderes schreibt, lassen wir den Loop offen
  }
  
  // B) KALENDER BESTÄTIGUNG (Dein bestehender Code)
  if (pendingCalendar.has(chatId)) {
      const pendingData = pendingCalendar.get(chatId);

      // A) BESTÄTIGEN
      if (textLower === "ja" || textLower === "ok" || textLower === "bestätigen") {
          try {
             await calendar.events.insert({ 
                 calendarId: pendingData.calId, 
                 resource: pendingData.event, 
                 sendUpdates: pendingData.sendUpdates 
             });
             pendingCalendar.delete(chatId); 
             return `✅ **Termin wurde eingetragen!**`;
          } catch (e) { 
             console.error(e); 
             return "❌ Fehler von Google: " + e.message; 
          }
      } 
      // B) ABBRECHEN
      else if (textLower === "nein" || textLower === "abbruch") {
          pendingCalendar.delete(chatId); 
          return "Abgebrochen.";
      }
      // C) UPDATES (Das Menü bearbeiten)
      else {
          let updated = false;
          const val = text.replace(/^(titel|title|date|datum|zeit|time|ort|location|beschreibung|desc|einladen|invite)[:\s]+/i, "").trim();

          if (textLower.startsWith("titel") || textLower.startsWith("title")) { pendingData.event.summary = val; updated = true; }
          else if (textLower.startsWith("ort") || textLower.startsWith("location")) { pendingData.event.location = val; updated = true; }
          else if (textLower.startsWith("beschreibung") || textLower.startsWith("desc")) { pendingData.event.description = val; updated = true; }
          else if (textLower.startsWith("einladen") || textLower.startsWith("invite")) {
              const newEmails = text.match(/([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9._-]+)/g);
              if (newEmails) {
                  const current = pendingData.event.attendees || [];
                  newEmails.forEach(email => current.push({ email }));
                  pendingData.event.attendees = current;
                  pendingData.sendUpdates = "all";
                  updated = true;
              }
          }
        else if (textLower.startsWith("zeit") || textLower.startsWith("time")) {
              const times = text.match(/(\d{1,2})[:.]?(\d{2})?/g);
              if (times && times.length >= 1) {
                  const dStart = new Date(pendingData.event.start.dateTime || pendingData.event.start.date || new Date());
                  let [h1, m1] = times[0].replace('.',':').split(':');
                  dStart.setHours(parseInt(h1), m1 ? parseInt(m1) : 0);
                  const dEnd = new Date(dStart);
                  if (times.length >= 2) {
                       let [h2, m2] = times[1].replace('.',':').split(':');
                       dEnd.setHours(parseInt(h2), m2 ? parseInt(m2) : 0);
                  } else { dEnd.setHours(dStart.getHours() + 1); }

                  // Hilfsfunktion für Text-ISO (kein Zeitzonen-Shift)
                  const toIsoText = (d) => {
                      return d.getFullYear() + "-" + 
                             String(d.getMonth()+1).padStart(2, '0') + "-" + 
                             String(d.getDate()).padStart(2, '0') + "T" + 
                             String(d.getHours()).padStart(2, '0') + ":" + 
                             String(d.getMinutes()).padStart(2, '0') + ":00";
                  };

                  pendingData.event.start = { dateTime: toIsoText(dStart), timeZone: 'Europe/Berlin' };
                  pendingData.event.end = { dateTime: toIsoText(dEnd), timeZone: 'Europe/Berlin' };
                  updated = true;
              }
          } // <--- Diese Klammer hat bei dir vermutlich gefehlt!
          else if (textLower.startsWith("date") || textLower.startsWith("datum")) {
               const dateMatch = text.match(/(\d{1,2})\.(\d{1,2})\.?(\d{2,4})?/);
               if (dateMatch) {
                  const day = parseInt(dateMatch[1]); const month = parseInt(dateMatch[2]);
                  let year = dateMatch[3] ? (dateMatch[3].length === 2 ? "20" + dateMatch[3] : dateMatch[3]) : new Date().getFullYear();
                  
                  const updateISO = (iso) => {
                      const d = new Date(iso || new Date());
                      d.setFullYear(parseInt(year), month - 1, day);
                      return d.getFullYear() + "-" + String(d.getMonth()+1).padStart(2,'0') + "-" + String(d.getDate()).padStart(2,'0') + "T" + String(d.getHours()).padStart(2,'0') + ":" + String(d.getMinutes()).padStart(2,'0') + ":00";
                  };
                  
                  pendingData.event.start.dateTime = updateISO(pendingData.event.start.dateTime);
                  pendingData.event.end.dateTime = updateISO(pendingData.event.end.dateTime);
                  updated = true;
               }
          }

          if (updated) {
              pendingCalendar.set(chatId, pendingData);
              return renderMenu(pendingData);
          }
      }
  }

  // --- LABELCOPY SESSION MODUS ---
  session = activeSession.get(chatId);

  if (session && (textLower === "fertig" || textLower === "session löschen")) {
      activeSession.delete(chatId);
      return "Check. Labelcopy-Session geschlossen.";
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
// Holt die spezifischen Regeln aus der Config-Datenbank
    const configs = await fetchFullDatabase(DB_CONFIG);
    const lcRules = configs.find(c => c.Aufgabe === "Labelcopy Rules")?.Anweisung || "";
    
const extraction = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
        { 
            role: "system", 
            content: `Du bist ein Assistent für Musik-Metadaten. 
            Extrahiere Infos für die Felder: Artist, Version, Genre, Time, Recording Country, Written by, Published by, Produced by, Mastered by, Mixed by, Vocals by, Programming by, Bass by, Drums by, Keys by, Synth by, Splits, Lyrics.
            SEI FLEXIBEL: Wenn der User schreibt "Mastering hat XY gemacht" oder "Mix von XY", ordne es 'Mastered by' oder 'Mixed by' zu. Du brauchst keinen Doppelpunkt.
            Gib NUR JSON zurück.` 
        }, 
        { role: "user", content: text }
    ],
    response_format: { type: "json_object" }
});
          
          const newPage = await notion.pages.create({ 
              parent: { database_id: DB_LABELCOPIES }, 
              properties: buildNotionProps({ Artist: session.artist, Titel: session.title }) 
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
          messages: [{ role: "system", content: "Extrahiere Labelcopy-Infos. Gib NUR JSON." }, { role: "user", content: text }],
          response_format: { type: "json_object" }
      });
      const updateData = JSON.parse(extraction.choices[0].message.content);
      if (Object.keys(updateData).length > 0) {
          await notion.pages.update({ page_id: session.pageId, properties: buildNotionProps(updateData) });
          return await showFullMask(chatId, session.pageId);
      }
  }
  
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
  
// --- 2. SESSION ZUSAMMENFASSUNG & SMART UPDATES ---
  
// A) Zusammenfassung erstellen
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

      const sessionConfig = config.find(c => c.Aufgabe === "Sessions")?.Anweisung || "";
     
    // Erkennt jetzt "25.01", "25.01.", "am 25.1" etc.
      const dateMatch = text.match(/(\d{1,2})\.(\d{1,2})\.?(\d{2,4})?/);
      let date = "";
      const currentYear = new Date().getFullYear();

      if (dateMatch) {
          const d = dateMatch[1].padStart(2, '0');
          const m = dateMatch[2].padStart(2, '0');
          // Falls Jahr fehlt oder nur 2 Stellen hat (z.B. 26), wird es zu 2026 ergänzt
          let y = dateMatch[3] ? (dateMatch[3].length === 2 ? "20" + dateMatch[3] : dateMatch[3]) : currentYear.toString();
          date = `${d}.${m}.${y}`;
      } else {
          // Fallback auf heute, falls gar kein Datum im Satz steht
          const now = new Date();
          date = `${String(now.getDate()).padStart(2, '0')}.${String(now.getMonth()+1).padStart(2, '0')}.${currentYear}`;
      }
      
      const timeMatch = text.match(/\d{1,2}:\d{2}/);
      let time = timeMatch ? timeMatch[0] : "12:00"; 

      const nameExtract = await openai.chat.completions.create({ 
          model: "gpt-4o", 
          messages: [ { role: "system", content: "Extrahiere NUR die Artist Namen (Artist A x Artist B). Ignoriere Datum/Studio. Gib String." }, { role: "user", content: text } ] 
      });
      let artists = nameExtract.choices[0].message.content.replace(/['"]+/g, '');

      const sessionData = { artists, date, time, studioInfo };
      lastSessionData.set(chatId, sessionData);

      return `Session: ${artists}\nDate: ${date}\nStart: ${time}\nStudio: ${studioInfo.name}\nAddress: ${studioInfo.address}\nBell: ${studioInfo.bell}\nContact: ${studioInfo.contact}`;
  }

  // B) FLEXIBLES UPDATE (Bell, Start, Contact, Studio, Date)
  // Wir prüfen, ob wir eine aktive Session haben und der User ein Keyword nennt
  if (lastSessionData.has(chatId)) {
      const s = lastSessionData.get(chatId);
      let updated = false;

      // Logik: "Keyword: Wert" oder "Keyword Wert"
      if (textLower.startsWith("contact") || textLower.startsWith("kontakt")) {
          const searchName = text.replace(/contact|kontakt/i, "").replace(":", "").trim();
          const foundArtist = artistInfos.find(a => a.Name.toLowerCase().includes(searchName.toLowerCase()));
          if (foundArtist) {
             s.studioInfo.contact = `${foundArtist.Telefonnummer || foundArtist.Phone || ""} (${foundArtist.Name})`;
             updated = true;
          } else {
             s.studioInfo.contact = searchName; // Manuelle Eingabe
             updated = true;
          }
      }
      else if (textLower.startsWith("bell") || textLower.startsWith("klingel")) {
          s.studioInfo.bell = text.replace(/bell|klingel/i, "").replace(":", "").trim();
          updated = true;
      }
      else if (textLower.startsWith("start") || textLower.startsWith("zeit")) {
          s.time = text.replace(/start|zeit/i, "").replace(":", "").trim();
          updated = true;
      }
      else if (textLower.startsWith("date") || textLower.startsWith("datum")) {
          s.date = text.replace(/date|datum/i, "").replace(":", "").trim();
          updated = true;
      }
      else if (textLower.startsWith("studio")) {
          s.studioInfo.name = text.replace(/studio/i, "").replace(":", "").trim();
          updated = true;
      }

      if (updated) {
          lastSessionData.set(chatId, s);
          return `Update übernommen.\n\nSession: ${s.artists}\nDate: ${s.date}\nStart: ${s.time}\nStudio: ${s.studioInfo.name}\nAddress: ${s.studioInfo.address}\nBell: ${s.studioInfo.bell}\nContact: ${s.studioInfo.contact}`;
      }
  }

// C) Trigger "Trag das ein" (Verbindung zum Kalender)
  // Reagiert jetzt auf: "trag das", "trag ein", "trag session", "trage ein"
  if (textLower.includes("trag") && (textLower.includes("das") || textLower.includes("session") || textLower.includes("ein")) && lastSessionData.has(chatId)) {
      const s = lastSessionData.get(chatId);
      
      let targetCalId = "mate.spellenberg.umusic@gmail.com";
      let calName = "Mate";
      const foundCal = calendarList.find(c => textLower.includes(c.Name.toLowerCase()));
      if (foundCal) { targetCalId = foundCal["Calendar ID"]; calName = foundCal.Name; }
      
      // 1. DATUM-TEILE EXTRAHIEREN
      let [day, month, year] = (s.date || "").split('.');
      const serverYear = new Date().getFullYear().toString();
      if (!year || year.length < 4) year = serverYear;
      
      const cleanDate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const [hours, minutes] = s.time.split(':');
      
      // 2. START-ZEIT ALS REINER TEXT (Kein Date-Objekt!)
      const startIso = `${cleanDate}T${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:00`;
      
      // 3. END-ZEIT MANUELL BERECHNEN (+6 Stunden)
      // Wir rechnen nur mit der Zahl, damit JavaScript keine Zeitzonen einmischt
      let endHours = parseInt(hours) + 6;
      let endDay = parseInt(day);
      let endMonth = parseInt(month);
      let endYear = parseInt(year);

      // Falls die Session über Mitternacht geht (sehr wichtig!)
      if (endHours >= 24) {
          endHours -= 24;
          // Einfache Logik für den nächsten Tag (reicht für Sessions meist aus)
          const tempDate = new Date(endYear, endMonth - 1, endDay + 1);
          endDay = tempDate.getDate();
          endMonth = tempDate.getMonth() + 1;
          endYear = tempDate.getFullYear();
      }

      const cleanEndDate = `${endYear}-${String(endMonth).padStart(2, '0')}-${String(endDay).padStart(2, '0')}`;
      const endIso = `${cleanEndDate}T${String(endHours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:00`;
      
      const eventResource = { 
          summary: `Session: ${s.artists}`, 
          location: s.studioInfo.address, 
          description: `Contact: ${s.studioInfo.contact}\nBell: ${s.studioInfo.bell}\nStudio: ${s.studioInfo.name}`, 
          start: { dateTime: startIso, timeZone: "Europe/Berlin" }, 
          end: { dateTime: endIso, timeZone: "Europe/Berlin" } 
      };

      const pendingData = { calId: targetCalId, calName: calName, event: eventResource, sendUpdates: "none" };
      pendingCalendar.set(chatId, pendingData);
      lastSessionData.delete(chatId);

      return renderMenu(pendingData);
  }

// --- 3. AIRTABLE LOGIK (PRÄZISE EXTRAKTION) ---
const airtableTriggers = ["speichere", "adden", "adde", "hinzufügen", "eintragen", "airtable"];
if (airtableTriggers.some(word => textLower.includes(word)) && !textLower.includes("termin") && !textLower.includes("kalender")) {
    try {
        const extraction = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [
                { 
                    role: "system", 
                    content: `Du bist ein Daten-Extraktor für Airtable.
                    
                    WICHTIGE UNTERSCHEIDUNG:
                    - Artist_Name: Der Name des Musikers/Künstlers (z.B. Eli Brown).
                    - Contact_FirstName / Contact_LastName: Der Name des Managers oder Ansprechpartners (z.B. Matt Verovkins).
                    
                    Tabellen & Felder:
                    1. "Artist Pitch": Artist_Name, Contact_FirstName, Contact_LastName, Email, Genre, Prio.
                    2. "Label Pitch": Label_Name, Contact_FirstName, Contact_LastName, Email, Type, Prio.
                    
                    Regeln:
                    - Trenne Namen wie "Matt Verovkins" immer in Vor- und Nachname auf.
                    - Wenn ein Musiker genannt wird, ist das der Artist_Name.
                    Gib NUR JSON zurück: {"table": "...", "fields": {...}}` 
                },
                { role: "user", content: text }
            ],
            response_format: { type: "json_object" }
        });

      const result = JSON.parse(extraction.choices[0].message.content);

// FIX: Wandelt Genre-Strings in Listen um, damit Airtable sie akzeptiert
    if (result.fields.Genre && typeof result.fields.Genre === "string") {
    result.fields.Genre = result.fields.Genre.split(',').map(g => g.trim());
}
        pendingAirtable.set(chatId, result);
      
        let summary = `📋 **Airtable-Entwurf (${result.table})**\n\n`;
        // Wir zeigen die Felder schön sortiert an
        if (result.fields.Artist_Name) summary += `**Artist:** ${result.fields.Artist_Name}\n`;
        if (result.fields.Label_Name) summary += `**Label:** ${result.fields.Label_Name}\n`;
        summary += `**Kontakt:** ${result.fields.Contact_FirstName || ""} ${result.fields.Contact_LastName || ""}\n`;
        if (result.fields.Email) summary += `**Email:** ${result.fields.Email}\n`;
        if (result.fields.Genre) summary += `**Genre:** ${result.fields.Genre}\n`;
        if (result.fields.Prio) summary += `**Prio:** ${result.fields.Prio}\n`;
        if (result.fields.Type) summary += `**Type:** ${result.fields.Type}\n`;

        return summary + `\n✅ **Ja** zum Speichern\n❌ **Abbruch**`;
    } catch (e) { 
        console.error("Airtable Extraktion Error:", e);
        return "❌ Fehler bei der Airtable-Extraktion."; 
    }
}

// --- 4. KALENDER LOGIK (ALLGEMEIN) ---
const calendarTriggers = ["termin", "kalender", "einplanen", "meeting", "woche", "heute", "morgen", "anstehen", "zeit", "plan", "session", "studio", "buchen", "eintragen"];

if (calendarTriggers.some(word => textLower.includes(word)) && text.length > 5 && !textLower.includes("trag")) {
  try {
    const extraction = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { 
          role: "system", 
          content: `Kalender-Assistent. Heute ist der ${new Date().toLocaleDateString('de-DE')}. 
          Regeln:
          1. Wenn der User kein Jahr nennt, nimm IMMER das Jahr von heute (${new Date().getFullYear()}).
          2. Wenn der User fragt "wie sieht es aus", "was steht an" -> type: "read".
          3. Wenn er "eintragen", "buchen" sagt -> type: "write".
          4. Erfinde KEINE Titel oder Daten. Wenn Infos fehlen, lass sie leer.
          Data: JSON (type, artist, start_iso, end_iso, title, attendees).` 
        },
        { role: "user", content: text }
      ],
      response_format: { type: "json_object" }
    });

    const data = JSON.parse(extraction.choices[0].message.content);
    
    // Kalender suchen
    const artistEntry = calendarList.find(c => {
        const searchName = (data.artist || "").toLowerCase().trim();
        const dbName = (c.Name || "").toLowerCase().trim();
        return searchName && dbName.includes(searchName);
    });

    const calId = (artistEntry && artistEntry["Calendar ID"]) ? artistEntry["Calendar ID"].trim() : "mate.spellenberg.umusic@gmail.com";
    const artistName = artistEntry ? artistEntry.Name : (data.artist || "Mate");

    const formatForGoogle = (dateStr) => {
      if (!dateStr) return new Date().toISOString();
      if (dateStr.length === 10) return `${dateStr}T00:00:00Z`;
      return dateStr.length === 19 ? `${dateStr}Z` : dateStr;
    };

    // --- FALL A: LESEN (Wochenübersicht) ---
    if (data.type === "read" || textLower.includes("wie sieht") || textLower.includes("was steht")) {
      const response = await calendar.events.list({
        calendarId: calId,
        timeMin: formatForGoogle(data.start_iso),
        timeMax: formatForGoogle(data.end_iso),
        singleEvents: true,
        orderBy: "startTime",
      });

      const events = response.data.items;
      if (!events || events.length === 0) return `📅 Keine Termine für **${artistName}** gefunden.`;

      const eventList = events.map(e => {
        const start = new Date(e.start.dateTime || e.start.date);
        const startStr = start.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' });
        
        let timeStr = "";
        if (e.start.dateTime) {
          timeStr = ` (${start.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })})`;
        }

        // Urlaubs-/Mehrtages-Logik
        if (e.end && (e.end.date || e.end.dateTime)) {
          const endDate = new Date(e.end.dateTime || e.end.date);
          if (endDate - start > 86400000) {
            const endDisplay = new Date(endDate.getTime() - 1000).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
            return `• ${startStr} bis ${endDisplay}: **${e.summary}** 🗓️`;
          }
        }
        return `• ${startStr}${timeStr}: **${e.summary}**`;
      }).join("\n");

      return `📅 Termine für **${artistName}**:\n${eventList}`;
    } 
    // --- FALL B: SCHREIBEN (Der neue Entwurf-Modus) ---
    else {
      // 1. Event-Objekt vorbereiten
      const event = {
        summary: data.title || "Neuer Termin",
        start: { dateTime: formatForGoogle(data.start_iso), timeZone: "Europe/Berlin" },
        end: { 
          dateTime: formatForGoogle(data.end_iso) || new Date(new Date(formatForGoogle(data.start_iso)).getTime() + 60 * 60000).toISOString(), 
          timeZone: "Europe/Berlin" 
        },
        attendees: data.attendees ? data.attendees.map(email => ({ email })) : []
      };

      // 2. Im pendingCalendar speichern, damit die Bestätigungs-Schleife greift
      const pendingData = { calId, calName: artistName, event, sendUpdates: data.attendees ? "all" : "none" };
      pendingCalendar.set(chatId, pendingData);
      
      // 3. Dein einheitliches Menü mit "Ja / Abbruch" anzeigen
      return renderMenu(pendingData);
    }
  } catch (err) { 
    console.error("Kalender-Fehler:", err); 
    return "❌ Kalender-Fehler. Bitte prüfe Künstler und Zeitraum."; 
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
