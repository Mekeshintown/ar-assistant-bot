const { Client } = require('@notionhq/client');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const Slimbot = require('slimbot');
const http = require('http');

// Render Port Fix
http.createServer((req, res) => {
  res.writeHead(200);
  res.end('A&R Bot Online');
}).listen(process.env.PORT || 3000);

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const slimbot = new Slimbot(process.env.TELEGRAM_BOT_TOKEN);

async function getNotionData(databaseId) {
  try {
    const response = await notion.databases.query({ database_id: databaseId });
    return response.results.map(page => {
      const props = page.properties;
      let entry = {};
      for (const key in props) {
        const val = props[key];
        if (val.title) entry[key] = val.title[0]?.plain_text;
        else if (val.rich_text) entry[key] = val.rich_text[0]?.plain_text;
        else if (val.select) entry[key] = val.select.name;
      }
      return entry;
    });
  } catch (e) { return []; }
}

slimbot.on('message', async (message) => {
  if (!message.text) return;
  const chatId = message.chat.id;

  try {
    // 1. Daten laden
    const [config, studios, bios] = await Promise.all([
      getNotionData('2e1c841ccef980708df2ecee5f0c2df0'),
      getNotionData('2e0c841ccef980b49c4aefb4982294f0'),
      getNotionData('2e0c841ccef9807e9b73c9666ce4fcb0')
    ]);

    // 2. Gemini stabil aufrufen
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    // 3. Prompt ohne "Digger"-Zwang
    const systemInstruction = `
      Du bist der A&R Assistent der L'Agentur. 
      Dein Tonfall ist professionell, aber entspannt (Music Business Style). 
      Nutze diese Daten für deine Antwort:
      - Strategie/Regeln: ${JSON.stringify(config)}
      - Studio-Infos: ${JSON.stringify(studios)}
      - Artist-Bios: ${JSON.stringify(bios)}
      
      Wenn du eine Info nicht hast, sag es höflich.
    `;

    const result = await model.generateContent(systemInstruction + "\n\nAnfrage: " + message.text);
    slimbot.sendMessage(chatId, result.response.text());

  } catch (error) {
    console.error("Fehler:", error);
    slimbot.sendMessage(chatId, "Entschuldige, ich konnte die Daten gerade nicht abrufen.");
  }
});

// 4. Start-Logik mit Konflikt-Lösung
const start = async () => {
  try {
    await slimbot.deleteWebhook({ drop_pending_updates: true });
    slimbot.startPolling((err) => {
      if (err && err.includes('409')) {
        setTimeout(start, 10000);
      }
    });
  } catch (e) { setTimeout(start, 10000); }
};

start();
