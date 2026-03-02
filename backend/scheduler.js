const cron = require('node-cron');
const axios = require('axios');
const ical = require('node-ical');
const {
    getConfig,
    getAllConfig,
    addLog,
    getEnabledWhatsAppTargets,
    getEnabledIcalSources,
    getCustomReminders
} = require('./database');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.resolve(__dirname, '../.env') });

let dailyDutyJob = null;
let collectionAlertJob = null;
let cleaningReminderJob = null;
const customReminderJobs = {};

const isTruthy = (value, fallback = false) => {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
        if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
    }
    return fallback;
};

const parseDaysBefore = (value) => {
    const parsed = Number.parseInt(String(value ?? '1'), 10);
    if (Number.isNaN(parsed)) return 1;
    return Math.max(0, Math.min(14, parsed));
};

const parseTimeToCron = (timeStr) => {
    const fallback = '0 19 * * *';
    const raw = String(timeStr || '').trim();
    const match = raw.match(/^(\d{1,2}):(\d{2})$/);
    if (!match) return fallback;

    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return fallback;

    return `${minute} ${hour} * * *`;
};

const toMidnight = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());
const daysBetween = (fromDate, toDate) => {
    const msPerDay = 24 * 60 * 60 * 1000;
    return Math.round((toMidnight(toDate) - toMidnight(fromDate)) / msPerDay);
};

const getCollectionEventByOffsetDays = async (icalUrl, offsetDays = 1) => {
    if (!icalUrl) {
        return {
            wasteType: 'No iCal URL configured',
            hasCollection: false,
            targetDate: null,
            targetDateLabel: 'Unknown'
        };
    }

    try {
        const res = await axios.get(icalUrl);
        const events = ical.parseICS(res.data);

        const now = new Date();
        const targetDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offsetDays);

        let wasteType = 'No collection scheduled';
        let hasCollection = false;

        for (const key in events) {
            if (!Object.prototype.hasOwnProperty.call(events, key)) continue;
            const ev = events[key];
            if (ev.type !== 'VEVENT' || !ev.start) continue;

            const evDate = new Date(ev.start);
            if (
                evDate.getFullYear() === targetDate.getFullYear() &&
                evDate.getMonth() === targetDate.getMonth() &&
                evDate.getDate() === targetDate.getDate()
            ) {
                wasteType = ev.summary || 'Collection Event';
                hasCollection = true;
                break;
            }
        }

        return {
            wasteType,
            hasCollection,
            targetDate,
            targetDateLabel: targetDate.toLocaleDateString()
        };
    } catch (err) {
        console.error('Error fetching iCal:', err.message);
        return {
            wasteType: 'Failed to fetch schedule',
            hasCollection: false,
            targetDate: null,
            targetDateLabel: 'Unknown'
        };
    }
};

const getNextCollectionEvent = async (icalUrl) => {
    if (!icalUrl) {
        return {
            wasteType: 'No iCal URL configured',
            hasCollection: false,
            eventDate: null,
            eventDateLabel: 'Unknown',
            daysUntilCollection: null
        };
    }

    try {
        const res = await axios.get(icalUrl);
        const events = ical.parseICS(res.data);
        const today = toMidnight(new Date());

        let nextDate = null;
        let nextWasteType = null;

        for (const key in events) {
            if (!Object.prototype.hasOwnProperty.call(events, key)) continue;
            const ev = events[key];
            if (ev.type !== 'VEVENT' || !ev.start) continue;

            const evDate = toMidnight(new Date(ev.start));
            if (evDate < today) continue;

            if (!nextDate || evDate < nextDate) {
                nextDate = evDate;
                nextWasteType = ev.summary || 'Collection Event';
            }
        }

        if (!nextDate) {
            return {
                wasteType: 'No upcoming collection scheduled',
                hasCollection: false,
                eventDate: null,
                eventDateLabel: 'Unknown',
                daysUntilCollection: null
            };
        }

        return {
            wasteType: nextWasteType,
            hasCollection: true,
            eventDate: nextDate,
            eventDateLabel: nextDate.toLocaleDateString(),
            daysUntilCollection: daysBetween(today, nextDate)
        };
    } catch (err) {
        console.error('Error fetching iCal:', err.message);
        return {
            wasteType: 'Failed to fetch schedule',
            hasCollection: false,
            eventDate: null,
            eventDateLabel: 'Unknown',
            daysUntilCollection: null
        };
    }
};

const getEnabledTargetsWithFallback = (config, enabledTargets) => {
    const groupJids = enabledTargets.map((target) => target.jid).filter(Boolean);
    const fallbackJid = config.group_jid || process.env.WHATSAPP_GROUP_JID;
    return groupJids.length > 0 ? groupJids : (fallbackJid ? [fallbackJid] : []);
};

const getActiveIcalUrl = (config, enabledIcalSources) => enabledIcalSources[0]?.url || config.ical_url;

const sendToWhatsAppTargets = async (finalTargetJids, finalMessage) => {
    const baseUrl = process.env.EVOLUTION_BASE_URL || 'http://127.0.0.1:8080';
    const instance = process.env.EVOLUTION_INSTANCE || 'my-whatsapp';
    const apiKey = process.env.EVOLUTION_API_KEY;

    if (!apiKey) {
        return {
            waDelivered: 0,
            waResults: ['Missing Evolution API Key'],
            configError: 'Missing Evolution API Key'
        };
    }

    const endpoint = `/message/sendText/${instance}`;
    const url = `${baseUrl.replace(/\/$/, '')}${endpoint}`;

    const waResults = [];
    let waDelivered = 0;

    for (const jid of finalTargetJids) {
        try {
            const payload = { number: jid, text: finalMessage };
            const response = await axios.post(url, payload, {
                headers: { 'Content-Type': 'application/json', apikey: apiKey }
            });
            waDelivered += 1;
            waResults.push(`${jid}: HTTP ${response.status}`);
        } catch (e) {
            const detail = e.response?.data?.message || e.message;
            waResults.push(`${jid}: Failed (${detail})`);
        }
    }

    return { waDelivered, waResults, configError: null };
};

const sendTelegramSummary = async (config, summaryText) => {
    const notificationToken =
        config.telegram_bot_token ||
        process.env.TELEGRAM_BOT_TOKEN ||
        config.gateio_api_key ||
        process.env.GATEIO_API_KEY;
    const notificationChatId =
        config.telegram_chat_id ||
        process.env.TELEGRAM_CHAT_ID ||
        config.gateio_api_secret ||
        process.env.GATEIO_API_SECRET;

    const telegramEnabled = isTruthy(config.telegram_enabled, true);
    if (!telegramEnabled) return 'Disabled';
    if (!notificationToken || !notificationChatId) return 'Unconfigured';

    try {
        const tgUrl = `https://api.telegram.org/bot${notificationToken}/sendMessage`;
        await axios.post(tgUrl, {
            chat_id: notificationChatId,
            text: summaryText
        });
        return 'Delivered';
    } catch (e) {
        return e.response?.data?.description || e.message;
    }
};

const generateDailyDutyPreview = async (isManual = false) => {
    const [config, enabledTargets, enabledIcalSources] = await Promise.all([
        getAllConfig(),
        getEnabledWhatsAppTargets('daily'),
        getEnabledIcalSources()
    ]);

    const finalTargetJids = getEnabledTargetsWithFallback(config, enabledTargets);
    const activeIcalUrl = getActiveIcalUrl(config, enabledIcalSources);

    const template = config.template || '';

    const today = new Date();
    let weekday = today.getDay() - 1;
    if (weekday === -1) weekday = 6;

    const skipScheduled = weekday === 6 && !isManual;

    // Rooms are assigned Mon(0)=1 through Sat(5)=6; Sunday(6) is a rest day.
    const rooms = [1, 2, 3, 4, 5, 6];
    const today_room = weekday < 6 ? rooms[weekday] : null;
    const next_index = (weekday + 1) % 6; // wraps Sat→0 (Room 1 = Monday)
    const tmw_room = rooms[next_index];
    // On Saturday the next duty day is Monday (Sunday is a rest day), not "tomorrow".
    const tmw_label = weekday === 5 ? 'Monday' : 'Tomorrow';
    const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const today_name = weekday < 6 ? days[weekday] : 'Sunday';

    const collectionInfo = await getCollectionEventByOffsetDays(activeIcalUrl, 1);

    const finalMessage = template
        .replace(/{today_name}/g, today_name)
        .replace(/{today_room}/g, today_room)
        .replace(/{tmw_room}/g, tmw_room)
        .replace(/{tmw_label}/g, tmw_label)
        .replace(/{tomorrow_waste_type}/g, collectionInfo.wasteType);

    return {
        config,
        finalTargetJids,
        activeIcalUrl,
        template,
        finalMessage,
        skipScheduled,
        canSend: Boolean(template) && finalTargetJids.length > 0,
        wasteType: collectionInfo.wasteType
    };
};

const generateCollectionAlertPreview = async () => {
    const [config, enabledTargets, enabledIcalSources] = await Promise.all([
        getAllConfig(),
        getEnabledWhatsAppTargets('collection'),
        getEnabledIcalSources()
    ]);

    const finalTargetJids = getEnabledTargetsWithFallback(config, enabledTargets);
    const activeIcalUrl = getActiveIcalUrl(config, enabledIcalSources);
    const daysBefore = parseDaysBefore(config.collection_alert_days_before);

    const defaultTemplate =
        '🚛 *Collection Reminder*\n\nUpcoming collection: *{collection_waste_type}*\nCollection day: *{collection_date}* ({collection_day_name})\nAlert lead time: {days_until_collection} day(s).';
    const template = config.collection_template || defaultTemplate;

    const collectionInfo = await getNextCollectionEvent(activeIcalUrl);
    const eventDate = collectionInfo.eventDate;
    const dayName = eventDate
        ? eventDate.toLocaleDateString(undefined, { weekday: 'long' })
        : 'Unknown';

    const safeTemplate = template.replace(/\\'/g, "'");
    const finalMessage = safeTemplate
        .replace(/{collection_waste_type}/g, collectionInfo.wasteType)
        .replace(/{collection_date}/g, collectionInfo.eventDateLabel)
        .replace(/{collection_day_name}/g, dayName)
        .replace(/{days_until_collection}/g, String(collectionInfo.daysUntilCollection ?? daysBefore))
        .replace(/{tomorrow_waste_type}/g, collectionInfo.wasteType);

    return {
        config,
        finalTargetJids,
        activeIcalUrl,
        template,
        finalMessage,
        daysBefore,
        collectionInfo,
        shouldSendToday: collectionInfo.hasCollection && (collectionInfo.daysUntilCollection === daysBefore),
        canSend: Boolean(template) && finalTargetJids.length > 0
    };
};

const sendWhatsAppMessage = async (isManual = false) => {
    try {
        const preview = await generateDailyDutyPreview(isManual);
        const { config, finalTargetJids, finalMessage, skipScheduled } = preview;

        if (!preview.canSend) {
            await addLog('ERROR', 'Missing Template or JID', 'Cannot send daily duty alert without template/target configuration.');
            return { status: 'ERROR', action: 'daily-duty', detail: 'Missing template or target configuration.' };
        }

        if (skipScheduled) {
            await addLog('SKIPPED', 'Sunday Rest Day', 'Daily duty alert skipped automatically on Sunday.');
            return { status: 'SKIPPED', action: 'daily-duty', detail: 'Skipped on Sunday.' };
        }

        const { waDelivered, waResults, configError } = await sendToWhatsAppTargets(finalTargetJids, finalMessage);
        if (configError) {
            await addLog('ERROR', 'Missing Evolution API Key', 'Check .env file.');
            return { status: 'ERROR', action: 'daily-duty', detail: 'Missing Evolution API key.' };
        }

        const summaryTimestamp = new Date().toLocaleString();
        const summaryStatus = waDelivered === 0 ? 'FAILED' : 'SUCCESS';
        const summaryText = [
            `Daily Duty Summary: ${summaryStatus}`,
            `Mode: ${isManual ? 'Manual' : 'Scheduled'}`,
            `Time: ${summaryTimestamp}`,
            `WhatsApp Delivered: ${waDelivered}/${finalTargetJids.length}`,
            `Targets: ${waResults.join(' | ')}`
        ].join('\n');

        const tgStatus = await sendTelegramSummary(config, summaryText);

        if (waDelivered === 0) {
            await addLog('ERROR', 'Daily Duty Alert Failed', `WA: ${waResults.join(' | ')} | TG: ${tgStatus}`);
            return { status: 'ERROR', action: 'daily-duty', detail: `WA delivery failed. TG: ${tgStatus}` };
        }

        await addLog(
            'SUCCESS',
            'Daily Duty Alert Sent',
            `WA Delivered ${waDelivered}/${finalTargetJids.length}: ${waResults.join(' | ')} | TG: ${tgStatus}`
        );
        return {
            status: 'SUCCESS',
            action: 'daily-duty',
            detail: `WA ${waDelivered}/${finalTargetJids.length}, TG: ${tgStatus}`
        };
    } catch (error) {
        await addLog('ERROR', 'System Failure', error.message);
        return { status: 'ERROR', action: 'daily-duty', detail: error.message };
    }
};

const sendCollectionAlert = async (isManual = false, options = {}) => {
    try {
        const preview = await generateCollectionAlertPreview();
        const {
            config,
            finalTargetJids,
            finalMessage,
            collectionInfo,
            daysBefore
        } = preview;

        if (!preview.canSend) {
            await addLog('ERROR', 'Missing Collection Template or JID', 'Cannot send collection alert without template/target configuration.');
            return { status: 'ERROR', action: 'collection-alert', detail: 'Missing collection template or target configuration.' };
        }

        const collectionEnabled = isTruthy(config.collection_alert_enabled, true);
        if (!collectionEnabled && !isManual) {
            await addLog('SKIPPED', 'Collection Alert Disabled', 'Collection alert job is disabled in configuration.');
            return { status: 'SKIPPED', action: 'collection-alert', detail: 'Collection alert disabled.' };
        }

        if (!collectionInfo.hasCollection && !options.forceSend) {
            await addLog('SKIPPED', 'No Upcoming Collection', 'No upcoming collection event found in calendar.');
            return { status: 'SKIPPED', action: 'collection-alert', detail: 'No upcoming collection event found.' };
        }

        if (collectionInfo.hasCollection && collectionInfo.daysUntilCollection !== daysBefore && !options.forceSend) {
            await addLog(
                'SKIPPED',
                'Collection Alert Not Due',
                `Next collection is in ${collectionInfo.daysUntilCollection} day(s); configured lead time is ${daysBefore} day(s).`
            );
            return {
                status: 'SKIPPED',
                action: 'collection-alert',
                detail: `Not due yet (${collectionInfo.daysUntilCollection} days remaining).`
            };
        }

        const { waDelivered, waResults, configError } = await sendToWhatsAppTargets(finalTargetJids, finalMessage);
        if (configError) {
            await addLog('ERROR', 'Missing Evolution API Key', 'Check .env file.');
            return { status: 'ERROR', action: 'collection-alert', detail: 'Missing Evolution API key.' };
        }

        const summaryTimestamp = new Date().toLocaleString();
        const summaryStatus = waDelivered === 0 ? 'FAILED' : 'SUCCESS';
        const summaryText = [
            `Collection Alert Summary: ${summaryStatus}`,
            `Mode: ${isManual ? 'Manual' : 'Scheduled'}`,
            `Time: ${summaryTimestamp}`,
            `Collection: ${collectionInfo.wasteType}`,
            `WhatsApp Delivered: ${waDelivered}/${finalTargetJids.length}`,
            `Targets: ${waResults.join(' | ')}`
        ].join('\n');

        const tgStatus = await sendTelegramSummary(config, summaryText);

        if (waDelivered === 0) {
            await addLog('ERROR', 'Collection Alert Failed', `WA: ${waResults.join(' | ')} | TG: ${tgStatus}`);
            return { status: 'ERROR', action: 'collection-alert', detail: `WA delivery failed. TG: ${tgStatus}` };
        }

        await addLog(
            'SUCCESS',
            'Collection Alert Sent',
            `WA Delivered ${waDelivered}/${finalTargetJids.length}: ${waResults.join(' | ')} | TG: ${tgStatus}`
        );
        return {
            status: 'SUCCESS',
            action: 'collection-alert',
            detail: `WA ${waDelivered}/${finalTargetJids.length}, TG: ${tgStatus}`
        };
    } catch (error) {
        await addLog('ERROR', 'System Failure', error.message);
        return { status: 'ERROR', action: 'collection-alert', detail: error.message };
    }
};
const generateCleaningReminderPreview = async () => {
    const [config, enabledTargets] = await Promise.all([
        getAllConfig(),
        getEnabledWhatsAppTargets('cleaning')
    ]);

    const finalTargetJids = getEnabledTargetsWithFallback(config, enabledTargets);
    const defaultTemplate =
        '\ud83e\uddf9 *Weekly Reminder*\n\nHey everyone! This is your weekly reminder.\n\nAll members please review tasks. Let\'s keep our home clean together! \ud83d\udcaa\n\n(This is an automatic message)';
    const template = config.cleaning_reminder_template || defaultTemplate;

    return {
        config,
        finalTargetJids,
        template,
        finalMessage: template,
        canSend: Boolean(template) && finalTargetJids.length > 0
    };
};

const sendCleaningReminder = async (isManual = false) => {
    try {
        const preview = await generateCleaningReminderPreview();
        const { config, finalTargetJids, finalMessage } = preview;

        if (!preview.canSend) {
            await addLog('ERROR', 'Missing Cleaning Template or JID', 'Cannot send cleaning reminder without template/target configuration.');
            return { status: 'ERROR', action: 'cleaning-reminder', detail: 'Missing template or target configuration.' };
        }

        const cleaningEnabled = isTruthy(config.cleaning_reminder_enabled, true);
        if (!cleaningEnabled && !isManual) {
            await addLog('SKIPPED', 'Cleaning Reminder Disabled', 'Cleaning reminder is disabled in configuration.');
            return { status: 'SKIPPED', action: 'cleaning-reminder', detail: 'Cleaning reminder disabled.' };
        }

        const { waDelivered, waResults, configError } = await sendToWhatsAppTargets(finalTargetJids, finalMessage);
        if (configError) {
            await addLog('ERROR', 'Missing Evolution API Key', 'Check .env file.');
            return { status: 'ERROR', action: 'cleaning-reminder', detail: 'Missing Evolution API key.' };
        }

        const summaryTimestamp = new Date().toLocaleString();
        const summaryStatus = waDelivered === 0 ? 'FAILED' : 'SUCCESS';
        const summaryText = [
            `Cleaning Reminder Summary: ${summaryStatus}`,
            `Mode: ${isManual ? 'Manual' : 'Scheduled'}`,
            `Time: ${summaryTimestamp}`,
            `WhatsApp Delivered: ${waDelivered}/${finalTargetJids.length}`,
            `Targets: ${waResults.join(' | ')}`
        ].join('\n');

        const tgStatus = await sendTelegramSummary(config, summaryText);

        if (waDelivered === 0) {
            await addLog('ERROR', 'Cleaning Reminder Failed', `WA: ${waResults.join(' | ')} | TG: ${tgStatus}`);
            return { status: 'ERROR', action: 'cleaning-reminder', detail: `WA delivery failed. TG: ${tgStatus}` };
        }

        await addLog(
            'SUCCESS',
            'Cleaning Reminder Sent',
            `WA Delivered ${waDelivered}/${finalTargetJids.length}: ${waResults.join(' | ')} | TG: ${tgStatus}`
        );
        return {
            status: 'SUCCESS',
            action: 'cleaning-reminder',
            detail: `WA ${waDelivered}/${finalTargetJids.length}, TG: ${tgStatus}`
        };
    } catch (error) {
        await addLog('ERROR', 'System Failure', error.message);
        return { status: 'ERROR', action: 'cleaning-reminder', detail: error.message };
    }
};

const sendCustomReminder = async (reminder, isManual = false) => {
    try {
        const config = await getAllConfig();
        const { id, title, template, targets } = reminder;

        if (!template || !targets || targets.length === 0) {
            await addLog('ERROR', `Custom Reminder Error: ${title}`, 'Missing template or target configuration.');
            return { status: 'ERROR', action: 'custom-reminder', detail: 'Missing template or targets.' };
        }

        const { waDelivered, waResults, configError } = await sendToWhatsAppTargets(targets, template);
        if (configError) {
            await addLog('ERROR', 'Missing Evolution API Key', 'Check .env file.');
            return { status: 'ERROR', action: 'custom-reminder', detail: 'Missing Evolution API key.' };
        }

        const summaryTimestamp = new Date().toLocaleString();
        const summaryStatus = waDelivered === 0 ? 'FAILED' : 'SUCCESS';
        const summaryText = [
            `Custom Reminder [${title}] Summary: ${summaryStatus}`,
            `Mode: ${isManual ? 'Manual' : 'Scheduled'}`,
            `Time: ${summaryTimestamp}`,
            `WhatsApp Delivered: ${waDelivered}/${targets.length}`,
            `Targets: ${waResults.join(' | ')}`
        ].join('\n');

        const tgStatus = await sendTelegramSummary(config, summaryText);

        if (waDelivered === 0) {
            await addLog('ERROR', title, `WA: ${waResults.join(' | ')} | TG: ${tgStatus}`);
            return { status: 'ERROR', action: 'custom-reminder', detail: `WA delivery failed. TG: ${tgStatus}` };
        }

        await addLog(
            'SUCCESS',
            title,
            `WA Delivered ${waDelivered}/${targets.length}: ${waResults.join(' | ')} | TG: ${tgStatus}`
        );
        return {
            status: 'SUCCESS',
            action: 'custom-reminder',
            detail: `WA ${waDelivered}/${targets.length}, TG: ${tgStatus}`
        };
    } catch (error) {
        await addLog('ERROR', 'System Failure', error.message);
        return { status: 'ERROR', action: 'custom-reminder', detail: error.message };
    }
};

const initScheduler = async () => {
    const [dailySchedule, config] = await Promise.all([
        getConfig('schedule'),
        getAllConfig()
    ]);

    if (dailyDutyJob) dailyDutyJob.stop();
    if (collectionAlertJob) collectionAlertJob.stop();
    if (cleaningReminderJob) cleaningReminderJob.stop();

    if (dailySchedule) {
        dailyDutyJob = cron.schedule(dailySchedule, () => sendWhatsAppMessage(false));
        console.log(`Daily duty scheduler initialized with cron pattern: "${dailySchedule}"`);
    }

    const collectionEnabled = isTruthy(config.collection_alert_enabled, true);
    if (collectionEnabled) {
        const collectionCron = parseTimeToCron(config.collection_alert_time);
        collectionAlertJob = cron.schedule(collectionCron, () => sendCollectionAlert(false));
        console.log(`Collection alert scheduler initialized with cron pattern: "${collectionCron}"`);
    }

    const cleaningEnabled = isTruthy(config.cleaning_reminder_enabled, true);
    if (cleaningEnabled) {
        const cleaningCron = config.cleaning_reminder_schedule || '0 16 * * 0';
        cleaningReminderJob = cron.schedule(cleaningCron, () => sendCleaningReminder(false));
        console.log(`Weekly reminder scheduler initialized with cron pattern: "${cleaningCron}"`);
    }

    // Custom Reminders
    Object.values(customReminderJobs).forEach(job => job.stop());
    for (const key in customReminderJobs) delete customReminderJobs[key];

    try {
        const customReminders = await getCustomReminders();
        for (const reminder of customReminders) {
            if (reminder.enabled && reminder.cron_schedule) {
                const job = cron.schedule(reminder.cron_schedule, () => sendCustomReminder(reminder, false));
                customReminderJobs[reminder.id] = job;
                console.log(`Custom reminder [${reminder.title}] initialized with cron pattern: "${reminder.cron_schedule}"`);
            }
        }
    } catch (err) {
        console.error('Failed to initialize custom reminders scheduling:', err.message);
    }
};

module.exports = {
    initScheduler,
    sendWhatsAppMessage,
    sendCollectionAlert,
    sendCleaningReminder,
    sendCustomReminder,
    generateCollectionAlertPreview,
    generateDailyDutyPreview,
    generateCleaningReminderPreview
};
