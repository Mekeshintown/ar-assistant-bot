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

// --- SETUP & TOKENS ---
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const WEBHOOK_URL = process.env.WEBHOOK_URL; 
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const PORT = process.env.PORT || 3000;

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

// --- LABELCOPY LOGIK ---

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
    msg += `----------------------------------\n👉 Schick mir weitere Infos oder sag "Exportieren".`;
    return msg;
}

function buildNotionProps(data) {
    const props = {};
    if (data.Titel) props["Titel"] = { title: [{ text: { content: String(data.Titel) } }] };
    const fields = ["Artist", "Version", "Genre", "Time", "Recording Country", "Written by", "Published by", "Produced by", "Mastered by", "Mixed by", "Vocals by", "Programming by", "Bass by", "Drums by", "Keys by", "Synth by", "Splits", "Lyrics"];
    fields.forEach(f => { 
        if (data[f]) {
            let val = data[f];
            if (typeof val === 'object') val = JSON.stringify(val);
            props[f] = { rich_text: [{ text: { content: String(val) } }] }; 
        }
    });
    return props;
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
    return "Hier ist dein Word-Dokument! 📄";
}

// --- HAUPT CHAT LOGIK ---

async function handleChat(chatId, text) {
    const textLower = text.toLowerCase();
    let session = activeSession.get(chatId);

    // 1. RECALL mit Bestätigungsfrage
    const recallTriggers = ["stand", "status", "zeig mir", "weiterarbeiten", "laden"];
    if (recallTriggers.some(t => textLower.includes(t)) && text.length > 5) {
        const lcs = await fetchFullDatabase(DB_LABELCOPIES);
        const found = lcs.find(l => 
            (l.Titel && textLower.includes(l.Titel.toLowerCase())) || 
            (l.Artist && textLower.includes(l.Artist.toLowerCase()))
        );

        if (found) {
            // Wir speichern den Fund vorerst nur als "Vorschlag" in der Session
            activeSession.set(chatId, { step: "confirm_recall", pendingPageId: found.id, artist: found.Artist, title: found.Titel });
            return `Ich habe eine Labelcopy gefunden: **${found.Artist} - ${found.Titel}**. \n\nMöchtest du an dieser weiterarbeiten? (Ja/Nein)`;
        } else if (textLower.includes("zeig mir") || textLower.includes("status")) {
            return "Ich konnte keine passende Labelcopy finden. Bitte nenne mir den Titel oder Künstler genauer.";
        }
    }

    // Bestätigung verarbeiten
    if (session && session.step === "confirm_recall") {
        if (textLower.includes("ja") || textLower.includes("genau") || textLower.includes("yes") || textLower.includes("si")) {
            const pageId = session.pendingPageId;
            activeSession.set(chatId, { step: "active", pageId: pageId, artist: session.artist, title: session.title });
            return `✅ Top! Wir arbeiten jetzt an **${session.artist} - ${session.title}**.\n\n` + await showFullMask(chatId, pageId);
        } else {
            activeSession.delete(chatId);
            return "Alles klar, Suche abgebrochen. Was kann ich stattdessen für dich tun?";
        }
    }

    // 2. Initialer Trigger für NEUE LC
    if (textLower.includes("labelcopy anlegen") || textLower.includes("lc anlegen")) {
        activeSession.set(chatId, { step: "awaiting_artist" });
        return "Alles klar! Welcher **Künstler** soll es sein?";
    }

    // 3. Workflow Session aktiv
    if (session) {
        if (session.step === "awaiting_artist") {
            session.artist = text;
            session.step = "awaiting_title";
            activeSession.set(chatId, session);
            return `Notiert: **${text}**. Wie lautet der **Titel** des Songs?`;
        }

        if (session.step === "awaiting_title") {
            session.title = text;
            session.step = "active";
            const configs = await fetchFullDatabase(DB_CONFIG);
            const rules = configs.find(c => c.Aufgabe === "Labelcopy Rules")?.Anweisung || "";
            
            const extraction = await openai.chat.completions.create({
                model: "gpt-4o",
                messages: [{ role: "system", content: `Regeln: ${rules}. Wenn Artist "${session.artist}" ist, fülle Presets. Gib NUR JSON.` }, { role: "user", content: `Artist: ${session.artist}, Titel: ${session.title}` }],
                response_format: { type: "json_object" }
            });
            const presetData = JSON.parse(extraction.choices[0].message.content);
            const newPage = await notion.pages.create({ parent: { database_id: DB_LABELCOPIES }, properties: buildNotionProps({ ...presetData, Artist: session.artist, Titel: session.title }) });
            session.pageId = newPage.id;
            activeSession.set(chatId, session);
            return await showFullMask(chatId, newPage.id);
        }

        if (textLower.includes("export") || textLower.includes("word")) return await generateWordDoc(chatId, session.pageId);
        
        const extraction = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [
                { role: "system", content: "Extrahiere Infos für Labelcopy-Felder. 'Time' und 'Splits' sind Strings. Gib NUR JSON zurück." }, 
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

    // --- KALENDER LOGIK ---
    const [calendarList] = await Promise.all([fetchFullDatabase(DB_CALENDARS)]);
    const calendarTriggers = ["termin", "kalender", "meeting", "woche", "heute", "morgen"];
    if (calendarTriggers.some(word => textLower.includes(word)) && text.length > 5) {
        try {
            const oauth2Client = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, process.env.GOOGLE_REDIRECT_URI);
            oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
            const calendar = google.calendar({ version: "v3", auth: oauth2Client });
            const extraction = await openai.chat.completions.create({
                model: "gpt-4o",
                messages: [{ role: "system", content: `Kalender-Assistent. JSON exportieren.` }, { role: "user", content: text }],
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
                return `✅ Termin eingetragen.`;
            }
        } catch (e) { return "❌ Kalender-Fehler."; }
    }

    // --- NORMALER CHAT & AIRTABLE ---
    const [config, studios, bios, artistInfos, publishing] = await Promise.all([
        fetchFullDatabase(DB_CONFIG), fetchFullDatabase(DB_STUDIOS), fetchFullDatabase(DB_BIOS), fetchFullDatabase(DB_ARTIST_INFOS), fetchFullDatabase(DB_PUBLISHING)
    ]);

    let history = chatContext.get(chatId) || [];
    history.push({ role: "user", content: text });
    const systemMsg = { role: "system", content: `A&R Assistent der L'Agentur. Antworte professionell. Publishing: ${JSON.stringify(publishing)}, Studios: ${JSON.stringify(studios)}, Bios: ${JSON.stringify(bios)}.` };
    const comp = await openai.chat.completions.create({ model: "gpt-4o", messages: [systemMsg, ...history.slice(-8)] });
    const ans = comp.choices[0].message.content;
    history.push({ role: "assistant", content: ans });
    chatContext.set(chatId, history);
    return ans;
}

// --- SERVER & BOT START ---

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
            await bot.sendMessage(chatId, `📝 _${transcription.text}_\n\n${answer}`, { parse_mode: "Markdown" });
        });
    } catch (err) { await bot.sendMessage(chatId, "Fehler beim Audio."); }
});

app.post(`/telegram/${TELEGRAM_BOT_TOKEN}`, (req, res) => { bot.processUpdate(req.body); res.sendStatus(200); });
app.listen(PORT, async () => {
    await bot.deleteWebHook({ drop_pending_updates: true });
    await bot.setWebHook(`${WEBHOOK_URL}/telegram/${TELEGRAM_BOT_TOKEN}`);
    console.log(`Bot läuft auf Port ${PORT}`);
});
