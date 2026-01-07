const { Client } = require('@notionhq/client');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const Slimbot = require('slimbot');
const http = require('http');

// 1. Render Health Check (Hält den Paid Service am Leben)
http.createServer((req, res) => {
  res.writeHead(200);
  res.end('A&R Bot is online');
}).listen(process.env.PORT || 3000);

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const slimbot = new Slimbot(process.env.TELEGRAM_BOT_TOKEN);

async function getNotionData(databaseId) {
  try {
    const response = await notion.databases.query({ database_id: databaseId });
    return response.results.map(page => {
      const p = page.properties;
      return {
        Name: p.Name?.title?.[0]?.plain_text || p.Artist?.rich_text?.[0]?.plain_text || "Unbekannt",
        Details: p.Bio?.rich_text?.[0]?.plain_text || p.Details?.rich_text?.[0]?.plain_text || ""
      };
    });
  } catch (e) { return []; }
}

slimbot.on('message', async (message) => {
  if (!message || !message.text) return;
  try {
    const [config, studios, bios] = await Promise.all([
      getNotionData('2e1c841ccef980708df2ecee5f0c2df0'),
      getNotionData('2e0c841ccef980b49c4aefb4982294f0'),
      getNotionData('2e0c841ccef9807e9b73c9666ce4fcb0')
    ]);

    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    const prompt = `Du bist der L'Agentur A&R Bot. Ton: Music Industry Casual. Daten: ${JSON.stringify({config, studios, bios})}. Frage: ${message.text}`;
    
    const result = await model.generateContent(prompt);
    slimbot.sendMessage(message.chat.id, result.response.text());
  } catch (err) { console.error("Fehler bei Nachricht:", err.message); }
});

// 2. DER ULTIMATIVE 409-STOPPER
const startWithRetry = async () => {
  console.log("--- START-SEQUENZ AKTIVIERT ---");
  try {
    // Erzwingt das Ende aller alten Verbindungen
    await slimbot.deleteWebhook({ drop_pending_updates: true });
    console.log("Leitung zu Telegram bereinigt...");
    
    // Kurze Pause, damit Render den alten Prozess stoppen kann
    setTimeout(() => {
      console.log("Polling wird jetzt gestartet...");
      slimbot.startPolling((err) => {
        if (err) {
          console.log("Konflikt (409) erkannt. Ich kille die alte Session und starte in 10s neu...");
          setTimeout(startWithRetry, 10000);
        }
      });
    }, 5000);
  } catch (e) {
    console.log("Fehler beim Start, neuer Versuch in 10s...");
    setTimeout(startWithRetry, 10000);
  }
};

// Verhindert, dass der Bot bei einem Fehler komplett abstürzt
process.on('unhandledRejection', (reason) => {
  console.log('Abgefangener Background-Fehler:', reason.message || reason);
});

startWithRetry();
