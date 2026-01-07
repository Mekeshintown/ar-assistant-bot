"use strict";

const express = require("express");
const TelegramBot = require("node-telegram-bot-api");
const { Client: NotionClient } = require("@notionhq/client");
const { GoogleGenerativeAI } = require("@google/generative-ai");

// -------------------- ENV --------------------
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const WEBHOOK_URL = process.env.WEBHOOK_URL; // e.g. https://dein-bot.onrender.com
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const PORT = process.env.PORT || 3000;

if (!TELEGRAM_BOT_TOKEN) throw new Error("Missing env var: TELEGRAM_BOT_TOKEN");
if (!WEBHOOK_URL) throw new Error("Missing env var: WEBHOOK_URL");
if (!NOTION_TOKEN) throw new Error("Missing env var: NOTION_TOKEN");
if (!GEMINI_API_KEY) throw new Error("Missing env var: GEMINI_API_KEY");

// -------------------- Notion DB IDs --------------------
const DB_CONFIG = "2e1c841ccef980708df2ecee5f0c2df0";
const DB_STUDIOS = "2e0c841ccef980b49c4aefb4982294f0";
const DB_BIOS = "2e0c841ccef9807e9b73c9666ce4fcb0";

// -------------------- Clients --------------------
const app = express();
app.use(express.json({ limit: "2mb" }));

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN); // IMPORTANT: NO polling
const notion = new NotionClient({ auth: NOTION_TOKEN });

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const gemini = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// A "secret" webhook path to reduce random hits
const secretPath = `/telegram/${TELEGRAM_BOT_TOKEN}`;

// -------------------- Helpers --------------------
function getPlainText(richTextArr) {
  if (!Array.isArray(richTextArr)) return "";
  return richTextArr.map((t) => t?.plain_text || "").join("").trim();
}

function getTitle(prop) {
  return getPlainText(prop?.title);
}

function getRichText(prop) {
  return getPlainText(prop?.rich_text);
}

function getUrl(prop) {
  return prop?.url || "";
}

function getSelect(prop) {
  return prop?.select?.name || "";
}

function getMultiSelect(prop) {
  return (prop?.multi_select || []).map((x) => x.name).filter(Boolean);
}

// Find a Notion page by Name == <name> (case-insensitive match via contains)
async function notionFindByName(databaseId, name) {
  const res = await notion.databases.query({
    database_id: databaseId,
    filter: {
      property: "Name",
      title: { contains: name }
    },
    page_size: 10
  });

  // prefer exact match if possible
  const normalized = (s) => (s || "").trim().toLowerCase();
  const exact = res.results.find((p) => normalized(getTitle(p.properties?.Name)) === normalized(name));
  return exact || res.results[0] || null;
}

// -------------------- Notion Accessors --------------------
async function getArtistBio(artistName) {
  const page = await notionFindByName(DB_BIOS, artistName);
  if (!page) return { found: false, message: `Kein Eintrag in Notion "Artist Bios" für: ${artistName}` };

  const props = page.properties || {};
  return {
    found: true,
    name: getTitle(props.Name),
    bioLong: getRichText(props["Bio Long"]),
    bioShort: getRichText(props["Bio Short"]),
    spotify: getUrl(props.Spotify),
    instagram: getUrl(props.Instagram),
    tiktok: getUrl(props.TikTok),
    demos: getUrl(props.Demos),
    cuts: getUrl(props.Cuts),
    songwriterPage: getUrl(props["Songwriter Page"])
  };
}

async function getStudioInfo(studioName) {
  const page = await notionFindByName(DB_STUDIOS, studioName);
  if (!page) return { found: false, message: `Kein Eintrag in Notion "Studios" für: ${studioName}` };

  const props = page.properties || {};
  return {
    found: true,
    name: getTitle(props.Name),
    address: getRichText(props.Address),
    bell: getRichText(props.Bell),
    defaultContact: getRichText(props["Default Contact"])
  };
}

async function getConfigValue(keyName) {
  // Assumption: Config DB has a "Name" column and some value fields.
  // If your config schema differs, tell me the column names and I adapt instantly.
  const page = await notionFindByName(DB_CONFIG, keyName);
  if (!page) return { found: false, message: `Kein Eintrag in Notion "Config" für: ${keyName}` };

  const props = page.properties || {};
  // Try common "Value" fields (safe fallbacks)
  const value =
    getRichText(props.Value) ||
    getRichText(props["Config Value"]) ||
    getRichText(props["Text"]) ||
    getTitle(props.Name);

  return { found: true, key: getTitle(props.Name), value };
}

// -------------------- Gemini Chat --------------------
async function geminiAnswer({ userText, contextBlocks = [], languageHint = "auto" }) {
  // Keep it simple: we feed context + question.
  const system = `
You are a personal A&R assistant used via Telegram.
Rules:
- Never invent facts or database contents.
- If something is missing, ask one short clarifying question.
- Output must be concise and copy-paste-ready.
- Reply in the user's language (German/English). If unclear, default to the language used in the user's message.
`.trim();

  const context = contextBlocks.length
    ? `\n\nContext (from databases, may be partial):\n${contextBlocks.join("\n")}\n`
    : "";

  const prompt = `${system}${context}\n\nUser:\n${userText}\n\nAssistant:`;

  const result = await gemini.generateContent(prompt);
  const response = result.response;
  const text = (response && response.text && response.text()) ? response.text().trim() : "";
  return text || "Ich konnte dazu gerade keine Antwort generieren.";
}

// -------------------- Intent (lightweight) --------------------
// You said: "chat like ChatGPT, access databases". We'll route only obvious cases,
// otherwise just answer normally.
function detectIntent(text) {
  const t = (text || "").toLowerCase();

  // very light heuristics
  if (t.includes("bio")) return "bio";
  if (t.includes("studio") || t.includes("adresse") || t.includes("address")) return "studio";
  if (t.startsWith("config ") || t.includes("konfig") || t.includes("config")) return "config";

  return "general";
}

function extractNameAfterKeyword(text, keyword) {
  const idx = text.toLowerCase().indexOf(keyword);
  if (idx === -1) return "";
  return text.slice(idx + keyword.length).trim();
}

// -------------------- Telegram Handlers --------------------
bot.onText(/^\/start$/, async (msg) => {
  await bot.sendMessage(msg.chat.id, "Bot ist online. Schreib mir einfach deine Frage (DE/EN).");
});

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  if (!text || text.startsWith("/")) return;

  try {
    const intent = detectIntent(text);

    if (intent === "bio") {
      // Try to extract an artist name; if not, ask one question
      const nameGuess = extractNameAfterKeyword(text, "bio").replace(/^von\s+/i, "").trim();
      if (!nameGuess) {
        await bot.sendMessage(chatId, "Von welchem Artist brauchst du die Bio?");
        return;
      }

      const bio = await getArtistBio(nameGuess);
      if (!bio.found) {
        await bot.sendMessage(chatId, bio.message);
        return;
      }

      // Build a clean copy-paste answer (no Gemini needed)
      const lines = [];
      lines.push(`Bio – ${bio.name}`);
      if (bio.bioShort) lines.push(`\n**Short:**\n${bio.bioShort}`);
      if (bio.bioLong) lines.push(`\n**Long:**\n${bio.bioLong}`);

      const links = [];
      if (bio.spotify) links.push(`Spotify: ${bio.spotify}`);
      if (bio.instagram) links.push(`Instagram: ${bio.instagram}`);
      if (bio.tiktok) links.push(`TikTok: ${bio.tiktok}`);
      if (bio.demos) links.push(`Demos: ${bio.demos}`);
      if (bio.cuts) links.push(`Cuts: ${bio.cuts}`);
      if (bio.songwriterPage) links.push(`Songwriter Page: ${bio.songwriterPage}`);

      if (links.length) lines.push(`\n**Links:**\n${links.join("\n")}`);

      await bot.sendMessage(chatId, lines.join("\n"));
      return;
    }

    if (intent === "studio") {
      const nameGuess =
        extractNameAfterKeyword(text, "studio") ||
        extractNameAfterKeyword(text, "adresse") ||
        extractNameAfterKeyword(text, "address");

      const studioName = (nameGuess || "").replace(/^von\s+/i, "").trim();
      if (!studioName) {
        await bot.sendMessage(chatId, "Welches Studio meinst du? (Name in Notion)");
        return;
      }

      const studio = await getStudioInfo(studioName);
      if (!studio.found) {
        await bot.sendMessage(chatId, studio.message);
        return;
      }

      const out = [
        `Studio – ${studio.name}`,
        studio.address ? `Address: ${studio.address}` : "",
        studio.bell ? `Bell: ${studio.bell}` : "",
        studio.defaultContact ? `Default Contact: ${studio.defaultContact}` : ""
      ].filter(Boolean);

      await bot.sendMessage(chatId, out.join("\n"));
      return;
    }

    if (intent === "config") {
      // Expect: "config <key>" or message containing "config"
      const keyGuess = text.toLowerCase().startsWith("config ")
        ? text.slice("config ".length).trim()
        : extractNameAfterKeyword(text, "config").trim();

      if (!keyGuess) {
        await bot.sendMessage(chatId, "Welchen Config-Key soll ich nachschlagen?");
        return;
      }

      const cfg = await getConfigValue(keyGuess);
      if (!cfg.found) {
        await bot.sendMessage(chatId, cfg.message);
        return;
      }

      await bot.sendMessage(chatId, `Config – ${cfg.key}\n${cfg.value}`);
      return;
    }

    // General: use Gemini; optionally add small context (e.g., known studio list etc.)
    const answer = await geminiAnswer({ userText: text });
    await bot.sendMessage(chatId, answer);
  } catch (err) {
    console.error("Handler error:", err?.response?.data || err);
    await bot.sendMessage(chatId, "Fehler beim Verarbeiten. Check Render Logs.");
  }
});

// -------------------- Webhook Server --------------------

// Telegram posts updates here
app.post(secretPath, (req, res) => {
  try {
    bot.processUpdate(req.body);
  } catch (e) {
    console.error("processUpdate error:", e);
  }
  res.sendStatus(200);
});

// Health check
app.get("/", (_req, res) => res.status(200).send("OK"));

app.listen(PORT, async () => {
  console.log("HTTP server listening on", PORT);

  // CRITICAL: kick old connections + drop pending updates to avoid ghost conflicts
  try {
    await bot.deleteWebHook({ drop_pending_updates: true });
  } catch (e) {
    // deleteWebHook can fail if none exists; safe to ignore
    console.warn("deleteWebHook warning:", e?.message || e);
  }

  const hookUrl = `${WEBHOOK_URL}${secretPath}`;
  await bot.setWebHook(hookUrl);

  console.log("Webhook set to", hookUrl);
});
