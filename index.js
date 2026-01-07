const { Client } = require('@notionhq/client');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const Slimbot = require('slimbot');
const http = require('http');

// 1. Port-Fix für Render (Hält den Service live)
http.createServer((req, res) => { res.writeHead(200); res.end('Bot Online'); }).listen(process.env.PORT || 3000);

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const slimbot = new Slimbot(process.env.TELEGRAM_BOT_TOKEN);

async function getNotionData(databaseId) {
  try {
    const response = await notion.databases.query({ database_id: databaseId });
    return response.results.map(page => {
      const p = page.properties;
      return {
        Task: p.Aufgabe?.title?.[0]?.plain_text || "Info",
        Instruction: p.Anweisung?.rich_text?.[0]?.plain_text || ""
      };
    });
  } catch (e) { return []; }
}

slimbot.on('message', async (message) => {
  if (!message.text) return;
  try {
    // Hol die Daten aus deinen Tabellen (IDs aus deinen Screenshots)
    const config = await getNotionData('2e1c841ccef980708df2ecee5f0c2df0');
    const studios = await getNotionData('2e0c841ccef980b49c4aefb4982294f0');
    const bios = await getNotionData('2e0c841ccef9807e9b73c9666ce4fcb0');

    // WICHTIG: Korrekte Modell-Initialisierung
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    const systemPrompt = `Du bist der L'Agentur A&R Bot. Ton: Music Industry Casual. 
    Hier sind deine Regeln und Daten: ${JSON.stringify({config, studios, bios})}.
    Antworte locker auf: ${message.text}`;

    const result = await model.generateContent(systemPrompt);
    slimbot.sendMessage(message.chat.id, result.response.text());
  } catch (err) {
    console.error("KI Fehler:", err.message);
    slimbot.sendMessage(message.chat.id, "Digger, die KI hat gerade Schluckauf. Probier's nochmal.");
  }
});

// 2. Der 409-Killer: Versucht es bei Konflikt einfach automatisch neu
const start = async () => {
  try {
    await slimbot.deleteWebhook({ drop_pending_updates: true });
    slimbot.startPolling((err) => {
      if (err && err.includes('409')) {
        console.log("Alt-Prozess blockiert noch. Neustart in 10s...");
        setTimeout(start, 10000);
      }
    });
  } catch (e) { setTimeout(start, 10000); }
};

start();
