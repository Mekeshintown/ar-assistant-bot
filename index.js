{\rtf1\ansi\ansicpg1252\cocoartf2821
\cocoatextscaling0\cocoaplatform0{\fonttbl\f0\fswiss\fcharset0 Helvetica;}
{\colortbl;\red255\green255\blue255;}
{\*\expandedcolortbl;;}
\paperw11900\paperh16840\margl1440\margr1440\vieww11520\viewh8400\viewkind0
\pard\tx720\tx1440\tx2160\tx2880\tx3600\tx4320\tx5040\tx5760\tx6480\tx7200\tx7920\tx8640\pardirnatural\partightenfactor0

\f0\fs24 \cf0 const TelegramBot = require("node-telegram-bot-api");\
const OpenAI = require("openai");\
\
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;\
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;\
\
if (!TELEGRAM_BOT_TOKEN) throw new Error("Missing TELEGRAM_BOT_TOKEN");\
if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");\
\
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, \{ polling: true \});\
const openai = new OpenAI(\{ apiKey: OPENAI_API_KEY \});\
\
bot.onText(/^\\/start$/, (msg) => \{\
  bot.sendMessage(msg.chat.id, "A&R Assistant ist online. Schreib mir einfach.");\
\});\
\
bot.on("message", async (msg) => \{\
  const chatId = msg.chat.id;\
  const text = msg.text;\
  if (!text || text.startsWith("/")) return;\
\
  try \{\
    await bot.sendChatAction(chatId, "typing");\
\
    const resp = await openai.responses.create(\{\
      model: "gpt-4.1-mini",\
      input: [\
        \{ role: "system", content: "Du bist ein pers\'f6nlicher A&R-Assistent." \},\
        \{ role: "user", content: text \}\
      ]\
    \});\
\
    const answer = resp.output_text?.trim() || "Keine Antwort erhalten.";\
    await bot.sendMessage(chatId, answer);\
  \} catch (e) \{\
    console.error(e);\
    await bot.sendMessage(chatId, "Fehler. Check Render Logs.");\
  \}\
\});\
}