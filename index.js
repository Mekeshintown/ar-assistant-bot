const { Client } = require('@notionhq/client');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const Slimbot = require('slimbot');
const http = require('http');

// 1. Port-Fix für Render (Damit der Bot live bleibt)
http.createServer((req, res) => res.end('Bot is active')).listen(process.env.PORT || 3000);

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const slimbot = new Slimbot(process.env.TELEGRAM_BOT_TOKEN);

async function getNotionData(databaseId) {
  const response = await notion.databases.query({ database_id: databaseId });
  return response.results.map(page => page.properties);
}

slimbot.on('message', async (message) => {
  const chatId = message.chat.id;
  try {
    const config = await getNotionData('2e1c841ccef980708df2ecee5f0c2df0');
    const studios = await getNotionData('2e0c841ccef980b49c4aefb4982294f0');
    const bios = await getNotionData('2e0c841ccef9807e9b73c9666ce4fcb0');

    const systemInstruction = `Du bist der L'Agentur A&R Bot. Ton: Music Industry Casual. Daten: ${JSON.stringify({config, studios, bios})}`;
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash", systemInstruction });
    const result = await model.generateContent(message.text);
    slimbot.sendMessage(chatId, result.response.text());
  } catch (err) {
    console.error(err);
  }
});

// 2. Aggressiver Neustart-Mechanismus
const start = async () => {
  console.log("Bereinige Leitung...");
  await slimbot.deleteWebhook({ drop_pending_updates: true });
  setTimeout(() => {
    console.log("Versuche finalen Start...");
    slimbot.startPolling();
  }, 20000); // 20 Sekunden Sicherheitsabstand
};

start();
