const { Client } = require('@notionhq/client');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const Slimbot = require('slimbot');
const http = require('http');

// Port-Fix für Render
http.createServer((req, res) => {
  res.writeHead(200);
  res.end('A&R Bot Online');
}).listen(process.env.PORT || 3000);

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const slimbot = new Slimbot(process.env.TELEGRAM_BOT_TOKEN);

async function getNotionData(databaseId) {
  try {
    // Korrigierter Aufruf für die Notion Library
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
    console.error(`Notion Error (${databaseId}):`, e.message);
    return [];
  }
}

slimbot.on('message', async (message) => {
  if (!message.text) return;
  const chatId = message.chat.id;

  try {
    const config = await getNotionData('2e1c841ccef980708df2ecee5f0c2df0');
    const studios = await getNotionData('2e0c841ccef980b49c4aefb4982294f0');
    const bios = await getNotionData('2e0c841ccef9807e9b73c9666ce4fcb0');

    // Korrigierter Modell-Name
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash-latest" });

    const prompt = `
      Du bist der L'Agentur A&R Bot. Ton: Music Industry Casual.
      Kontext aus Notion:
      Regeln: ${JSON.stringify(config)}
      Studios: ${JSON.stringify(studios)}
      Artist-Bios: ${JSON.stringify(bios)}
      
      Nutzer fragt: ${message.text}
    `;

    const result = await model.generateContent(prompt);
    slimbot.sendMessage(chatId, result.response.text());

  } catch (error) {
    console.error("Fehler:", error);
    slimbot.sendMessage(chatId, "Sorry, die KI oder Notion hängen gerade kurz.");
  }
});

// Start ohne 409 Risiko
slimbot.deleteWebhook({ drop_pending_updates: true }).then(() => {
  console.log("System bereit. Polling startet...");
  slimbot.startPolling();
});
