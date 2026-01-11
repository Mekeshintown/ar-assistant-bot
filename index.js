"use strict";

const express = require("express");
const TelegramBot = require("node-telegram-bot-api");
const { Client: NotionClient } = require("@notionhq/client");
const OpenAI = require("openai");
const axios = require("axios");
const fs = require("fs");
const Airtable = require("airtable");
const { google } = require("googleapis");

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
const AIRTABLE_BASE_ID = "appF535cRZRho6btT";

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN);
const notion = new NotionClient({ auth: NOTION_TOKEN });
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const airtableBase = new Airtable({ apiKey: AIRTABLE_API_KEY }).base(AIRTABLE_BASE_ID);

// NEU: Speicher für Session-Kontext und Kalender-Sicherheit
const chatContext = new Map();
const pendingCalendar = new Map();
const lastSessionData = new Map();

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
  const fetchSafely = async (id) => { try { return await fetchFullDatabase(id); } catch (e) { return []; } };
  const textLower = text.toLowerCase();

  // Daten laden
  const [config, studios, bios, artistInfos, artistPitch, labelPitch, publishing, calendarList] = await Promise.all([
    fetchSafely(DB_CONFIG), fetchSafely(DB_STUDIOS), fetchSafely(DB_BIOS), fetchSafely(DB_ARTIST_INFOS),
    fetchAirtableData('Artist Pitch'), fetchAirtableData('Label Pitch'), fetchSafely(DB_PUBLISHING), fetchSafely(DB_CALENDARS)
  ]);

  // -------------------------------------------------------------
  // 1. SICHERHEITS-LOOP: KALENDER BESTÄTIGUNG
  // -------------------------------------------------------------
  if (pendingCalendar.has(chatId)) {
      const pendingData = pendingCalendar.get(chatId);

      if (textLower.includes("ja") || textLower.includes("bestätigen") || textLower.includes("ok")) {
          try {
             // JETZT erst eintragen
             await calendar.events.insert({ 
                 calendarId: pendingData.calId, 
                 resource: pendingData.event, 
                 sendUpdates: pendingData.sendUpdates 
             });
             
             pendingCalendar.delete(chatId); 
             
             // Ausführliche Bestätigung generieren
             const startStr = new Date(pendingData.event.start.dateTime).toLocaleString('de-DE', { timeZone: 'Europe/Berlin', dateStyle: 'full', timeStyle: 'short' });
             const endStr = new Date(pendingData.event.end.dateTime).toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute:'2-digit' });
             
             return `✅ **Termin verbindlich eingetragen!**\n\n📌 **${pendingData.event.summary}**\n🗓 ${startStr} - ${endStr}\n📍 ${pendingData.event.location || ""}\n📝 ${pendingData.event.description || ""}`;
          } catch (e) { 
             console.error(e); 
             pendingCalendar.delete(chatId); 
             return "❌ Fehler beim Eintragen in Google Calendar."; 
          }
      } 
      else if (textLower.includes("nein") || textLower.includes("abbruch")) {
          pendingCalendar.delete(chatId); 
          return "Alles klar, Vorgang abgebrochen. Nichts wurde eingetragen.";
      }
      else {
          // Falls User was anderes fragt, gehen wir davon aus, er will abbrechen oder was anderes tun.
          // Wir lassen den Pending-Status aktiv, falls es nur ein Tippfehler war, oder wir brechen ab.
          // Hier: Wir lassen ihn aktiv und warten auf klares Ja/Nein.
      }
  }

  // -------------------------------------------------------------
  // 2. SESSION ZUSAMMENFASSUNG (Notion Config Gesteuert)
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

      // Config aus Notion holen ("Sessions")
      const sessionConfig = config.find(c => c.Aufgabe === "Sessions")?.Anweisung || "";
      
      // Standardzeit 12:00 wenn nichts gefunden
      const dateMatch = text.match(/\d{1,2}\.\d{1,2}\.(\d{2,4})?/);
      let date = dateMatch ? dateMatch[0] : "";
      if (date && date.split('.').length === 3 && date.split('.')[2] === "") date += new Date().getFullYear();
      
      const timeMatch = text.match(/\d{1,2}:\d{2}/);
      let time = timeMatch ? timeMatch[0] : "12:00"; 

      // Artists extrahieren
      const nameExtract = await openai.chat.completions.create({ model: "gpt-4o", messages: [ { role: "system", content: "Extrahiere NUR die Artist Namen (Artist A x Artist B). Ignoriere Datum/Studio. Gib String." }, { role: "user", content: text } ] });
      let artists = nameExtract.choices[0].message.content.replace(/['"]+/g, '');

      const sessionData = { artists, date, time, studioInfo };
      lastSessionData.set(chatId, sessionData);

      // Formatieren nach Notion Config (oder Fallback)
      // Wir bauen den String basierend auf den Daten
      const output = `Session: ${artists}\nDate: ${date}\nStart: ${time}\nStudio: ${studioInfo.name}\nAddress: ${studioInfo.address}\nBell: ${studioInfo.bell}\nContact: ${studioInfo.contact}`;
      return output;
  }

  // -------------------------------------------------------------
  // 3. SMART UPDATE: KONTAKT (Name -> Nummer)
  // -------------------------------------------------------------
  // Wenn wir Session-Daten haben und der User sagt "Contact Jonas" oder ähnliches
  if (lastSessionData.has(chatId) && (textLower.startsWith("contact") || textLower.startsWith("kontakt"))) {
      const currentSession = lastSessionData.get(chatId);
      
      // Wir suchen den Namen im Text
      const searchName = text.replace(/contact|kontakt/i, "").trim();
      
      // Suche in Artist Infos
      const foundArtist = artistInfos.find(a => a.Name.toLowerCase().includes(searchName.toLowerCase()));
      
      if (foundArtist) {
          const number = foundArtist.Telefonnummer || foundArtist.Phone || "";
          const formattedContact = `${number} (${foundArtist.Name})`; // WUNSCHFORMAT: Nummer (Name)
          
          currentSession.studioInfo.contact = formattedContact;
          lastSessionData.set(chatId, currentSession);
          
          return `Update: Kontakt geändert.\n\nSession: ${currentSession.artists}\nDate: ${currentSession.date}\nStart: ${currentSession.time}\nStudio: ${currentSession.studioInfo.name}\nAddress: ${currentSession.studioInfo.address}\nBell: ${currentSession.studioInfo.bell}\nContact: ${currentSession.studioInfo.contact}`;
      }
  }


  // -------------------------------------------------------------
  // 4. KALENDER LOGIK (INTELLIGENT & SICHER)
  // -------------------------------------------------------------
  const calendarTriggers = ["termin", "kalender", "einplanen", "meeting", "woche", "heute", "morgen", "anstehen", "zeit", "plan", "session", "studio"];
  
  if (calendarTriggers.some(word => textLower.includes(word)) && text.length > 5) {
    try {
      let eventResource = null;
      let targetCalendarId = "mate.spellenberg.umusic@gmail.com";
      let artistNameForMsg = "Mate";
      let isReadMode = textLower.includes("wie sieht") || textLower.includes("was steht") || textLower.includes("zeit") || textLower.includes("wann");

      // A) Kontext-Trigger: "Trag DAS ein" (Bezug auf Session)
      if ((textLower.includes("das") || textLower.includes("die session")) && lastSessionData.has(chatId) && !isReadMode) {
          const s = lastSessionData.get(chatId);
          
          // Kalender suchen
          const foundCal = calendarList.find(c => textLower.includes(c.Name.toLowerCase()));
          if (foundCal) { targetCalendarId = foundCal["Calendar ID"]; artistNameForMsg = foundCal.Name; }
          
          // Datum bauen
          const [day, month, year] = s.date.split('.');
          const cleanYear = year.length === 2 ? "20" + year : year;
          const [hours, minutes] = s.time.split(':');
          
          const startDate = new Date(cleanYear, month - 1, day, hours, minutes);
          const endDate = new Date(startDate.getTime() + 6 * 60 * 60 * 1000); // +6 Stunden
          
          eventResource = { 
              summary: `Session: ${s.artists}`, 
              location: s.studioInfo.address, 
              description: `Contact: ${s.studioInfo.contact}\nBell: ${s.studioInfo.bell}\nStudio: ${s.studioInfo.name}`, 
              start: { dateTime: startDate.toISOString(), timeZone: "Europe/Berlin" }, 
              end: { dateTime: endDate.toISOString(), timeZone: "Europe/Berlin" } 
          };
          lastSessionData.delete(chatId); // Kontext löschen nach Verwendung
      } 
      
      // B) Standard GPT Trigger (Wenn kein Kontext oder anderer Befehl)
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
          
          const artistEntry = calendarList.find(c => data.artist && c.Name.toLowerCase().trim() === data.artist.toLowerCase().trim());
          const calId = (artistEntry && artistEntry["Calendar ID"]) ? artistEntry["Calendar ID"].trim() : targetCalendarId;
          const artName = artistEntry ? artistEntry.Name : (data.artist || "Mate");

          // B1) LESE-MODUS (Original Logik erhalten!)
          if (data.type === "read" || isReadMode) {
               const formatForGoogle = (dateStr) => { if (!dateStr) return new Date().toISOString(); return dateStr.length === 19 ? `${dateStr}Z` : dateStr; };
               const response = await calendar.events.list({ 
                   calendarId: calId, 
                   timeMin: formatForGoogle(data.start_iso), 
                   timeMax: formatForGoogle(data.end_iso), 
                   singleEvents: true, orderBy: "startTime" 
               });
               const events = response.data.items;
               if (!events || events.length === 0) return `📅 Keine Termine für **${artName}** gefunden.`;
               return events.map(e => `• ${e.summary} (${new Date(e.start.dateTime||e.start.date).toLocaleString('de-DE', { timeZone: 'Europe/Berlin' })})`).join("\n");
          }

          // B2) SCHREIB-MODUS (Aber NICHT eintragen, nur vorbereiten!)
          targetCalendarId = calId;
          artistNameForMsg = artName;
          
          eventResource = { 
              summary: data.title || "Neuer Termin", 
              start: { dateTime: data.start_iso || new Date().toISOString(), timeZone: "Europe/Berlin" }, 
              end: { dateTime: data.end_iso || new Date(new Date().getTime() + 3600000).toISOString(), timeZone: "Europe/Berlin" }, 
              attendees: data.attendees ? data.attendees.map(email => ({ email })) : [] 
          };
      }

      // --- ENDE LOGIK: JETZT IMMER SICHERHEITSABFRAGE ---
      const sendUpdates = (eventResource.attendees && eventResource.attendees.length > 0) ? "all" : "none";
      
      // Speichern für Bestätigung
      pendingCalendar.set(chatId, { calId: targetCalendarId, event: eventResource, sendUpdates });

      const startStr = new Date(eventResource.start.dateTime).toLocaleString('de-DE', { timeZone: 'Europe/Berlin', dateStyle: 'short', timeStyle: 'short' });
      return `📅 Ich habe folgenden Termin vorbereitet:\n\n**${eventResource.summary}**\n📍 ${eventResource.location || "Kein Ort"}\n🕒 ${startStr}\nKalender: ${artistNameForMsg}\n\nSoll ich das **eintragen**? (Ja/Nein)`;

    } catch (err) { console.error("Calendar Error:", err); return "❌ Kalender-Fehler."; }
  }

  // --- AIRTABLE SAVE (Original Logik erhalten!) ---
  const triggerWords = ["speichere", "adden", "adde", "hinzufügen", "eintragen"];
  if (triggerWords.some(word => text.toLowerCase().includes(word)) && !text.toLowerCase().includes("termin")) {
    try {
      const extraction = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          { role: "system", content: `Extrahiere Kontaktdaten. JSON Key "table": "Artist Pitch" oder "Label Pitch".` },
          { role: "user", content: text }
        ],
        response_format: { type: "json_object" }
      });
      const result = JSON.parse(extraction.choices[0].message.content);
      const tableName = result.table || (text.toLowerCase().includes("label") ? "Label Pitch" : "Artist Pitch");
      let finalFields = {};
      
      // Felder zuweisen (vereinfacht dargestellt, übernimmt GPT Output)
      if (result.Artist_Name) finalFields.Artist_Name = result.Artist_Name;
      if (result.Contact_FirstName) finalFields.Contact_FirstName = result.Contact_FirstName;
      if (result.Contact_LastName) finalFields.Contact_LastName = result.Contact_LastName;
      if (result.Email) finalFields.Email = result.Email;
      if (result.Genre) finalFields.Genre = result.Genre;
      if (result.Prio) finalFields.Prio = result.Prio;
      if (result.Label_Name) finalFields.Label_Name = result.Label_Name;

      await airtableBase(tableName).create([{ fields: finalFields }]);
      return `✅ Erfolgreich gespeichert in **${tableName}**:\n👤 ${finalFields.Contact_FirstName || ""} ${finalFields.Contact_LastName || ""}\n📧 ${finalFields.Email || ""}`;
    } catch (e) { console.error(e); return "❌ Fehler beim Speichern in Airtable."; }
  }

  // --- NORMALER CHAT ---
  let history = chatContext.get(chatId) || [];
  history.push({ role: "user", content: text });
  if (history.length > 8) history.shift();
  const pitchRules = config.find(c => c.Key === "Pitch_Rules")?.Value || "";
  const sonstigeRegeln = config.filter(c => c.Key !== "Pitch_Rules");
  const completion = await openai.chat.completions.create({ model: "gpt-4o", messages: [{ role: "system", content: `A&R Bot. Rules: ${pitchRules} Data: ${JSON.stringify(sonstigeRegeln)}` }, ...history] });
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

app.post(`/telegram/${TELEGRAM_BOT_TOKEN}`, (req, res) => { bot.processUpdate(req.body); res.sendStatus(200); });
app.listen(PORT, async () => {
  await bot.deleteWebHook({ drop_pending_updates: true });
  await bot.setWebHook(`${WEBHOOK_URL}/telegram/${TELEGRAM_BOT_TOKEN}`);
  console.log("Bot läuft und hört auf Notion, Airtable & Kalender.");
});
