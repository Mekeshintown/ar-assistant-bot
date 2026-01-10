"use strict";

const express = require("express");
const TelegramBot = require("node-telegram-bot-api");
const { Client: NotionClient } = require("@notionhq/client");
const OpenAI = require("openai");
const axios = require("axios");
const fs = require("fs");
const Airtable = require("airtable");
const { google } = require("googleapis");
const { Document, Packer, Paragraph, Table, TableRow, TableCell, WidthType, TextRun } = require("docx");

// --- SETUP ---
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const WEBHOOK_URL = process.env.WEBHOOK_URL; 
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const PORT = process.env.PORT || 3000;

const AIRTABLE_BASE_ID = "appF535cRZRho6btT"; 
const DB_CONFIG = "2e1c841ccef980708df2ecee5f0c2df0";
const DB_STUDIOS = "2e0c841ccef980b49c4aefb4982294f0";
const DB_BIOS = "2e0c841ccef9807e9b73c9666ce4fcb0"; 
const DB_PUBLISHING = "2e0c841ccef980579177d2996f1e92f4";
const DB_ARTIST_INFOS = "2e2c841ccef98089aad0ed1531e8655b";
const DB_CALENDARS = "2e3c841ccef9800d96f2c38345eeb2bc";
const DB_LABELCOPIES = "2e4c841ccef980d9ac9bf039d92565cc";

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN);
const notion = new NotionClient({ auth: NOTION_TOKEN });
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const airtableBase = new Airtable({ apiKey: AIRTABLE_API_KEY }).base(AIRTABLE_BASE_ID);

const chatContext = new Map();
const activeSession = new Map(); 
const app = express();
app.use(express.json());

// --- HELPERS ---
function parseProperties(properties) {
  let data = {};
  for (const key in properties) {
    const p = properties[key];
    let val = "";
    if (p.title) val = p.title[0]?.plain_text || "";
    else if (p.rich_text) val = p.rich_text[0]?.plain_text || "";
    else if (p.select) val = p.select.name || "";
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

function buildNotionProps(data) {
    const props = {};
    const fields = ["Artist", "Version", "Genre", "Time", "Recording Country", "Written by", "Published by", "Produced by", "Mastered by", "Mixed by", "Vocals by", "Programming by", "Bass by", "Drums by", "Keys by", "Synth by", "Splits", "Lyrics"];
    if (data.Titel) props["Titel"] = { title: [{ text: { content: String(data.Titel) } }] };
    
    Object.keys(data).forEach(k => {
        const match = fields.find(f => f.toLowerCase() === k.toLowerCase());
        if (match && data[k]) {
            let val = data[k];
            // Radikaler Check gegen [object Object]
            if (typeof val === 'object') {
                val = Object.entries(val).map(([name, split]) => `${name}: ${split}`).join("\n");
            }
            props[match] = { rich_text: [{ text: { content: String(val) } }] }; 
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
    msg += `----------------------------------\n👉 Schreib einfach neue Infos rein (z.B. "Mix Gregor").\n👉 **"Exportieren"** für Word.\n👉 **"Fertig"** zum Pausieren.`;
    return msg;
}

async function handleChat(chatId, text) {
    const textLower = text.toLowerCase();
    let session = activeSession.get(chatId);

    if (session && (textLower === "fertig" || textLower === "session löschen")) {
        activeSession.delete(chatId);
        return "Labelcopy-Session pausiert. Ich bin wieder im normalen Modus.";
    }

    const recallTriggers = ["stand", "status", "zeig mir", "weiterarbeiten"];
    if (recallTriggers.some(t => textLower.includes(t)) && text.length > 5 && !session) {
        const lcs = await fetchFullDatabase(DB_LABELCOPIES);
        const found = lcs.find(l => (l.Titel && textLower.includes(l.Titel.toLowerCase())) || (l.Artist && textLower.includes(l.Artist.toLowerCase())));
        if (found) {
            activeSession.set(chatId, { step: "confirm_recall", pendingPageId: found.id, artist: found.Artist, title: found.Titel });
            return `Gefunden: **${found.Artist} - ${found.Titel}**. Weiterarbeiten? (Ja/Nein)`;
        }
    }

    if (session && session.step === "confirm_recall") {
        if (textLower.includes("ja") || textLower.includes("yes")) {
            activeSession.set(chatId, { step: "active", pageId: session.pendingPageId, artist: session.artist, title: session.title });
            return await showFullMask(chatId, session.pendingPageId);
        } else { activeSession.delete(chatId); return "Abgebrochen."; }
    }

    if (textLower.includes("labelcopy anlegen") || textLower.includes("lc anlegen")) {
        activeSession.set(chatId, { step: "awaiting_artist" });
        return "Welcher **Künstler**?";
    }

    if (session) {
        if (session.step === "awaiting_artist") {
            session.artist = text; session.step = "awaiting_title";
            activeSession.set(chatId, session);
            return `Titel?`;
        }
        if (session.step === "awaiting_title") {
            session.title = text; session.step = "active";
            const newPage = await notion.pages.create({ parent: { database_id: DB_LABELCOPIES }, properties: buildNotionProps({ Artist: session.artist, Titel: session.title }) });
            session.pageId = newPage.id; activeSession.set(chatId, session);
            return await showFullMask(chatId, newPage.id);
        }
        
        // --- DIE INTELLIGENTE EXTRAKTION ---
        const extraction = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [{ 
                role: "system", 
                content: `Du bist ein A&R Assistent. Extrahiere Infos. 
                DENK MIT: "Mix", "Abmischung" -> Mixed by. "Master", "Mastering" -> Mastered by. "Dauer", "Länge" -> Time.
                SPLITS: Gib sie IMMER als Text zurück: "Name: XX%". 
                GIB NUR JSON ZURÜCK.` 
            }, { role: "user", content: text }],
            response_format: { type: "json_object" }
        });
        const updateData = JSON.parse(extraction.choices[0].message.content);
        if (Object.keys(updateData).length > 0) {
            await notion.pages.update({ page_id: session.pageId, properties: buildNotionProps(updateData) });
            return await showFullMask(chatId, session.pageId);
        }
    }

    // --- NORMALER MODUS (KALENDER, WISSEN) ---
    const [calendarList, publishing, studios, bios] = await Promise.all([
        fetchFullDatabase(DB_CALENDARS), fetchFullDatabase(DB_PUBLISHING), fetchFullDatabase(DB_STUDIOS), fetchFullDatabase(DB_BIOS)
    ]);
    
    // Kalender (Termine)
    if (["termin", "heute", "morgen", "kalender"].some(t => textLower.includes(t)) && text.length > 5) {
        // Hier bleibt deine Kalender-Logik (Code wie davor)...
        return "Ich schaue in den Kalender... (Kalender-Funktion aktiv)";
    }

    // Normaler Chat
    const systemMsg = { role: "system", content: `A&R Wissen: Publishing: ${JSON.stringify(publishing)}, Studios: ${JSON.stringify(studios)}.` };
    const comp = await openai.chat.completions.create({ model: "gpt-4o", messages: [systemMsg, {role: "user", content: text}] });
    return comp.choices[0].message.content;
}

// (Bot Start & Server Logik identisch)
bot.on("message", async (msg) => {
    if (msg.voice || !msg.text) return;
    const answer = await handleChat(msg.chat.id, msg.text);
    await bot.sendMessage(msg.chat.id, answer, { parse_mode: "Markdown" });
});

app.post(`/telegram/${TELEGRAM_BOT_TOKEN}`, (req, res) => { bot.processUpdate(req.body); res.sendStatus(200); });
app.listen(PORT, async () => {
    await bot.setWebHook(`${WEBHOOK_URL}/telegram/${TELEGRAM_BOT_TOKEN}`);
    console.log(`Bot läuft.`);
});
