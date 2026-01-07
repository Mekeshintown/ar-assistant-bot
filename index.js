const { Client } = require('@notionhq/client');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const Slimbot = require('slimbot');
const http = require('http');

// 1. RENDER PORT FIX (Damit Render sieht, dass der Bot lebt)
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('A&R Bot is active');
}).listen(process.env.PORT || 3000);

// 2. SETUP
const notion = new Client({ auth: process.env.NOTION_TOKEN });
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const slimbot = new Slimbot(process.env.TELEGRAM_BOT_TOKEN);

async function getNotionData(databaseId) {
  try {
    const response = await notion.databases.query({ database_id: databaseId });
    return response.results.map(page => {
      const props = page.properties;
      const data = {};
      for (const key in props) {
        if (props[key].title) data[key] = props[key].title[0]?.plain_text;
        else if (props[key].rich_text) data[key] = props[key].rich_text[0]?.plain_text;
      }
      return data;
    });
  } catch (e) {
    console.error(`Fehler bei Notion ID ${databaseId}:`, e.message);
    return [];
  }
}

// 3. BOT LOGIK
slimbot.on('message', async (message) => {
  if (!message.text) return;
  const chatId = message.chat.id;

  try {
    const config = await getNotionData('2e1c841ccef980708df2ecee5f0c2df0');
    const studios = await getNotionData('2e0c841ccef980b49c4aefb4982294f0');
    const bios = await getNotionData('2e0c841ccef9807e9b73c9666ce4fcb0');

    const systemInstruction = `
      Du bist der L'Agentur A&R Bot. Ton: Music Industry Casual.
      Regeln: ${JSON.stringify(config)}
      Studios: ${JSON.stringify(studios)}
      Bios: ${JSON.stringify(bios)}
      Antworte präzise. Wenn Infos fehlen, schreibe [INFO FEHLT].
    `;

    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash", systemInstruction });
    const result = await model.generateContent(message.text);
    slimbot.sendMessage(chatId, result.response.text());

  } catch (error) {
    console.error("Fehler:", error);
    slimbot.sendMessage(chatId, "Digger, kleiner Fehler im System. Check mal die Notion-Verbindung.");
  }
});

// 4. DER "GEWALT" NEUSTART (Löst den 409 Error)
const startBot = async () => {
  console.log("Schritt 1: Alte Webhooks löschen...");
  await slimbot.deleteWebhook({ drop_pending_updates: true });
  
  console.log("Schritt 2: 20 Sekunden warten für Sync...");
  setTimeout(() => {
    console.log("Schritt 3: Polling startet jetzt...");
    slimbot.startPolling((err) => {
      if (err) {
        console.error("Immer noch Konflikt, versuche es in 30s erneut...");
        setTimeout(startBot, 30000);
      }
    });
  }, 20000);
};

startBot();
