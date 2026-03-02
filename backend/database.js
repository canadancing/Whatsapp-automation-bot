const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const dbPath = path.resolve(__dirname, '../data/dashboard.sqlite');

// Ensure data directory exists
const dataDir = path.dirname(dbPath);
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

const db = new sqlite3.Database(dbPath);

db.serialize(() => {
    db.run(`
    CREATE TABLE IF NOT EXISTS config (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT UNIQUE NOT NULL,
      value TEXT NOT NULL
    )
  `);

    db.run(`
    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      status TEXT NOT NULL,
      message TEXT NOT NULL,
      details TEXT
    )
  `);

    db.run(`
    CREATE TABLE IF NOT EXISTS whatsapp_targets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      jid TEXT UNIQUE NOT NULL,
      label TEXT DEFAULT '',
      daily_enabled INTEGER NOT NULL DEFAULT 1,
      collection_enabled INTEGER NOT NULL DEFAULT 1,
      cleaning_enabled INTEGER NOT NULL DEFAULT 1
    )
  `);

    // Safe schema migration for existing table
    db.all("PRAGMA table_info(whatsapp_targets)", (err, columns) => {
        if (err) return;
        const colNames = columns.map(c => c.name);
        if (!colNames.includes('daily_enabled')) {
            db.run("ALTER TABLE whatsapp_targets ADD COLUMN daily_enabled INTEGER NOT NULL DEFAULT 1");
        }
        if (!colNames.includes('collection_enabled')) {
            db.run("ALTER TABLE whatsapp_targets ADD COLUMN collection_enabled INTEGER NOT NULL DEFAULT 1");
        }
        if (!colNames.includes('cleaning_enabled')) {
            db.run("ALTER TABLE whatsapp_targets ADD COLUMN cleaning_enabled INTEGER NOT NULL DEFAULT 1");
        }
    });

    db.all("PRAGMA table_info(logs)", (err, columns) => {
        if (err) return;
        const colNames = columns.map(c => c.name);
        if (!colNames.includes('is_archived')) {
            db.run("ALTER TABLE logs ADD COLUMN is_archived INTEGER NOT NULL DEFAULT 0");
        }
    });

    db.run(`
    CREATE TABLE IF NOT EXISTS custom_reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      cron_schedule TEXT NOT NULL,
      template TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1
    )
    `);

    db.run(`
    CREATE TABLE IF NOT EXISTS custom_reminder_targets (
      reminder_id INTEGER,
      target_jid TEXT,
      PRIMARY KEY (reminder_id, target_jid)
    )
    `);

    db.run(`
    CREATE TABLE IF NOT EXISTS ical_sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT UNIQUE NOT NULL,
      label TEXT DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1
    )
  `);

    // Insert default config if it doesn't exist
    const defaultConfig = {
        schedule: '0 9 * * 1-6', // 9:00 AM Mon-Sat
        template: '🗑️ *Food Waste Duty Alert - {today_name}*\n\n👉 Today\'s duty: *Room {today_room}* needs to dump the food waste!\n⏳ Tomorrow\'s duty: *Room {tmw_room}*, please be prepared.\n\n🚚 *Collection Alert*: {tomorrow_waste_type}',
        collection_alert_enabled: 'true',
        collection_alert_time: '19:00',
        collection_alert_days_before: '1',
        collection_template: '🚛 *Collection Reminder*\n\nUpcoming collection: *{collection_waste_type}*.\nCollection day: *{collection_date}* ({collection_day_name}).',
        group_jid: process.env.WHATSAPP_GROUP_JID || '120363406057001887@g.us',
        ical_url: '',
        telegram_enabled: 'true',
        gateio_api_key: process.env.GATEIO_API_KEY || '',
        gateio_api_secret: process.env.GATEIO_API_SECRET || '',
        telegram_bot_token: process.env.TELEGRAM_BOT_TOKEN || '',
        telegram_chat_id: process.env.TELEGRAM_CHAT_ID || '',
        // Custom titles
        daily_duty_title: 'Daily Duty Alert',
        collection_calendar_title: 'Collection Calendar',
        weekly_reminder_title: 'Weekly Reminder',
        // Weekly cleaning reminder
        cleaning_reminder_enabled: 'true',
        cleaning_reminder_schedule: '0 16 * * 0',
        cleaning_reminder_time: '16:00',
        cleaning_reminder_template: '🧹 *Weekly Cleaning Reminder*\n\nHey everyone! Today is Sunday — time for our weekly house cleaning at 4PM.\n\nAll members please attend. Let\'s keep our home clean together! 💪\n\n(This is an automatic message)'
    };

    const stmt = db.prepare('INSERT OR IGNORE INTO config (key, value) VALUES (?, ?)');
    for (const [key, value] of Object.entries(defaultConfig)) {
        stmt.run(key, value);
    }
    stmt.finalize();

    // Normalize early template copy to avoid "Tomorrow's" wording when alert lead time > 1 day.
    db.run(
        `UPDATE config
         SET value = REPLACE(value, 'Tomorrow\\''s collection:', 'Upcoming collection:')
         WHERE key = 'collection_template' AND value LIKE '%Tomorrow\\''s collection:%'`
    );

    // One-time migration from legacy single-value config to list-based tables.
    db.get('SELECT COUNT(*) AS count FROM whatsapp_targets', [], (countErr, row) => {
        if (countErr || row.count > 0) return;
        db.get('SELECT value FROM config WHERE key = ?', ['group_jid'], (jidErr, jidRow) => {
            if (jidErr) return;
            const jid = (jidRow?.value || '').trim();
            if (!jid) return;
            db.run(
                'INSERT OR IGNORE INTO whatsapp_targets (jid, label, daily_enabled, collection_enabled, cleaning_enabled) VALUES (?, ?, 1, 1, 1)',
                [jid, 'Primary Group']
            );
        });
    });

    db.get('SELECT COUNT(*) AS count FROM ical_sources', [], (countErr, row) => {
        if (countErr || row.count > 0) return;
        db.get('SELECT value FROM config WHERE key = ?', ['ical_url'], (urlErr, urlRow) => {
            if (urlErr) return;
            const url = (urlRow?.value || '').trim();
            if (!url) return;
            db.run(
                'INSERT OR IGNORE INTO ical_sources (url, label, enabled) VALUES (?, ?, 1)',
                [url, 'Primary iCal']
            );
        });
    });
});

const getConfig = (key) => {
    return new Promise((resolve, reject) => {
        db.get('SELECT value FROM config WHERE key = ?', [key], (err, row) => {
            if (err) reject(err);
            else resolve(row ? row.value : null);
        });
    });
};

const updateConfig = (key, value) => {
    return new Promise((resolve, reject) => {
        db.run(
            'INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?',
            [key, value, value],
            function (err) {
                if (err) reject(err);
                else resolve(this.changes);
            }
        );
    });
};

const getAllConfig = () => {
    return new Promise((resolve, reject) => {
        db.all('SELECT key, value FROM config', [], (err, rows) => {
            if (err) reject(err);
            else {
                const config = {};
                rows.forEach(row => {
                    config[row.key] = row.value;
                });
                resolve(config);
            }
        });
    });
};

const addLog = (status, message, details = '') => {
    return new Promise((resolve, reject) => {
        db.serialize(() => {
            db.run(
                'INSERT INTO logs (status, message, details) VALUES (?, ?, ?)',
                [status, message, details],
                function (err) {
                    if (err) {
                        reject(err);
                        return;
                    }
                    const newId = this.lastID;
                    // Auto-cleanup: delete archived logs older than 30 days, keep maximum of 500 total logs to prevent infinite growth
                    db.run(
                        "DELETE FROM logs WHERE (is_archived = 1 AND timestamp < datetime('now', '-30 days')) OR id NOT IN (SELECT id FROM logs ORDER BY timestamp DESC, id DESC LIMIT 500)",
                        (cleanupErr) => {
                            if (cleanupErr) console.error('Failed to cleanup logs:', cleanupErr);
                            resolve(newId);
                        }
                    );
                }
            );
        });
    });
};

const archiveLog = (id) => {
    return new Promise((resolve, reject) => {
        db.run('UPDATE logs SET is_archived = 1 WHERE id = ?', [id], function (err) {
            if (err) reject(err);
            else resolve(this.changes);
        });
    });
};

const getRecentLogs = (limit = 100) => {
    return new Promise((resolve, reject) => {
        db.all('SELECT * FROM logs ORDER BY timestamp DESC LIMIT ?', [limit], (err, rows) => {
            if (err) reject(err);
            else resolve(rows.map(r => ({ ...r, is_archived: Boolean(r.is_archived) })));
        });
    });
};

const getWhatsAppTargets = () => {
    return new Promise((resolve, reject) => {
        db.all(
            'SELECT id, jid, label, daily_enabled, collection_enabled, cleaning_enabled FROM whatsapp_targets ORDER BY id ASC',
            [],
            (err, rows) => {
                if (err) return reject(err);

                db.all('SELECT reminder_id, target_jid FROM custom_reminder_targets', [], (err2, customTargets) => {
                    if (err2) return reject(err2);

                    const customByJid = {};
                    customTargets.forEach(ct => {
                        if (!customByJid[ct.target_jid]) customByJid[ct.target_jid] = [];
                        customByJid[ct.target_jid].push(ct.reminder_id);
                    });

                    resolve(rows.map((row) => ({
                        ...row,
                        daily_enabled: Boolean(row.daily_enabled),
                        collection_enabled: Boolean(row.collection_enabled),
                        cleaning_enabled: Boolean(row.cleaning_enabled),
                        custom_reminders: customByJid[row.jid] || []
                    })));
                });
            }
        );
    });
};

const getEnabledWhatsAppTargets = (reminderType) => {
    return new Promise((resolve, reject) => {
        const column = reminderType === 'daily' ? 'daily_enabled'
            : reminderType === 'collection' ? 'collection_enabled'
                : reminderType === 'cleaning' ? 'cleaning_enabled'
                    : null;

        if (!column) return resolve([]);

        db.all(
            `SELECT id, jid, label, daily_enabled, collection_enabled, cleaning_enabled FROM whatsapp_targets WHERE ${column} = 1 ORDER BY id ASC`,
            [],
            (err, rows) => {
                if (err) reject(err);
                else resolve(rows.map((row) => ({
                    ...row,
                    daily_enabled: Boolean(row.daily_enabled),
                    collection_enabled: Boolean(row.collection_enabled),
                    cleaning_enabled: Boolean(row.cleaning_enabled)
                })));
            }
        );
    });
};

const replaceWhatsAppTargets = (targets = []) => {
    return new Promise((resolve, reject) => {
        db.serialize(() => {
            db.run('BEGIN TRANSACTION');
            db.run('DELETE FROM whatsapp_targets', (deleteErr) => {
                if (deleteErr) {
                    db.run('ROLLBACK');
                    reject(deleteErr);
                    return;
                }

                db.run('DELETE FROM custom_reminder_targets', (delCustomErr) => {
                    if (delCustomErr) {
                        db.run('ROLLBACK');
                        reject(delCustomErr);
                        return;
                    }

                    const stmtTarget = db.prepare(
                        'INSERT INTO whatsapp_targets (jid, label, daily_enabled, collection_enabled, cleaning_enabled) VALUES (?, ?, ?, ?, ?)'
                    );
                    const stmtCustom = db.prepare(
                        'INSERT INTO custom_reminder_targets (reminder_id, target_jid) VALUES (?, ?)'
                    );

                    for (const target of targets) {
                        stmtTarget.run(
                            target.jid,
                            target.label || '',
                            target.daily_enabled ? 1 : 0,
                            target.collection_enabled ? 1 : 0,
                            target.cleaning_enabled ? 1 : 0
                        );
                        if (target.custom_reminders && Array.isArray(target.custom_reminders)) {
                            for (const rid of target.custom_reminders) {
                                stmtCustom.run(rid, target.jid);
                            }
                        }
                    }

                    stmtTarget.finalize();
                    stmtCustom.finalize((stmtCustomErr) => {
                        if (stmtCustomErr) {
                            db.run('ROLLBACK');
                            reject(stmtCustomErr);
                            return;
                        }
                        db.run('COMMIT', (commitErr) => {
                            if (commitErr) reject(commitErr);
                            else resolve();
                        });
                    });
                });
            });
        });
    });
};

const getIcalSources = () => {
    return new Promise((resolve, reject) => {
        db.all(
            'SELECT id, url, label, enabled FROM ical_sources ORDER BY id ASC',
            [],
            (err, rows) => {
                if (err) reject(err);
                else resolve(rows.map((row) => ({ ...row, enabled: Boolean(row.enabled) })));
            }
        );
    });
};

const getEnabledIcalSources = () => {
    return new Promise((resolve, reject) => {
        db.all(
            'SELECT id, url, label, enabled FROM ical_sources WHERE enabled = 1 ORDER BY id ASC',
            [],
            (err, rows) => {
                if (err) reject(err);
                else resolve(rows.map((row) => ({ ...row, enabled: true })));
            }
        );
    });
};

const archiveAllLogs = () => {
    return new Promise((resolve, reject) => {
        db.run('UPDATE logs SET is_archived = 1 WHERE is_archived = 0', [], function (err) {
            if (err) reject(err);
            else resolve(this.changes);
        });
    });
};

const replaceIcalSources = (sources = []) => {
    return new Promise((resolve, reject) => {
        db.serialize(() => {
            db.run('BEGIN TRANSACTION');
            db.run('DELETE FROM ical_sources', (deleteErr) => {
                if (deleteErr) {
                    db.run('ROLLBACK');
                    reject(deleteErr);
                    return;
                }

                const stmt = db.prepare(
                    'INSERT INTO ical_sources (url, label, enabled) VALUES (?, ?, ?)'
                );

                for (const source of sources) {
                    stmt.run(source.url, source.label || '', source.enabled ? 1 : 0);
                }

                stmt.finalize((stmtErr) => {
                    if (stmtErr) {
                        db.run('ROLLBACK');
                        reject(stmtErr);
                        return;
                    }
                    db.run('COMMIT', (commitErr) => {
                        if (commitErr) reject(commitErr);
                        else resolve();
                    });
                });
            });
        });
    });
};

const getLogStats = () => {
    return new Promise((resolve, reject) => {
        const stats = { total: 0, success: 0, error: 0, system: 0, skipped: 0, archived: 0, successRate: 0, lastActivity: null, dailyActivity: [], breakdown: [] };

        db.get('SELECT COUNT(*) as count FROM logs WHERE is_archived = 1', [], (errArchived, rowArchived) => {
            if (!errArchived && rowArchived) stats.archived = rowArchived.count;

            db.all('SELECT status, COUNT(*) as count FROM logs GROUP BY status', [], (err, rows) => {
                if (err) return reject(err);
                rows.forEach(r => {
                    const key = r.status.toLowerCase();
                    stats[key] = r.count;
                    stats.total += r.count;
                });
                const deliveries = stats.success + stats.error;
                stats.successRate = deliveries > 0 ? Math.round((stats.success / deliveries) * 1000) / 10 : 0;

                db.all('SELECT message as title, COUNT(*) as count FROM logs GROUP BY message ORDER BY count DESC', [], (errBreakdown, breakdownRows) => {
                    if (!errBreakdown) stats.breakdown = breakdownRows;

                    db.get('SELECT timestamp FROM logs ORDER BY timestamp DESC LIMIT 1', [], (err2, row) => {
                        if (!err2 && row) stats.lastActivity = row.timestamp;

                        db.all(
                            `SELECT DATE(timestamp) as date, status, COUNT(*) as count
                         FROM logs
                         WHERE timestamp >= DATE('now', '-6 days')
                         GROUP BY DATE(timestamp), status
                         ORDER BY date ASC`,
                            [],
                            (err3, dailyRows) => {
                                if (err3) return reject(err3);
                                const dayMap = {};
                                for (let i = 6; i >= 0; i--) {
                                    const d = new Date();
                                    d.setDate(d.getDate() - i);
                                    const key = d.toISOString().slice(0, 10);
                                    dayMap[key] = { date: key, success: 0, error: 0, system: 0, skipped: 0 };
                                }
                                dailyRows.forEach(r => {
                                    if (dayMap[r.date]) dayMap[r.date][r.status.toLowerCase()] = r.count;
                                });
                                stats.dailyActivity = Object.values(dayMap);
                                resolve(stats);
                            }
                        );
                    });
                });
            });
        });
    });
};

const getCustomReminders = () => {
    return new Promise((resolve, reject) => {
        db.all('SELECT * FROM custom_reminders ORDER BY id ASC', [], (err, reminders) => {
            if (err) return reject(err);
            db.all('SELECT * FROM custom_reminder_targets', [], (errTargets, targets) => {
                if (errTargets) return reject(errTargets);

                const targetMap = {};
                targets.forEach(t => {
                    if (!targetMap[t.reminder_id]) targetMap[t.reminder_id] = [];
                    targetMap[t.reminder_id].push(t.target_jid);
                });

                const result = reminders.map(r => ({
                    ...r,
                    enabled: Boolean(r.enabled),
                    targets: targetMap[r.id] || []
                }));
                resolve(result);
            });
        });
    });
};

const saveCustomReminder = (reminder) => {
    return new Promise((resolve, reject) => {
        db.serialize(() => {
            db.run('BEGIN TRANSACTION');

            const isUpdate = reminder.id && reminder.id !== 'new';
            const query = isUpdate
                ? 'UPDATE custom_reminders SET title = ?, cron_schedule = ?, template = ?, enabled = ? WHERE id = ?'
                : 'INSERT INTO custom_reminders (title, cron_schedule, template, enabled) VALUES (?, ?, ?, ?)';

            const params = isUpdate
                ? [reminder.title, reminder.cron_schedule, reminder.template, reminder.enabled ? 1 : 0, reminder.id]
                : [reminder.title, reminder.cron_schedule, reminder.template, reminder.enabled ? 1 : 0];

            db.run(query, params, function (err) {
                if (err) {
                    db.run('ROLLBACK');
                    return reject(err);
                }

                const reminderId = isUpdate ? reminder.id : this.lastID;

                db.run('COMMIT', (commitErr) => {
                    if (commitErr) reject(commitErr);
                    else resolve(reminderId);
                });
            });
        });
    });
};

const deleteCustomReminder = (id) => {
    return new Promise((resolve, reject) => {
        db.serialize(() => {
            db.run('BEGIN TRANSACTION');
            db.run('DELETE FROM custom_reminders WHERE id = ?', [id], (err) => {
                if (err) {
                    db.run('ROLLBACK');
                    return reject(err);
                }
                db.run('DELETE FROM custom_reminder_targets WHERE reminder_id = ?', [id], (delErr) => {
                    if (delErr) {
                        db.run('ROLLBACK');
                        return reject(delErr);
                    }
                    db.run('COMMIT', (commitErr) => {
                        if (commitErr) reject(commitErr);
                        else resolve();
                    });
                });
            });
        });
    });
};

module.exports = {
    db,
    getConfig,
    updateConfig,
    getAllConfig,
    addLog,
    archiveAllLogs,
    getRecentLogs,
    getLogStats,
    getWhatsAppTargets,
    getEnabledWhatsAppTargets,
    replaceWhatsAppTargets,
    getIcalSources,
    getEnabledIcalSources,
    replaceIcalSources,
    getCustomReminders,
    saveCustomReminder,
    deleteCustomReminder
};
