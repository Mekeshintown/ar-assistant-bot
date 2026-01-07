const { Client } = require('@notionhq/client');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const Slimbot = require('slimbot');

// 1. Initialisierung der Schnittstellen
const notion = new Client({ auth: process.env.NOTION_TOKEN });
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const slimbot = new Slimbot(process.env.TELEGRAM_BOT_TOKEN);

// Hilfsfunktion: Daten aus Notion laden
async function getNotionData(databaseId) {
  const response = await notion.databases.query({ database_id: databaseId });
  return response.results.map(page => page.properties);
}

slimbot.on('message', async (message) => {
  const chatId = message.chat.id;
  const userInput = message.text;

  try {
    // 2. Daten live aus deinen Notion-IDs ziehen
    const config = await getNotionData('2e1c841ccef980708df2ecee5f0c2df0');
    const studios = await getNotionData('2e0c841ccef980b49c4aefb4982294f0');
    const bios = await getNotionData('2e0c841ccef9807e9b73c9666ce4fcb0');

    // 3. Den Kontext für die KI zusammenbauen (Brain Prompt)
    const systemInstruction = `
      Du bist der L'Agentur A&R Bot. Dein Ton: Music Industry Casual.
      Regeln aus Notion: ${JSON.stringify(config)}
      Studio-Daten: ${JSON.stringify(studios)}
      Artist-Bios: ${JSON.stringify(bios)}
      
      Aufgabe: Antworte präzise auf Basis dieser Daten. Wenn Infos fehlen, schreibe [INFO FEHLT].
    `;

    // 4. KI-Antwort generieren (Gemini 1.5 Flash für Speed)
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash", systemInstruction });
    const result = await model.generateContent(userInput);
    const responseText = result.response.text();

    // 5. Antwort an Telegram senden
    slimbot.sendMessage(chatId, responseText);

  } catch (error) {
    console.error("Fehler:", error);
    slimbot.sendMessage(chatId, "Digger, da gabs ein Problem mit der Verbindung zu Notion.");
  }
});

// --- NEUER START-BLOCK GEGEN 409 FEHLER ---

const start = async () => {
  try {
    console.log("ERZWINGE RESET...");
    // 1. Webhook mit Gewalt löschen und alle alten Nachrichten ignorieren
    await slimbot.deleteWebhook({ drop_pending_updates: true });
    
    // 2. 15 Sekunden warten, damit Render Zeit hat, den alten Prozess zu stoppen
    console.log("Warte 15 Sekunden auf Telegram Sync, damit der alte Prozess stirbt...");
    setTimeout(() => {
      console.log("BOT GEHT JETZT LIVE.");
      slimbot.startPolling((err) => {
        if (err) {
          // Falls doch noch ein 409 kommt, versuchen wir es nach 10s einfach nochmal automatisch
          console.error("Konflikt (409) erkannt. Starte automatischen Retry in 10s...");
          setTimeout(start, 10000);
        }
      });
    }, 15000);
  } catch (err) {
    console.error("Start-Fehler:", err);
    // Bei Fehlern beim Löschen des Webhooks auch neu versuchen
    setTimeout(start, 10000);
  }
};

start();
