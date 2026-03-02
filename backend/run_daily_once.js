const axios = require('axios');
const dotenv = require('dotenv');
const path = require('path');
const { sendWhatsAppMessage, sendCollectionAlert } = require('./scheduler');

dotenv.config({ path: path.resolve(__dirname, '../.env'), override: true });

const TARGET_TIME = process.env.DAILY_AUTOMATION_FIRE_TIME || '19:00';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const msUntilTimeToday = (timeStr) => {
  const now = new Date();
  const match = String(timeStr).trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return 0;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return 0;

  const target = new Date(now);
  target.setHours(hour, minute, 0, 0);

  const delta = target.getTime() - now.getTime();
  return delta > 0 ? delta : 0;
};

const sendTelegram = async (text) => {
  const token = process.env.TELEGRAM_BOT_TOKEN || process.env.GATEIO_API_KEY;
  const chatId = process.env.TELEGRAM_CHAT_ID || process.env.GATEIO_API_SECRET;
  if (!token || !chatId) return;

  const tgUrl = `https://api.telegram.org/bot${token}/sendMessage`;
  await axios.post(tgUrl, { chat_id: chatId, text });
};

const formatResult = (result) => {
  if (!result) return '- UNKNOWN: No result returned';
  return `- ${result.action || 'action'}: ${result.status || 'UNKNOWN'} (${result.detail || 'no detail'})`;
};

(async () => {
  const startTime = new Date();
  try {
    await sendTelegram(`Automation Runner Started\nTime: ${startTime.toLocaleString()}\nTarget send time: ${TARGET_TIME}`);

    const waitMs = msUntilTimeToday(TARGET_TIME);
    if (waitMs > 0) {
      await sleep(waitMs);
    }

    const dailyResult = await sendWhatsAppMessage(false);
    const collectionResult = await sendCollectionAlert(false);

    const finishTime = new Date();
    const summary = [
      'Automation Runner Completed',
      `Started: ${startTime.toLocaleString()}`,
      `Finished: ${finishTime.toLocaleString()}`,
      formatResult(dailyResult),
      formatResult(collectionResult)
    ].join('\n');

    await sendTelegram(summary);
    process.exit(0);
  } catch (error) {
    const failTime = new Date();
    await sendTelegram(
      [
        'Automation Runner Failed',
        `Started: ${startTime.toLocaleString()}`,
        `Failed: ${failTime.toLocaleString()}`,
        `Error: ${error.message}`
      ].join('\n')
    );
    process.exit(1);
  }
})();
