const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');
const dotenv = require('dotenv');
const path = require('path');
const fs = require('fs');
const {
    getAllConfig,
    updateConfig,
    getRecentLogs,
    getLogStats,
    addLog,
    getWhatsAppTargets,
    replaceWhatsAppTargets,
    getIcalSources,
    replaceIcalSources,
    archiveAllLogs,
    getCustomReminders,
    saveCustomReminder,
    deleteCustomReminder
} = require('./database');
const {
    initScheduler,
    sendWhatsAppMessage,
    sendCollectionAlert,
    sendCleaningReminder,
    generateCollectionAlertPreview,
    generateDailyDutyPreview,
    generateCleaningReminderPreview,
    sendCustomReminder,
    getNextTriggerTime
} = require('./scheduler');

const app = express();
const PORT = 3001;

dotenv.config({ path: path.resolve(__dirname, '../.env'), override: true });
let envFileConfig = {};
try {
    const parsed = dotenv.parse(fs.readFileSync(path.resolve(__dirname, '../.env')));
    envFileConfig = parsed || {};
} catch {
    envFileConfig = {};
}

app.use(cors());
app.use(express.json());

// Serve the built React frontend in production
const frontendBuildPath = path.resolve(__dirname, '../frontend/dist');
if (fs.existsSync(frontendBuildPath)) {
    app.use(express.static(frontendBuildPath));
}

// ─── Authentication ────────────────────────────────────────────────
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || envFileConfig.DASHBOARD_PASSWORD || '';
const activeSessions = new Set();

// Login endpoint (public)
app.post('/api/login', (req, res) => {
    const { password } = req.body || {};
    if (!DASHBOARD_PASSWORD) {
        return res.status(500).json({ error: 'DASHBOARD_PASSWORD is not configured on the server.' });
    }
    if (password !== DASHBOARD_PASSWORD) {
        return res.status(401).json({ error: 'Invalid password.' });
    }
    const token = crypto.randomBytes(32).toString('hex');
    activeSessions.add(token);
    res.json({ success: true, token });
});

// Logout endpoint
app.post('/api/logout', (req, res) => {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.replace(/^Bearer\s+/i, '');
    activeSessions.delete(token);
    res.json({ success: true });
});

// Auth check endpoint (so the frontend can verify a stored token)
app.get('/api/auth-check', (req, res) => {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.replace(/^Bearer\s+/i, '');
    if (token && activeSessions.has(token)) {
        return res.json({ authenticated: true });
    }
    return res.status(401).json({ authenticated: false });
});

// Auth middleware — protects every /api/* route registered AFTER this
app.use('/api', (req, res, next) => {
    // Skip if no password is set (local dev convenience)
    if (!DASHBOARD_PASSWORD) return next();

    const authHeader = req.headers.authorization || '';
    const token = authHeader.replace(/^Bearer\s+/i, '');
    if (token && activeSessions.has(token)) {
        return next();
    }
    return res.status(401).json({ error: 'Unauthorized. Please log in.' });
});

// Get Config
app.get('/api/config', async (req, res) => {
    try {
        const [config, whatsappTargets, icalSources] = await Promise.all([
            getAllConfig(),
            getWhatsAppTargets(),
            getIcalSources()
        ]);

        const primaryTarget = whatsappTargets.find((target) => target.daily_enabled || target.collection_enabled || target.cleaning_enabled) || whatsappTargets[0];
        const primaryIcal = icalSources.find((source) => source.enabled) || icalSources[0];

        res.json({
            ...config,
            group_jid: primaryTarget?.jid || config.group_jid || '',
            ical_url: primaryIcal?.url || config.ical_url || '',
            telegram_bot_token:
                config.telegram_bot_token ||
                config.gateio_api_key ||
                envFileConfig.TELEGRAM_BOT_TOKEN ||
                envFileConfig.GATEIO_API_KEY ||
                process.env.TELEGRAM_BOT_TOKEN ||
                process.env.GATEIO_API_KEY ||
                '',
            telegram_chat_id:
                config.telegram_chat_id ||
                config.gateio_api_secret ||
                envFileConfig.TELEGRAM_CHAT_ID ||
                envFileConfig.GATEIO_API_SECRET ||
                process.env.TELEGRAM_CHAT_ID ||
                process.env.GATEIO_API_SECRET ||
                '',
            gateio_api_key:
                config.gateio_api_key ||
                config.telegram_bot_token ||
                envFileConfig.GATEIO_API_KEY ||
                envFileConfig.TELEGRAM_BOT_TOKEN ||
                process.env.GATEIO_API_KEY ||
                process.env.TELEGRAM_BOT_TOKEN ||
                '',
            gateio_api_secret:
                config.gateio_api_secret ||
                config.telegram_chat_id ||
                envFileConfig.GATEIO_API_SECRET ||
                envFileConfig.TELEGRAM_CHAT_ID ||
                process.env.GATEIO_API_SECRET ||
                process.env.TELEGRAM_CHAT_ID ||
                '',
            whatsapp_targets: whatsappTargets,
            ical_sources: icalSources
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Update Config
app.post('/api/config', async (req, res) => {
    try {
        const updates = { ...req.body };

        const normalizeWhatsAppTargets = (input) => {
            if (!Array.isArray(input)) return [];
            return input
                .map((target) => ({
                    jid: String(target?.jid || '').trim(),
                    label: String(target?.label || '').trim(),
                    daily_enabled: Boolean(target?.daily_enabled),
                    collection_enabled: Boolean(target?.collection_enabled),
                    cleaning_enabled: Boolean(target?.cleaning_enabled),
                    custom_reminders: Array.isArray(target?.custom_reminders) ? target.custom_reminders : []
                }))
                .filter((target) => target.jid.length > 0);
        };

        const normalizeIcalSources = (input) => {
            if (!Array.isArray(input)) return [];
            return input
                .map((source) => ({
                    url: String(source?.url || '').trim(),
                    label: String(source?.label || '').trim(),
                    enabled: Boolean(source?.enabled)
                }))
                .filter((source) => source.url.length > 0);
        };

        let normalizedTargets = null;
        let normalizedIcalSources = null;

        if (Object.prototype.hasOwnProperty.call(updates, 'whatsapp_targets')) {
            normalizedTargets = normalizeWhatsAppTargets(updates.whatsapp_targets);
            await replaceWhatsAppTargets(normalizedTargets);

            const primaryTarget = normalizedTargets.find((target) => target.daily_enabled || target.collection_enabled || target.cleaning_enabled) || normalizedTargets[0];
            await updateConfig('group_jid', primaryTarget?.jid || '');
            delete updates.whatsapp_targets;
        }

        if (Object.prototype.hasOwnProperty.call(updates, 'ical_sources')) {
            normalizedIcalSources = normalizeIcalSources(updates.ical_sources);
            await replaceIcalSources(normalizedIcalSources);

            const primaryIcal = normalizedIcalSources.find((source) => source.enabled) || normalizedIcalSources[0];
            await updateConfig('ical_url', primaryIcal?.url || '');
            delete updates.ical_sources;
        }

        for (const [key, value] of Object.entries(updates)) {
            if (Array.isArray(value) || typeof value === 'object') continue;
            await updateConfig(key, String(value ?? ''));
        }

        const shouldReinitScheduler =
            Object.prototype.hasOwnProperty.call(updates, 'schedule') ||
            Object.prototype.hasOwnProperty.call(updates, 'collection_alert_enabled') ||
            Object.prototype.hasOwnProperty.call(updates, 'collection_alert_time') ||
            Object.prototype.hasOwnProperty.call(updates, 'cleaning_reminder_enabled') ||
            Object.prototype.hasOwnProperty.call(updates, 'cleaning_reminder_schedule') ||
            Object.prototype.hasOwnProperty.call(updates, 'cleaning_reminder_time');

        if (shouldReinitScheduler) {
            await initScheduler();
        }

        await addLog('SYSTEM', 'Configuration Updated', 'User saved new settings via Dashboard.');
        res.json({
            success: true,
            whatsapp_targets: normalizedTargets,
            ical_sources: normalizedIcalSources
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Logs Endpoint for Analytics
app.get('/api/logs', async (req, res) => {
    try {
        const logs = await getRecentLogs(50);
        res.json(logs);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Log Stats for Analytics
app.get('/api/logs/stats', async (req, res) => {
    try {
        const stats = await getLogStats();
        res.json(stats);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Trigger a manual send for testing
app.post('/api/test-send', async (req, res) => {
    try {
        await addLog('SYSTEM', 'Manual Validation Triggered', 'User requested a manual daily duty test send.');
        sendWhatsAppMessage(true, { testTargetJids: req.body.testTargetJids }); // Call asynchronously
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Preview daily duty alert message without sending
app.get('/api/preview-daily-duty', async (req, res) => {
    try {
        const preview = await generateDailyDutyPreview();
        res.json({
            success: true,
            message: preview.finalMessage || '',
            targets: preview.finalTargetJids || [],
            skip_scheduled: Boolean(preview.skipScheduled),
            next_trigger: preview.nextTrigger || null,
            can_send: Boolean(preview.canSend)
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Preview collection alert message without sending
app.get('/api/preview-message', async (req, res) => {
    try {
        const preview = await generateCollectionAlertPreview();

        let nextDateFormatted = '';
        let nextDayName = '';
        if (preview.collectionInfo?.nextCollectionDateStr) {
            const parts = preview.collectionInfo.nextCollectionDateStr.split('-');
            const nextDateObj = new Date(parts[0], parts[1] - 1, parts[2]);
            nextDateFormatted = nextDateObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
            nextDayName = nextDateObj.toLocaleDateString('en-US', { weekday: 'long' });
        }

        res.json({
            success: true,
            message: preview.finalMessage || '',
            targets: preview.finalTargetJids || [],
            waste_type: preview.collectionInfo?.wasteType || '',
            collection_date: preview.collectionInfo?.targetDateLabel || '',
            collection_exists: Boolean(preview.collectionInfo?.hasCollection),
            days_before: preview.daysBefore || 1,
            should_send_today: Boolean(preview.shouldSendToday),
            next_collection_date: nextDateFormatted,
            next_collection_day_name: nextDayName,
            next_collection_waste_type: preview.collectionInfo?.nextWasteType || '',
            active_ical_url: preview.activeIcalUrl || '',
            has_template: Boolean(preview.template),
            next_trigger: preview.nextTrigger || null,
            can_send: Boolean(preview.canSend)
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Trigger a real collection alert send to all enabled targets
app.post('/api/test-collection-send', async (req, res) => {
    try {
        await addLog('SYSTEM', 'Collection Alert Test Triggered', 'User requested a manual collection alert test send.');
        sendCollectionAlert(true, { forceSend: true, testTargetJids: req.body.testTargetJids });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Preview cleaning reminder message without sending
app.get('/api/preview-cleaning', async (req, res) => {
    try {
        const preview = await generateCleaningReminderPreview();
        res.json({
            success: true,
            message: preview.finalMessage || '',
            targets: preview.finalTargetJids || [],
            next_trigger: preview.nextTrigger || null,
            can_send: Boolean(preview.canSend)
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Trigger a manual cleaning reminder send
app.post('/api/test-cleaning-send', async (req, res) => {
    try {
        await addLog('SYSTEM', 'Cleaning Reminder Test Triggered', 'User requested a manual cleaning reminder send.');
        sendCleaningReminder(true, { testTargetJids: req.body.testTargetJids });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Preview a custom reminder
app.get('/api/preview-custom/:id', async (req, res) => {
    try {
        const reminders = await getCustomReminders();
        const reminder = reminders.find(r => r.id === parseInt(req.params.id, 10));

        if (!reminder) {
            return res.status(404).json({ error: 'Reminder not found' });
        }

        const [config, enabledTargets] = await Promise.all([
            getAllConfig(),
            getWhatsAppTargets()
        ]);

        const reminderTargets = enabledTargets.filter(t => (t.custom_reminders || []).includes(reminder.id)).map(t => t.label || t.jid);
        const nextTrigger = getNextTriggerTime(reminder.cron_schedule);

        res.json({
            success: true,
            message: reminder.template || '',
            targets: reminderTargets,
            next_trigger: nextTrigger || null,
            can_send: Boolean(reminder.template) && reminderTargets.length > 0
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Trigger a manual custom reminder send
app.post('/api/test-custom-send/:id', async (req, res) => {
    try {
        const reminders = await getCustomReminders();
        const reminder = reminders.find(r => r.id === parseInt(req.params.id, 10));

        if (!reminder) {
            return res.status(404).json({ error: 'Reminder not found' });
        }

        await addLog('SYSTEM', 'Custom Reminder Test Triggered', `User requested a manual test for "${reminder.title}".`);
        sendCustomReminder(reminder, true);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Trigger a direct Telegram connection test
app.post('/api/test-telegram', async (req, res) => {
    try {
        const { gateioApiKey, gateioApiSecret, botToken, chatId } = req.body;
        const resolvedToken = botToken || gateioApiKey || process.env.TELEGRAM_BOT_TOKEN || process.env.GATEIO_API_KEY;
        const resolvedChatId = chatId || gateioApiSecret || process.env.TELEGRAM_CHAT_ID || process.env.GATEIO_API_SECRET;
        if (!resolvedToken || !resolvedChatId) {
            return res.status(400).json({ error: "Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID" });
        }

        const baseTgUrl = `https://api.telegram.org/bot${resolvedToken}`;
        const meRes = await axios.get(`${baseTgUrl}/getMe`);
        const botUsername = meRes.data?.result?.username;

        await axios.post(`${baseTgUrl}/sendMessage`, {
            chat_id: resolvedChatId,
            text: "Automation summary notification channel is working."
        });
        await addLog(
            'SUCCESS',
            'Telegram Connection Test',
            `Test message successfully delivered to Telegram via @${botUsername || 'unknown_bot'}.`
        );
        res.json({ success: true, bot_username: botUsername || null });
    } catch (error) {
        const errDesc = error.response?.data?.description || error.message;
        await addLog('ERROR', 'Telegram Test Failed', errDesc);
        res.status(500).json({ error: errDesc });
    }
});

// Archive all logs
app.post('/api/logs/archive-all', async (req, res) => {
    try {
        const archivedCount = await archiveAllLogs();
        res.json({ success: true, count: archivedCount });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Custom Reminders API
app.get('/api/custom-reminders', async (req, res) => {
    try {
        const reminders = await getCustomReminders();
        res.json(reminders);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/custom-reminders', async (req, res) => {
    try {
        const reminderId = await saveCustomReminder(req.body);
        await initScheduler(); // Reload cron jobs

        await addLog('SYSTEM', 'Custom Reminder Saved', `Custom reminder "${req.body.title}" was saved.`);
        res.json({ success: true, id: reminderId });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/custom-reminders/:id', async (req, res) => {
    try {
        await deleteCustomReminder(req.params.id);
        await initScheduler(); // Reload cron jobs

        await addLog('SYSTEM', 'Custom Reminder Deleted', `Custom reminder ID ${req.params.id} was deleted.`);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Catch-all: serve React frontend for any non-API route
if (fs.existsSync(frontendBuildPath)) {
    app.get('/{*splat}', (req, res) => {
        res.sendFile(path.join(frontendBuildPath, 'index.html'));
    });
}

app.listen(PORT, async () => {
    console.log(`Backend Running on http://localhost:${PORT}`);
    await initScheduler();
});
