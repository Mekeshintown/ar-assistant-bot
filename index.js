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
const pendingCalendar = new Map(); // Für die Sicherheits-Schleife
const lastSessionData = new Map(); // Für das Session-Gedächtnis
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
  
const textLower = text.toLowerCase();

  // --- 1. SICHERHEITS-LOOP: KALENDER BESTÄTIGUNG ---
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
             
             // Ausführliche Bestätigung (Deutsche Zeit)
             const startStr = new Date(pendingData.event.start.dateTime).toLocaleString('de-DE', { timeZone: 'Europe/Berlin', dateStyle: 'full', timeStyle: 'short' });
             return `✅ **Termin verbindlich eingetragen!**\n\n📌 **${pendingData.event.summary}**\n🗓 ${startStr}\n📍 ${pendingData.event.location || ""}\n📝 ${pendingData.event.description || ""}`;
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
      // Wenn User was anderes fragt (z.B. "Wie spät ist es?"), ignorieren wir den Loop hier nicht,
      // sondern lassen ihn stehen, bis er Ja/Nein sagt.
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
      const dateMatch = text.match(/\d{1,2}\.\d{1,2}\.(\d{2,4})?/);
      let date = dateMatch ? dateMatch[0] : "";
      if (date && date.split('.').length === 3 && date.split('.')[2] === "") date += new Date().getFullYear();
      
      const timeMatch = text.match(/\d{1,2}:\d{2}/);
      let time = timeMatch ? timeMatch[0] : "12:00"; 

      const nameExtract = await openai.chat.completions.create({ model: "gpt-4o", messages: [ { role: "system", content: "Extrahiere NUR die Artist Namen (Artist A x Artist B). Ignoriere Datum/Studio. Gib String." }, { role: "user", content: text } ] });
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
  // Jetzt lockerer: Reagiert auf "trag" + ("das" ODER "session")
  if (textLower.includes("trag") && (textLower.includes("das") || textLower.includes("session")) && lastSessionData.has(chatId)) {
      const s = lastSessionData.get(chatId);
      
      // Welcher Kalender? Suchen wir im Satz (z.B. "in Mate's Kalender")
      let targetCalId = "mate.spellenberg.umusic@gmail.com";
      let calName = "Mate";
      const foundCal = calendarList.find(c => textLower.includes(c.Name.toLowerCase()));
      if (foundCal) { targetCalId = foundCal["Calendar ID"]; calName = foundCal.Name; }
      
      const [day, month, year] = s.date.split('.');
      const cleanYear = year.length === 2 ? "20" + year : year;
      const [hours, minutes] = s.time.split(':');
      const startDate = new Date(cleanYear, month - 1, day, hours, minutes);
      const endDate = new Date(startDate.getTime() + 6 * 60 * 60 * 1000); 
      
      const eventResource = { 
          summary: `Session: ${s.artists}`, 
          location: s.studioInfo.address, 
          description: `Contact: ${s.studioInfo.contact}\nBell: ${s.studioInfo.bell}\nStudio: ${s.studioInfo.name}`, 
          start: { dateTime: startDate.toISOString(), timeZone: "Europe/Berlin" }, 
          end: { dateTime: endDate.toISOString(), timeZone: "Europe/Berlin" } 
      };

      pendingCalendar.set(chatId, { calId: targetCalId, event: eventResource, sendUpdates: "none" });
      lastSessionData.delete(chatId);

      const startDisplay = startDate.toLocaleString('de-DE', { timeZone: 'Europe/Berlin', dateStyle: 'short', timeStyle: 'short' });
      return `📅 Ich habe folgenden Termin vorbereitet:\n\n**${eventResource.summary}**\n📍 ${eventResource.location}\n🕒 ${startDisplay} (6 Std)\nKalender: ${calName}\n\nSoll ich das **eintragen**? (Ja/Nein)`;
  }
  
// --- KALENDER LOGIK (ALLGEMEIN) ---
  const calendarTriggers = ["termin", "kalender", "einplanen", "meeting", "woche", "heute", "morgen", "anstehen", "zeit", "plan", "session", "studio"];
  
  if (calendarTriggers.some(word => textLower.includes(word)) && text.length > 5 && !textLower.includes("trag")) {
    try {
      const extraction = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          { 
            role: "system", 
            content: `Kalender-Assistent. Data: JSON (type, artist, start_iso, end_iso, title, attendees).` 
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

      // --- LESE MODUS (Bleibt sofort) ---
      if (data.type === "read" || textLower.includes("wie sieht") || textLower.includes("was steht") || textLower.includes("wann")) {
        const response = await calendar.events.list({
          calendarId: calId,
          timeMin: formatForGoogle(data.start_iso),
          timeMax: formatForGoogle(data.end_iso),
          singleEvents: true,
          orderBy: "startTime",
        });
        const events = response.data.items;
        if (!events || events.length === 0) return `📅 Keine Termine für **${artistName}** gefunden.`;
        return events.map(e => `• ${e.summary} (${new Date(e.start.dateTime||e.start.date).toLocaleString('de-DE', { timeZone: 'Europe/Berlin' })})`).join("\n");
      } 
      
      // --- SCHREIB MODUS (JETZT MIT SICHERHEITSSCHLEIFE) ---
      else {
        const event = {
          summary: data.title || "Neuer Termin",
          start: { dateTime: formatForGoogle(data.start_iso), timeZone: "Europe/Berlin" },
          end: { dateTime: formatForGoogle(data.end_iso) || new Date(new Date(formatForGoogle(data.start_iso)).getTime() + 60 * 60000).toISOString(), timeZone: "Europe/Berlin" },
          attendees: data.attendees ? data.attendees.map(email => ({ email })) : [],
          location: "",
          description: ""
        };

        // NICHT eintragen, nur speichern!
        pendingCalendar.set(chatId, { calId: calId, event: event, sendUpdates: data.attendees ? "all" : "none" });

        const startDisplay = new Date(event.start.dateTime).toLocaleString('de-DE', { timeZone: 'Europe/Berlin' });
        return `📅 Ich habe folgenden Termin vorbereitet:\n\n**${event.summary}**\nStart: ${startDisplay}\nKalender: ${artistName}\n\nSoll ich das **eintragen**? (Ja/Nein)`;
      }

    } catch (err) {
      console.error("Calendar Error:", err);
      return "❌ Kalender-Fehler.";
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
