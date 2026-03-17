const cron = require('node-cron');
const cronParser = require('cron-parser');
const axios = require('axios');
const ical = require('node-ical');
const {
    getConfig,
    getAllConfig,
    addLog,
    getEnabledWhatsAppTargets,
    getEnabledIcalSources,
    getCustomReminders,
    getWhatsAppTargets
} = require('./database');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.resolve(__dirname, '../.env') });

let dailyDutyJob = null;
let collectionAlertJob = null;
let cleaningReminderJob = null;
const customReminderJobs = {};
// IMPORTANT: TIMEZONE must be set explicitly in .env. On DST spring-forward days,
// node-cron can miss scheduled triggers if the process was started before the
// transition. Restarting PM2 after DST re-initializes crons correctly.
const TIMEZONE = process.env.TIMEZONE || 'America/Vancouver';

/**
 * Gets the next trigger time in ISO format for a given cron expression.
 */
const getNextTriggerTime = (cronExpression) => {
    if (!cronExpression) return null;
    try {
        const interval = cronParser.CronExpressionParser.parse(cronExpression, { tz: TIMEZONE });
        return interval.next().toDate().toISOString();
    } catch (err) {
        return null;
    }
};

/**
 * Gets local date components for the configured timezone.
 * Returns an object with { year, month, day, weekday, hour }
 */
const getLocalComponents = (date = new Date()) => {
    const fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: TIMEZONE,
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        second: 'numeric',
        hour12: false,
        weekday: 'long'
    });
    const parts = fmt.formatToParts(date).reduce((acc, part) => {
        acc[part.type] = part.value;
        return acc;
    }, {});

    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    return {
        year: parseInt(parts.year),
        month: parseInt(parts.month) - 1,
        day: parseInt(parts.day),
        weekday: days.indexOf(parts.weekday),
        hour: parseInt(parts.hour)
    };
};

/**
 * Checks if two dates are the same day in the configured timezone.
 */
const isSameDayInTimezone = (date1, date2) => {
    const c1 = getLocalComponents(date1);
    const c2 = getLocalComponents(date2);
    return c1.year === c2.year && c1.month === c2.month && c1.day === c2.day;
};

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
    const parsed = Number.parseInt(String(value ?? '0'), 10);
    if (Number.isNaN(parsed)) return 0;
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
        const localNow = getLocalComponents(now);
        const targetDate = new Date(localNow.year, localNow.month, localNow.day + offsetDays);

        let wasteType = 'No collection scheduled';
        let hasCollection = false;

        for (const key in events) {
            if (!Object.prototype.hasOwnProperty.call(events, key)) continue;
            const ev = events[key];
            if (!ev.start) continue; // Skip non-event entries (like VCALENDAR, VTIMEZONE)
            const evDateRaw = new Date(ev.start);

            let evYear, evMonth, evDay;
            if (ev.start.dateOnly || (evDateRaw.getUTCHours() === 0 && evDateRaw.getUTCMinutes() === 0)) {
                evYear = evDateRaw.getUTCFullYear();
                evMonth = evDateRaw.getUTCMonth();
                evDay = evDateRaw.getUTCDate();
            } else {
                const evLocal = getLocalComponents(evDateRaw);
                evYear = evLocal.year;
                evMonth = evLocal.month;
                evDay = evLocal.day;
            }
            const evDate = new Date(evYear, evMonth, evDay);

            if (isSameDayInTimezone(evDate, targetDate)) {
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

const checkCollectionForDate = async (icalUrl, targetDate) => {
    if (!icalUrl) {
        return {
            wasteType: '',
            hasCollection: false,
            targetDate: null,
            targetDateLabel: 'Unknown',
            nextCollectionDateStr: '',
            nextWasteType: ''
        };
    }

    try {
        const res = await axios.get(icalUrl);
        const events = ical.parseICS(res.data);

        let wasteType = '';
        let hasCollection = false;
        let nextCollectionDateStr = '';
        let nextWasteType = '';

        for (const key in events) {
            if (!Object.prototype.hasOwnProperty.call(events, key)) continue;
            const ev = events[key];
            if (!ev.start) continue; // Skip non-event entries (like VCALENDAR, VTIMEZONE)
            const evDateRaw = new Date(ev.start);

            let evYear, evMonth, evDay;
            if (ev.start.dateOnly || (evDateRaw.getUTCHours() === 0 && evDateRaw.getUTCMinutes() === 0)) {
                evYear = evDateRaw.getUTCFullYear();
                evMonth = evDateRaw.getUTCMonth();
                evDay = evDateRaw.getUTCDate();
            } else {
                const evLocal = getLocalComponents(evDateRaw);
                evYear = evLocal.year;
                evMonth = evLocal.month;
                evDay = evLocal.day;
            }
            const evDate = new Date(evYear, evMonth, evDay);

            if (isSameDayInTimezone(evDate, targetDate)) {
                wasteType = ev.summary || 'Collection Event';
                hasCollection = true;
            } else if (evDate > targetDate) {
                if (!nextCollectionDateStr || evDate < new Date(nextCollectionDateStr)) {
                    const localEvMonth = evDate.getMonth() + 1;
                    const localEvDay = evDate.getDate();
                    const localEvYear = evDate.getFullYear();
                    nextCollectionDateStr = `${localEvYear}-${localEvMonth.toString().padStart(2, '0')}-${localEvDay.toString().padStart(2, '0')}`;
                    nextWasteType = ev.summary || 'Collection Event';
                }
            }
        }

        return {
            wasteType,
            hasCollection,
            targetDate,
            targetDateLabel: targetDate.toLocaleDateString(),
            nextCollectionDateStr,
            nextWasteType
        };
    } catch (err) {
        console.error('Error fetching iCal:', err.message);
        return {
            wasteType: '',
            hasCollection: false,
            targetDate: null,
            targetDateLabel: 'Unknown',
            nextCollectionDateStr: '',
            nextWasteType: ''
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

        const localNow = getLocalComponents(new Date());
        const today = new Date(localNow.year, localNow.month, localNow.day);

        let nextDate = null;
        let nextWasteType = null;

        for (const key in events) {
            if (!Object.prototype.hasOwnProperty.call(events, key)) continue;
            const ev = events[key];
            if (ev.type !== 'VEVENT' || !ev.start) continue;

            const evDateRaw = new Date(ev.start);
            let evYear, evMonth, evDay;
            if (ev.start.dateOnly || (evDateRaw.getUTCHours() === 0 && evDateRaw.getUTCMinutes() === 0)) {
                evYear = evDateRaw.getUTCFullYear();
                evMonth = evDateRaw.getUTCMonth();
                evDay = evDateRaw.getUTCDate();
            } else {
                const evLocal = getLocalComponents(evDateRaw);
                evYear = evLocal.year;
                evMonth = evLocal.month;
                evDay = evLocal.day;
            }
            const evDate = new Date(evYear, evMonth, evDay);

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

    const local = getLocalComponents();
    let weekday = local.weekday - 1; // Mon=0, Tue=1, ..., Sat=5, Sun=-1
    if (weekday === -1) weekday = 6; // Sun=6

    const skipScheduled = weekday === 6 && !isManual;
    const nextTrigger = getNextTriggerTime(config.schedule);

    // Rooms are assigned Mon(0)=1 through Sat(5)=6; Sunday(6) is a rest day.
    const rooms = [1, 2, 3, 4, 5, 6];
    const today_room = weekday < 6 ? rooms[weekday] : null;
    const next_index = (weekday + 1) % 6; // wraps Sat→0 (Room 1 = Monday)
    const tmw_room = rooms[next_index];
    // On Saturday the next duty day is Monday (Sunday is a rest day), not "tomorrow".
    const tmw_label = weekday === 5 ? 'Monday' : 'Tomorrow';
    const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const today_name = weekday < 6 ? days[weekday] : 'Sunday';

    const collectionInfo = await checkCollectionForDate(activeIcalUrl, new Date(local.year, local.month, local.day + 1));

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
        nextTrigger,
        canSend: Boolean(template) && finalTargetJids.length > 0,
        wasteType: collectionInfo.wasteType
    };
};

const generateCollectionAlertPreview = async () => {
    try {
        const [config, enabledTargets] = await Promise.all([
            getAllConfig(),
            getEnabledWhatsAppTargets('collection')
        ]);

        const finalTargetJids = getEnabledTargetsWithFallback(config, enabledTargets);
        const daysBefore = parseDaysBefore(config.collection_alert_days_before);

        const defaultTemplate =
            '🚛 *Collection Reminder*\n\nUpcoming collection: *{collection_waste_type}*\nCollection day: *{collection_date}* ({collection_day_name})\nAlert lead time: {days_until_collection} day(s).\n\nNext scheduled collection: *{next_collection_waste_type}* on *{next_collection_date}* ({next_collection_day_name}).';

        // Step 1: Find the actual next collection event from iCal
        const enabledIcalSources = await getEnabledIcalSources();
        const icalSources = enabledIcalSources.length > 0 ? enabledIcalSources : (config.ical_url ? [{ url: config.ical_url }] : []);

        let upcomingCollection = null; // The next collection event
        let secondCollection = null;  // The collection after that

        for (const source of icalSources) {
            if (!isTruthy(source.enabled) && source.url !== config.ical_url) continue;

            try {
                const res = await axios.get(source.url);
                const events = ical.parseICS(res.data);

                const localNow = getLocalComponents(new Date());
                const today = new Date(localNow.year, localNow.month, localNow.day);

                // Collect all future events, sorted by date
                const futureEvents = [];
                for (const key in events) {
                    if (!Object.prototype.hasOwnProperty.call(events, key)) continue;
                    const ev = events[key];
                    if (!ev.start) continue;

                    const evDateRaw = new Date(ev.start);
                    let evYear, evMonth, evDay;
                    if (ev.start.dateOnly || (evDateRaw.getUTCHours() === 0 && evDateRaw.getUTCMinutes() === 0)) {
                        evYear = evDateRaw.getUTCFullYear();
                        evMonth = evDateRaw.getUTCMonth();
                        evDay = evDateRaw.getUTCDate();
                    } else {
                        const evLocal = getLocalComponents(evDateRaw);
                        evYear = evLocal.year;
                        evMonth = evLocal.month;
                        evDay = evLocal.day;
                    }
                    const evDate = new Date(evYear, evMonth, evDay);

                    if (evDate >= today) {
                        futureEvents.push({ date: evDate, wasteType: ev.summary || 'Collection Event' });
                    }
                }

                // Sort by date ascending
                futureEvents.sort((a, b) => a.date - b.date);

                // First event = upcoming collection, second = the one after
                if (futureEvents.length > 0 && (!upcomingCollection || futureEvents[0].date < upcomingCollection.date)) {
                    upcomingCollection = futureEvents[0];
                    secondCollection = futureEvents.length > 1 ? futureEvents[1] : null;
                }
            } catch (err) {
                console.error('Error fetching iCal source:', err.message);
            }
        }

        const template = config.collection_template || defaultTemplate;

        // Format the upcoming collection date
        let collectionDateStr = '(No Data)';
        let collectionDayName = '(No Data)';
        let collectionWasteType = '(No Data)';
        let daysUntilCollection = 0;
        let hasCollection = false;

        if (upcomingCollection) {
            hasCollection = true;
            collectionDateStr = upcomingCollection.date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
            collectionDayName = upcomingCollection.date.toLocaleDateString('en-US', { weekday: 'long' });
            collectionWasteType = upcomingCollection.wasteType;
            const localNow = getLocalComponents(new Date());
            const today = new Date(localNow.year, localNow.month, localNow.day);
            daysUntilCollection = daysBetween(today, upcomingCollection.date);
        }

        // Format the next collection after the upcoming one
        let nextDateFormatted = '(No Upcoming Data)';
        let nextDayName = '(No Upcoming Data)';
        let nextWasteType = '(No Upcoming Data)';

        if (secondCollection) {
            nextDateFormatted = secondCollection.date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
            nextDayName = secondCollection.date.toLocaleDateString('en-US', { weekday: 'long' });
            nextWasteType = secondCollection.wasteType;
        }

        // Should we send the alert today? Only if today is exactly `daysBefore` days before the collection
        const shouldSendToday = hasCollection && daysUntilCollection === daysBefore;

        const scheduleCron = config.collection_alert_time ? parseTimeToCron(config.collection_alert_time) : '0 19 * * *';
        const nextTrigger = getNextTriggerTime(scheduleCron);

        let finalMessage = template
            .replace(/{collection_waste_type}/g, collectionWasteType)
            .replace(/{collection_date}/g, collectionDateStr)
            .replace(/{collection_day_name}/g, collectionDayName)
            .replace(/{days_until_collection}/g, daysUntilCollection)
            .replace(/{next_collection_date}/g, nextDateFormatted)
            .replace(/{next_collection_day_name}/g, nextDayName)
            .replace(/{next_collection_waste_type}/g, nextWasteType);

        return {
            config,
            finalTargetJids,
            template,
            finalMessage,
            daysBefore,
            collectionInfo: {
                hasCollection,
                wasteType: collectionWasteType,
                targetDateLabel: collectionDateStr,
                nextCollectionDateStr: secondCollection ? `${secondCollection.date.getFullYear()}-${(secondCollection.date.getMonth() + 1).toString().padStart(2, '0')}-${secondCollection.date.getDate().toString().padStart(2, '0')}` : '',
                nextWasteType
            },
            daysUntilCollection,
            shouldSendToday,
            nextTrigger,
            canSend: Boolean(template) && finalTargetJids.length > 0
        };
    } catch (error) {
        await addLog('ERROR', 'System Failure', error.message);
        return { hasCollection: false, canSend: false, activeIcalUrl: '', template: '', finalMessage: '' };
    }
};

const sendWhatsAppMessage = async (isManual = false, options = {}) => {
    try {
        const preview = await generateDailyDutyPreview(isManual);
        let { config, finalTargetJids, finalMessage, skipScheduled } = preview;

        if (!preview.canSend) {
            await addLog('ERROR', 'Missing Template or JID', 'Cannot send daily duty alert without template/target configuration.');
            return { status: 'ERROR', action: 'daily-duty', detail: 'Missing template or target configuration.' };
        }

        if (skipScheduled) {
            await addLog('SKIPPED', 'Sunday Rest Day', 'Daily duty alert skipped automatically on Sunday.');
            return { status: 'SKIPPED', action: 'daily-duty', detail: 'Skipped on Sunday.' };
        }

        if (options.testTargetJids && options.testTargetJids.length > 0) {
            finalTargetJids = options.testTargetJids;
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
        let {
            config,
            finalTargetJids,
            finalMessage,
            collectionInfo,
            daysBefore,
            daysUntilCollection
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

        if (collectionInfo.hasCollection && daysUntilCollection !== daysBefore && !options.forceSend) {
            await addLog(
                'SKIPPED',
                'Collection Alert Not Due',
                `Next collection is in ${daysUntilCollection} day(s); configured lead time is ${daysBefore} day(s).`
            );
            return {
                status: 'SKIPPED',
                action: 'collection-alert',
                detail: `Not due yet (${daysUntilCollection} days remaining).`
            };
        }

        if (options.testTargetJids && options.testTargetJids.length > 0) {
            finalTargetJids = options.testTargetJids;
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
    const nextTrigger = getNextTriggerTime(config.cleaning_reminder_schedule);

    return {
        config,
        finalTargetJids,
        template,
        finalMessage: template,
        nextTrigger,
        canSend: Boolean(template) && finalTargetJids.length > 0
    };
};

const sendCleaningReminder = async (isManual = false, options = {}) => {
    try {
        const preview = await generateCleaningReminderPreview();
        let { config, finalTargetJids, finalMessage } = preview;

        if (!preview.canSend) {
            await addLog('ERROR', 'Missing Cleaning Template or JID', 'Cannot send cleaning reminder without template/target configuration.');
            return { status: 'ERROR', action: 'cleaning-reminder', detail: 'Missing template or target configuration.' };
        }

        const cleaningEnabled = isTruthy(config.cleaning_reminder_enabled, true);
        if (!cleaningEnabled && !isManual) {
            await addLog('SKIPPED', 'Cleaning Reminder Disabled', 'Cleaning reminder is disabled in configuration.');
            return { status: 'SKIPPED', action: 'cleaning-reminder', detail: 'Cleaning reminder disabled.' };
        }

        if (options.testTargetJids && options.testTargetJids.length > 0) {
            finalTargetJids = options.testTargetJids;
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
        const { id, title, template } = reminder;

        // Always fetch fresh targets from DB to avoid stale closure data
        const allTargets = await getWhatsAppTargets();
        const targets = allTargets
            .filter(t => (t.custom_reminders || []).includes(id))
            .map(t => t.jid);

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

    const tz = TIMEZONE;

    if (dailySchedule) {
        dailyDutyJob = cron.schedule(dailySchedule, () => sendWhatsAppMessage(false), { timezone: tz });
        console.log(`Daily duty scheduler initialized with cron pattern: "${dailySchedule}"`);
    }

    const collectionEnabled = isTruthy(config.collection_alert_enabled, true);
    if (collectionEnabled) {
        const collectionCron = parseTimeToCron(config.collection_alert_time);
        collectionAlertJob = cron.schedule(collectionCron, () => sendCollectionAlert(false), { timezone: tz });
        console.log(`Collection alert scheduler initialized with cron pattern: "${collectionCron}"`);
    }

    const cleaningEnabled = isTruthy(config.cleaning_reminder_enabled, true);
    if (cleaningEnabled) {
        const cleaningCron = config.cleaning_reminder_schedule || '0 16 * * 0';
        cleaningReminderJob = cron.schedule(cleaningCron, () => sendCleaningReminder(false), { timezone: tz });
        console.log(`Weekly reminder scheduler initialized with cron pattern: "${cleaningCron}"`);
    }

    // Custom Reminders
    Object.values(customReminderJobs).forEach(job => job.stop());
    for (const key in customReminderJobs) delete customReminderJobs[key];

    try {
        const customReminders = await getCustomReminders();
        for (const reminder of customReminders) {
            if (reminder.enabled && reminder.cron_schedule) {
                const job = cron.schedule(reminder.cron_schedule, () => sendCustomReminder(reminder, false), { timezone: tz });
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
    generateCleaningReminderPreview,
    getNextTriggerTime
};
