import { useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import {
  Clock, Send, Save, LayoutDashboard, Settings2, Bell,
  Calendar, MessageSquare, Activity, CheckCircle, XCircle, Trash2, Plus,
  Pencil, BarChart3, TrendingUp, AlertTriangle, Zap, Archive, Menu, LogOut, Lock
} from 'lucide-react';
import './index.css';

const API_URL = window.location.hostname === 'localhost'
  ? 'http://localhost:3001/api'
  : '/api';

// ─── Axios auth setup ───────────────────────────────────────────
const setupAxiosAuth = (token) => {
  if (token) {
    axios.defaults.headers.common['Authorization'] = `Bearer ${token}`;
  } else {
    delete axios.defaults.headers.common['Authorization'];
  }
};

// Restore token on page load
const storedToken = localStorage.getItem('dashboard_token');
if (storedToken) setupAxiosAuth(storedToken);

// ─── Login Screen ───────────────────────────────────────────────
function LoginScreen({ onLogin }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await axios.post(`${API_URL}/login`, { password });
      const { token } = res.data;
      localStorage.setItem('dashboard_token', token);
      setupAxiosAuth(token);
      onLogin();
    } catch (err) {
      setError(err.response?.data?.error || 'Login failed. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-screen">
      <form className="login-card glass-card" onSubmit={handleSubmit}>
        <div className="login-icon">
          <Lock size={32} />
        </div>
        <h1>WA Control Center</h1>
        <p className="login-subtitle">Enter your dashboard password to continue</p>
        {error && <div className="login-error">{error}</div>}
        <input
          id="login-password"
          type="password"
          className="login-input"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoFocus
          autoComplete="current-password"
        />
        <button
          id="login-submit"
          type="submit"
          className="btn btn-primary login-btn"
          disabled={loading || !password}
        >
          {loading ? 'Authenticating...' : 'Log In'}
        </button>
      </form>
    </div>
  );
}

const createLocalId = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`;

const toBool = (value, fallback = false) => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  }
  return fallback;
};

const normalizeTargets = (targets = []) => targets
  .map((target) => ({
    jid: String(target?.jid || '').trim(),
    label: String(target?.label || '').trim(),
    daily_enabled: target?.daily_enabled !== undefined ? Boolean(target?.daily_enabled) : Boolean(target?.enabled),
    collection_enabled: target?.collection_enabled !== undefined ? Boolean(target?.collection_enabled) : Boolean(target?.enabled),
    cleaning_enabled: target?.cleaning_enabled !== undefined ? Boolean(target?.cleaning_enabled) : Boolean(target?.enabled),
    custom_reminders: Array.isArray(target?.custom_reminders) ? target.custom_reminders : []
  }))
  .filter((target) => target.jid.length > 0);

const normalizeIcalSources = (sources = []) => sources
  .map((source) => ({
    url: String(source?.url || '').trim(),
    label: String(source?.label || '').trim(),
    enabled: Boolean(source?.enabled)
  }))
  .filter((source) => source.url.length > 0);

const makeWhatsAppTarget = (target = {}) => ({
  id: target.id ?? null,
  jid: target.jid ?? '',
  label: target.label ?? '',
  daily_enabled: target.daily_enabled ?? true,
  collection_enabled: target.collection_enabled ?? true,
  cleaning_enabled: target.cleaning_enabled ?? true,
  custom_reminders: Array.isArray(target.custom_reminders) ? target.custom_reminders : [],
  localId: target.localId ?? createLocalId()
});

const makeIcalSource = (source = {}) => ({
  id: source.id ?? null,
  url: source.url ?? '',
  label: source.label ?? '',
  enabled: source.enabled ?? true,
  localId: source.localId ?? createLocalId()
});

const sectionKeys = ['automation', 'whatsapp', 'telegram', 'collection', 'ical', 'template', 'cleaning', 'settings'];

function App() {
  const [isAuthenticated, setIsAuthenticated] = useState(!!localStorage.getItem('dashboard_token'));
  const [authChecked, setAuthChecked] = useState(false);

  // Verify stored token on mount
  useEffect(() => {
    const token = localStorage.getItem('dashboard_token');
    if (!token) {
      setAuthChecked(true);
      return;
    }
    axios.get(`${API_URL}/auth-check`)
      .then(() => { setIsAuthenticated(true); setAuthChecked(true); })
      .catch(() => {
        localStorage.removeItem('dashboard_token');
        setupAxiosAuth(null);
        setIsAuthenticated(false);
        setAuthChecked(true);
      });
  }, []);

  // Global 401 interceptor
  useEffect(() => {
    const interceptor = axios.interceptors.response.use(
      (response) => response,
      (error) => {
        if (error.response?.status === 401 && error.config?.url && !error.config.url.endsWith('/login')) {
          localStorage.removeItem('dashboard_token');
          setupAxiosAuth(null);
          setIsAuthenticated(false);
        }
        return Promise.reject(error);
      }
    );
    return () => axios.interceptors.response.eject(interceptor);
  }, []);

  const handleLogout = useCallback(async () => {
    try { await axios.post(`${API_URL}/logout`); } catch { /* ignore */ }
    localStorage.removeItem('dashboard_token');
    setupAxiosAuth(null);
    setIsAuthenticated(false);
  }, []);


  const [config, setConfig] = useState({
    schedule: '',
    template: '',
    telegram_enabled: true,
    telegram_bot_token: '',
    telegram_chat_id: '',
    collection_alert_enabled: true,
    collection_alert_time: '19:00',
    collection_alert_days_before: '1',
    collection_template: '',
    whatsapp_targets: [makeWhatsAppTarget()],
    ical_sources: [makeIcalSource()],
    daily_duty_title: 'Daily Duty Alert',
    collection_calendar_title: 'Collection Calendar',
    weekly_reminder_title: 'Weekly Reminder',
    cleaning_reminder_enabled: true,
    cleaning_reminder_schedule: '0 16 * * 0',
    cleaning_reminder_template: ''
  });

  const [savedSnapshot, setSavedSnapshot] = useState({
    schedule: '',
    template: '',
    telegram_enabled: true,
    telegram_bot_token: '',
    telegram_chat_id: '',
    collection_alert_enabled: true,
    collection_alert_time: '19:00',
    collection_alert_days_before: '1',
    collection_template: '',
    whatsapp_targets: [],
    ical_sources: [],
    daily_duty_title: 'Daily Duty Alert',
    collection_calendar_title: 'Collection Calendar',
    weekly_reminder_title: 'Weekly Reminder',
    cleaning_reminder_enabled: true,
    cleaning_reminder_schedule: '0 16 * * 0',
    cleaning_reminder_template: ''
  });

  const [logs, setLogs] = useState([]);
  const [logStats, setLogStats] = useState(null);
  const [logFilter, setLogFilter] = useState('all');
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [showBreakdownModal, setShowBreakdownModal] = useState(false);
  const [customReminders, setCustomReminders] = useState([]);
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const [confirmArchiveAll, setConfirmArchiveAll] = useState(false);
  const [editingTitle, setEditingTitle] = useState(null);
  const [activeTab, setActiveTab] = useState('analytics');
  const [status, setStatus] = useState('Loading...');
  const [isTesting, setIsTesting] = useState(false);
  const [isTestingTelegram, setIsTestingTelegram] = useState(false);
  const [isTestingCollectionSend, setIsTestingCollectionSend] = useState(false);
  const [isPreviewingMessage, setIsPreviewingMessage] = useState(false);
  const [isPreviewingCleaning, setIsPreviewingCleaning] = useState(false);
  const [isTestingCleaningSend, setIsTestingCleaningSend] = useState(false);
  const [messagePreview, setMessagePreview] = useState(null);
  const [cleaningPreview, setCleaningPreview] = useState(null);
  const [savingState, setSavingState] = useState({
    automation: false,
    whatsapp: false,
    telegram: false,
    collection: false,
    ical: false,
    template: false,
    cleaning: false,
    settings: false,
    all: false
  });
  const [saveErrors, setSaveErrors] = useState({
    automation: '',
    whatsapp: '',
    telegram: '',
    collection: '',
    ical: '',
    template: '',
    cleaning: '',
    settings: ''
  });

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchLogsOnly, 10000);
    return () => clearInterval(interval);
  }, []);

  const fetchLogsOnly = async () => {
    try {
      const [logsRes, statsRes] = await Promise.allSettled([
        axios.get(`${API_URL}/logs`),
        axios.get(`${API_URL}/logs/stats`)
      ]);
      if (logsRes.status === 'fulfilled') setLogs(logsRes.value.data);
      if (statsRes.status === 'fulfilled') setLogStats(statsRes.value.data);
      setStatus((prev) => (prev === 'Backend Offline' ? 'Connected & Active' : prev));
    } catch (error) {
      console.error('Error fetching logs:', error);
      setStatus('Backend Offline');
    }
  };

  const fetchCustomReminders = async () => {
    try {
      const res = await axios.get(`${API_URL}/custom-reminders`);
      setCustomReminders(res.data);
    } catch (error) {
      console.error('Failed to fetch custom reminders:', error);
    }
  };

  const handleArchiveAllLogs = async () => {
    if (!confirmArchiveAll) {
      setConfirmArchiveAll(true);
      return;
    }
    try {
      await axios.post(`${API_URL}/logs/archive-all`);
      setConfirmArchiveAll(false);
      await fetchLogsOnly();
    } catch (error) {
      console.error('Failed to archive logs:', error);
      alert('Failed to archive logs: ' + (error.response?.data?.error || error.message));
      setConfirmArchiveAll(false);
    }
  };

  const handleAddCustomReminder = () => {
    setCustomReminders(prev => [
      ...prev,
      {
        id: `temp-${Date.now()}`,
        isNew: true,
        title: 'New Reminder',
        cron_schedule: '0 10 * * *',
        template: 'Hello! This is a custom reminder.',
        enabled: true,
        targets: []
      }
    ]);
  };

  const handleUpdateCustomReminder = (id, field, value) => {
    setCustomReminders(prev => prev.map(r => r.id === id ? { ...r, [field]: value } : r));
  };

  const handleSaveCustomReminder = async (reminder) => {
    try {
      await axios.post(`${API_URL}/custom-reminders`, reminder);
      await fetchCustomReminders();
      alert('Saved successfully!');
    } catch (error) {
      console.error('Failed to save reminder:', error);
      alert('Failed to save: ' + (error.response?.data?.error || error.message));
    }
  };

  const handleDeleteCustomReminder = async (id, isNew) => {
    if (isNew) {
      setCustomReminders(prev => prev.filter(r => r.id !== id));
      setConfirmDeleteId(null);
      return;
    }

    if (confirmDeleteId !== id) {
      setConfirmDeleteId(id);
      return;
    }

    try {
      await axios.delete(`${API_URL}/custom-reminders/${id}`);
      setConfirmDeleteId(null);
      await fetchCustomReminders();
    } catch (error) {
      console.error('Failed to delete reminder:', error);
      alert('Failed to delete: ' + (error.response?.data?.error || error.message));
      setConfirmDeleteId(null);
    }
  };

  const handleTestCustomReminder = async (id) => {
    try {
      await axios.post(`${API_URL}/test-custom-send/${id}`);
      alert('Test triggered!');
      await fetchLogsOnly();
    } catch (error) {
      console.error('Failed to test reminder:', error);
      alert('Failed to test: ' + (error.response?.data?.error || error.message));
    }
  };

  const filteredLogs = logFilter === 'all'
    ? logs.filter(l => !l.is_archived)
    : logFilter === 'archived'
      ? logs.filter(l => l.is_archived)
      : logs.filter(l => !l.is_archived && l.status.toLowerCase() === logFilter);

  const formatTimeAgo = (ts) => {
    if (!ts) return 'N/A';
    const diff = Date.now() - new Date(ts + 'Z').getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'Just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  };

  const handleTitleSave = async (titleKey, value) => {
    setEditingTitle(null);
    const trimmed = (value || '').trim();
    if (!trimmed) return;
    setConfig(prev => ({ ...prev, [titleKey]: trimmed }));
    try {
      await axios.post(`${API_URL}/config`, { [titleKey]: trimmed });
      setSavedSnapshot(prev => ({ ...prev, [titleKey]: trimmed }));
    } catch (e) {
      console.error('Failed to save title:', e);
    }
  };

  const buildComparableFromRemote = (remote, remoteTargets, remoteIcalSources) => ({
    schedule: remote.schedule || '',
    template: remote.template || '',
    telegram_enabled: toBool(remote.telegram_enabled, true),
    telegram_bot_token: remote.telegram_bot_token || remote.gateio_api_key || '',
    telegram_chat_id: remote.telegram_chat_id || remote.gateio_api_secret || '',
    collection_alert_enabled: toBool(remote.collection_alert_enabled, true),
    collection_alert_time: remote.collection_alert_time || '19:00',
    collection_alert_days_before: String(remote.collection_alert_days_before || '1'),
    collection_template: remote.collection_template || '',
    whatsapp_targets: normalizeTargets(remoteTargets),
    ical_sources: normalizeIcalSources(remoteIcalSources),
    daily_duty_title: remote.daily_duty_title || 'Daily Duty Alert',
    collection_calendar_title: remote.collection_calendar_title || 'Collection Calendar',
    weekly_reminder_title: remote.weekly_reminder_title || 'Weekly Reminder',
    cleaning_reminder_enabled: toBool(remote.cleaning_reminder_enabled, true),
    cleaning_reminder_schedule: remote.cleaning_reminder_schedule || '0 16 * * 0',
    cleaning_reminder_template: remote.cleaning_reminder_template || ''
  });

  const buildComparableFromState = (state) => ({
    schedule: state.schedule || '',
    template: state.template || '',
    telegram_enabled: Boolean(state.telegram_enabled),
    telegram_bot_token: (state.telegram_bot_token || '').trim(),
    telegram_chat_id: (state.telegram_chat_id || '').trim(),
    collection_alert_enabled: Boolean(state.collection_alert_enabled),
    collection_alert_time: (state.collection_alert_time || '19:00').trim(),
    collection_alert_days_before: String(state.collection_alert_days_before || '1').trim(),
    collection_template: (state.collection_template || '').trim(),
    whatsapp_targets: normalizeTargets(state.whatsapp_targets),
    ical_sources: normalizeIcalSources(state.ical_sources),
    daily_duty_title: (state.daily_duty_title || 'Daily Duty Alert').trim(),
    collection_calendar_title: (state.collection_calendar_title || 'Collection Calendar').trim(),
    weekly_reminder_title: (state.weekly_reminder_title || 'Weekly Reminder').trim(),
    cleaning_reminder_enabled: Boolean(state.cleaning_reminder_enabled),
    cleaning_reminder_schedule: (state.cleaning_reminder_schedule || '0 16 * * 0').trim(),
    cleaning_reminder_template: (state.cleaning_reminder_template || '').trim()
  });

  const fetchData = async () => {
    try {
      const [configResult, undefinedResult] = await Promise.allSettled([
        axios.get(`${API_URL}/config`),
        fetchCustomReminders(),
        fetchLogsOnly()
      ]);

      if (configResult.status !== 'fulfilled') {
        throw configResult.reason;
      }

      const remote = configResult.value.data || {};
      const remoteTargets = Array.isArray(remote.whatsapp_targets)
        ? remote.whatsapp_targets
        : (remote.group_jid ? [{ jid: remote.group_jid, label: 'Primary Group', daily_enabled: true, collection_enabled: true, cleaning_enabled: true }] : []);
      const remoteIcalSources = Array.isArray(remote.ical_sources)
        ? remote.ical_sources
        : (remote.ical_url ? [{ url: remote.ical_url, label: 'Primary iCal', enabled: true }] : []);

      const nextConfig = {
        schedule: remote.schedule || '',
        template: remote.template || '',
        telegram_enabled: toBool(remote.telegram_enabled, true),
        telegram_bot_token: remote.telegram_bot_token || remote.gateio_api_key || '',
        telegram_chat_id: remote.telegram_chat_id || remote.gateio_api_secret || '',
        collection_alert_enabled: toBool(remote.collection_alert_enabled, true),
        collection_alert_time: remote.collection_alert_time || '19:00',
        collection_alert_days_before: String(remote.collection_alert_days_before || '1'),
        collection_template: remote.collection_template || '',
        whatsapp_targets: remoteTargets.length > 0
          ? remoteTargets.map((target) => makeWhatsAppTarget(target))
          : [makeWhatsAppTarget()],
        ical_sources: remoteIcalSources.length > 0
          ? remoteIcalSources.map((source) => makeIcalSource(source))
          : [makeIcalSource()],
        daily_duty_title: remote.daily_duty_title || 'Daily Duty Alert',
        collection_calendar_title: remote.collection_calendar_title || 'Collection Calendar',
        weekly_reminder_title: remote.weekly_reminder_title || 'Weekly Reminder',
        cleaning_reminder_enabled: toBool(remote.cleaning_reminder_enabled, true),
        cleaning_reminder_schedule: remote.cleaning_reminder_schedule || '0 16 * * 0',
        cleaning_reminder_template: remote.cleaning_reminder_template || ''
      };

      setConfig(nextConfig);
      setSavedSnapshot(buildComparableFromRemote(remote, remoteTargets, remoteIcalSources));
      setSaveErrors({ automation: '', whatsapp: '', telegram: '', collection: '', ical: '', template: '', cleaning: '', settings: '' });

      setSaveErrors({ automation: '', whatsapp: '', telegram: '', collection: '', ical: '', template: '', cleaning: '', settings: '' });
      setStatus('Connected & Active');
    } catch (error) {
      console.error('Error fetching data:', error);
      setStatus('Backend Offline');
    }
  };

  const handleChange = (e) => {
    setConfig((prev) => ({ ...prev, [e.target.name]: e.target.value }));
  };

  const updateListField = (listKey, localId, field, value) => {
    setConfig((prev) => ({
      ...prev,
      [listKey]: prev[listKey].map((item) => (
        item.localId === localId ? { ...item, [field]: value } : item
      ))
    }));
  };

  const addListItem = (listKey) => {
    setConfig((prev) => ({
      ...prev,
      [listKey]: [
        ...prev[listKey],
        listKey === 'whatsapp_targets' ? makeWhatsAppTarget() : makeIcalSource()
      ]
    }));
  };

  const deleteListItem = (listKey, localId) => {
    setConfig((prev) => {
      const nextItems = prev[listKey].filter((item) => item.localId !== localId);
      return {
        ...prev,
        [listKey]: nextItems.length > 0
          ? nextItems
          : [listKey === 'whatsapp_targets' ? makeWhatsAppTarget() : makeIcalSource()]
      };
    });
  };

  const isSectionDirty = (section) => {
    const current = buildComparableFromState(config);
    if (section === 'automation') return current.schedule !== savedSnapshot.schedule;
    if (section === 'whatsapp') return JSON.stringify(current.whatsapp_targets) !== JSON.stringify(savedSnapshot.whatsapp_targets);
    if (section === 'telegram') {
      return current.telegram_enabled !== savedSnapshot.telegram_enabled
        || current.telegram_bot_token !== savedSnapshot.telegram_bot_token
        || current.telegram_chat_id !== savedSnapshot.telegram_chat_id;
    }
    if (section === 'collection') {
      return current.collection_alert_enabled !== savedSnapshot.collection_alert_enabled
        || current.collection_alert_time !== savedSnapshot.collection_alert_time
        || current.collection_alert_days_before !== savedSnapshot.collection_alert_days_before
        || current.collection_template !== savedSnapshot.collection_template;
    }
    if (section === 'ical') return JSON.stringify(current.ical_sources) !== JSON.stringify(savedSnapshot.ical_sources);
    if (section === 'template') return current.template !== savedSnapshot.template;
    if (section === 'cleaning') {
      return current.cleaning_reminder_enabled !== savedSnapshot.cleaning_reminder_enabled
        || current.cleaning_reminder_schedule !== savedSnapshot.cleaning_reminder_schedule
        || current.cleaning_reminder_template !== savedSnapshot.cleaning_reminder_template;
    }
    if (section === 'settings') {
      return current.daily_duty_title !== savedSnapshot.daily_duty_title
        || current.collection_calendar_title !== savedSnapshot.collection_calendar_title
        || current.weekly_reminder_title !== savedSnapshot.weekly_reminder_title;
    }
    return false;
  };

  const buildPayloadForSection = (section) => {
    const current = buildComparableFromState(config);

    if (section === 'automation') {
      return { schedule: current.schedule };
    }
    if (section === 'whatsapp') {
      return { whatsapp_targets: current.whatsapp_targets };
    }
    if (section === 'telegram') {
      return {
        telegram_enabled: current.telegram_enabled,
        telegram_bot_token: current.telegram_bot_token,
        telegram_chat_id: current.telegram_chat_id,
        gateio_api_key: current.telegram_bot_token,
        gateio_api_secret: current.telegram_chat_id
      };
    }
    if (section === 'ical') {
      return { ical_sources: current.ical_sources };
    }
    if (section === 'collection') {
      return {
        collection_alert_enabled: current.collection_alert_enabled,
        collection_alert_time: current.collection_alert_time,
        collection_alert_days_before: current.collection_alert_days_before,
        collection_template: current.collection_template
      };
    }
    if (section === 'template') {
      return { template: current.template };
    }
    if (section === 'cleaning') {
      return {
        cleaning_reminder_enabled: current.cleaning_reminder_enabled,
        cleaning_reminder_schedule: current.cleaning_reminder_schedule,
        cleaning_reminder_template: current.cleaning_reminder_template
      };
    }
    if (section === 'settings') {
      return {
        daily_duty_title: current.daily_duty_title,
        collection_calendar_title: current.collection_calendar_title,
        weekly_reminder_title: current.weekly_reminder_title
      };
    }

    return {
      schedule: current.schedule,
      template: current.template,
      telegram_enabled: current.telegram_enabled,
      telegram_bot_token: current.telegram_bot_token,
      telegram_chat_id: current.telegram_chat_id,
      gateio_api_key: current.telegram_bot_token,
      gateio_api_secret: current.telegram_chat_id,
      collection_alert_enabled: current.collection_alert_enabled,
      collection_alert_time: current.collection_alert_time,
      collection_alert_days_before: current.collection_alert_days_before,
      collection_template: current.collection_template,
      whatsapp_targets: current.whatsapp_targets,
      ical_sources: current.ical_sources,
      daily_duty_title: current.daily_duty_title,
      collection_calendar_title: current.collection_calendar_title,
      weekly_reminder_title: current.weekly_reminder_title,
      cleaning_reminder_enabled: current.cleaning_reminder_enabled,
      cleaning_reminder_schedule: current.cleaning_reminder_schedule,
      cleaning_reminder_template: current.cleaning_reminder_template
    };
  };

  const saveSection = async (section) => {
    if (section !== 'all' && !isSectionDirty(section)) return;

    const payload = buildPayloadForSection(section);
    const stateKey = section;

    setSavingState((prev) => ({ ...prev, [stateKey]: true }));
    if (section !== 'all') {
      setSaveErrors((prev) => ({ ...prev, [section]: '' }));
    }

    try {
      await axios.post(`${API_URL}/config`, payload);
      await fetchData();
      setStatus(section === 'all' ? 'All Changes Saved!' : `${section[0].toUpperCase()}${section.slice(1)} Saved!`);
      setTimeout(() => setStatus('Connected & Active'), 1500);
    } catch (error) {
      console.error(`Failed to save ${section}:`, error);
      if (section !== 'all') {
        setSaveErrors((prev) => ({
          ...prev,
          [section]: error.response?.data?.error || 'Save failed'
        }));
      }
      setStatus('Save Failed');
    } finally {
      setSavingState((prev) => ({ ...prev, [stateKey]: false }));
    }
  };

  const getSectionStatusText = (section) => {
    if (savingState[section]) return 'Saving...';
    if (saveErrors[section]) return 'Save Failed';
    return isSectionDirty(section) ? 'Unsaved Changes' : 'Saved';
  };

  const getSectionStatusClass = (section) => {
    if (savingState[section]) return 'status-saving';
    if (saveErrors[section]) return 'status-error';
    return isSectionDirty(section) ? 'status-dirty' : 'status-saved';
  };

  const handleTestSend = async () => {
    setIsTesting(true);
    try {
      await axios.post(`${API_URL}/test-send`);
      setStatus('Test Message Triggered!');
      setTimeout(() => setStatus('Connected & Active'), 3000);
      setTimeout(fetchLogsOnly, 2000);
    } catch (error) {
      console.error('Failed test send:', error);
      setStatus('Send Failed');
    } finally {
      setIsTesting(false);
    }
  };

  const handleTestTelegram = async () => {
    if (!config.telegram_enabled) {
      alert('Turn on Telegram Available toggle first.');
      return;
    }
    if (!config.telegram_bot_token || !config.telegram_chat_id) {
      alert('Please enter both TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID to test Telegram.');
      return;
    }

    setIsTestingTelegram(true);
    setStatus('Testing Telegram...');

    try {
      await saveSection('telegram');
      await axios.post(`${API_URL}/test-telegram`, {
        botToken: config.telegram_bot_token,
        chatId: config.telegram_chat_id
      });
      setStatus('Telegram Test Sent!');
      setTimeout(() => setStatus('Connected & Active'), 2500);
      setTimeout(fetchLogsOnly, 1500);
    } catch (error) {
      console.error('Failed telegram test:', error);
      setStatus('Telegram Test Failed');
      alert(error.response?.data?.error || 'Failed to send Telegram test message');
    } finally {
      setIsTestingTelegram(false);
    }
  };

  const handlePreviewMessage = async () => {
    setIsPreviewingMessage(true);
    try {
      await saveSection('collection');
      await saveSection('ical');
      const res = await axios.get(`${API_URL}/preview-message`);
      setMessagePreview(res.data);
    } catch (error) {
      console.error('Failed to preview message:', error);
      alert(error.response?.data?.error || 'Failed to preview message');
    } finally {
      setIsPreviewingMessage(false);
    }
  };

  const handleTestCollectionSend = async () => {
    setIsTestingCollectionSend(true);
    try {
      await saveSection('collection');
      await saveSection('ical');
      await axios.post(`${API_URL}/test-collection-send`);
      setStatus('Collection Test Send Triggered!');
      setTimeout(() => setStatus('Connected & Active'), 2500);
      setTimeout(fetchLogsOnly, 1500);
    } catch (error) {
      console.error('Failed collection test send:', error);
      setStatus('Collection Send Failed');
      alert(error.response?.data?.error || 'Failed to trigger collection test send');
    } finally {
      setIsTestingCollectionSend(false);
    }
  };

  const handleTestCleaningSend = async () => {
    setIsTestingCleaningSend(true);
    try {
      await saveSection('cleaning');
      await axios.post(`${API_URL}/test-cleaning-send`);
      setStatus('Cleaning Reminder Triggered!');
      setTimeout(() => setStatus('Connected & Active'), 2500);
      setTimeout(fetchLogsOnly, 1500);
    } catch (error) {
      console.error('Failed cleaning test send:', error);
      setStatus('Cleaning Send Failed');
      alert(error.response?.data?.error || 'Failed to trigger cleaning reminder send');
    } finally {
      setIsTestingCleaningSend(false);
    }
  };

  const handlePreviewCleaning = async () => {
    setIsPreviewingCleaning(true);
    try {
      await saveSection('cleaning');
      const res = await axios.get(`${API_URL}/preview-cleaning`);
      setCleaningPreview(res.data);
    } catch (error) {
      console.error('Failed to preview cleaning:', error);
      alert(error.response?.data?.error || 'Failed to preview cleaning message');
    } finally {
      setIsPreviewingCleaning(false);
    }
  };

  const getActiveTabTitle = () => {
    switch (activeTab) {
      case 'whatsapp': return 'WhatsApp Targets';
      case 'daily': return config.daily_duty_title || 'Daily Duty Alert';
      case 'waste': return config.collection_calendar_title || 'Collection Calendar';
      case 'cleaning': return config.weekly_reminder_title || 'Weekly Reminder';
      case 'custom': return 'Custom Reminders';
      case 'settings': return 'System Settings';
      case 'analytics': return 'Dashboard Analytics';
      default: return 'WhatsApp Control Center';
    }
  };

  if (!authChecked) {
    return (
      <div className="login-screen">
        <div className="login-card glass-card">
          <p style={{ textAlign: 'center', opacity: 0.7 }}>Checking authentication...</p>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <LoginScreen onLogin={() => setIsAuthenticated(true)} />;
  }

  return (
    <div className="app-layout">
      <aside className={`sidebar ${isSidebarCollapsed ? 'collapsed' : ''}`}>
        <div className="sidebar-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          {!isSidebarCollapsed && (
            <div>
              <h1><LayoutDashboard size={24} color="var(--primary)" /> WA Control</h1>
              <p>Manage your automated messaging schedules and configurations.</p>
            </div>
          )}
          <button
            className="btn btn-secondary collapse-btn"
            style={{ padding: '8px', width: 'auto' }}
            onClick={() => setIsSidebarCollapsed(!isSidebarCollapsed)}
            title="Toggle Sidebar"
          >
            <Menu size={18} />
          </button>
        </div>

        <div className="sidebar-nav">
          <div className="nav-section-title">Core</div>
          <button
            className={`tab-btn ${activeTab === 'analytics' ? 'active' : ''}`}
            onClick={() => setActiveTab('analytics')}
          >
            <BarChart3 size={18} /> <span className="tab-title">Analytics</span>
          </button>
          <button
            className={`tab-btn ${activeTab === 'whatsapp' ? 'active' : ''}`}
            onClick={() => setActiveTab('whatsapp')}
          >
            <Settings2 size={18} /> <span className="tab-title">WhatsApp Targets</span>
          </button>

          <div className="nav-section-title">Built-in Reminders</div>
          {[{ key: 'daily', titleKey: 'daily_duty_title', icon: <Bell size={18} />, fallback: 'Daily Duty Alert' },
          { key: 'waste', titleKey: 'collection_calendar_title', icon: <Calendar size={18} />, fallback: 'Collection Calendar' },
          { key: 'cleaning', titleKey: 'weekly_reminder_title', icon: <>🧹</>, fallback: 'Weekly Reminder' }].map(tab => (
            <button
              key={tab.key}
              className={`tab-btn ${activeTab === tab.key ? 'active' : ''}`}
              onClick={() => setActiveTab(tab.key)}
            >
              {tab.icon}{' '}
              {editingTitle === tab.titleKey ? (
                <input
                  className="inline-title-input"
                  autoFocus
                  defaultValue={config[tab.titleKey] || tab.fallback}
                  onClick={e => e.stopPropagation()}
                  onBlur={e => handleTitleSave(tab.titleKey, e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') { e.target.blur(); } if (e.key === 'Escape') { setEditingTitle(null); } }}
                />
              ) : (
                <span className="tab-title" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  {config[tab.titleKey] || tab.fallback}
                  <Pencil
                    size={12}
                    className="tab-edit-icon"
                    onClick={e => { e.stopPropagation(); setEditingTitle(tab.titleKey); }}
                  />
                </span>
              )}
            </button>
          ))}

          <div className="nav-section-title">Extensions</div>
          <button
            className={`tab-btn ${activeTab === 'custom' ? 'active' : ''}`}
            onClick={() => setActiveTab('custom')}
          >
            <Plus size={18} /> <span className="tab-title">Custom Reminders</span>
          </button>

          <div className="nav-section-title">System</div>
          <button
            className={`tab-btn ${activeTab === 'settings' ? 'active' : ''}`}
            onClick={() => setActiveTab('settings')}
          >
            <Settings2 size={18} /> <span className="tab-title">Settings</span>
          </button>

          <div className="sidebar-spacer" />
          <button
            className="tab-btn logout-btn"
            onClick={handleLogout}
            title="Log Out"
          >
            <LogOut size={18} /> <span className="tab-title">Log Out</span>
          </button>
        </div>
      </aside>

      <main className="main-content">
        <div className="header">
          <div className="title-group">
            <h1>{getActiveTabTitle()}</h1>
          </div>
          <div className="status-badge">
            {status === 'Connected & Active' && <div className="dot"></div>}
            {status}
          </div>
        </div>


        {activeTab === 'daily' && (
          <div className="tab-content fade-in">

            <div className="glass-card">
              <div className="card-header">
                <div className="card-header-main">
                  <Clock size={20} />
                  Automation Engine
                </div>
                <div className="card-header-tools">
                  <div className={`card-header-status ${getSectionStatusClass('automation')}`}>
                    {getSectionStatusText('automation')}
                  </div>
                  <button
                    className="btn btn-secondary mini-save-btn"
                    title="Save Automation"
                    onClick={() => saveSection('automation')}
                    disabled={savingState.automation || !isSectionDirty('automation')}
                  >
                    <Save size={14} />
                  </button>
                </div>
              </div>
              <div className="input-group">
                <label>Cron Schedule</label>
                <input
                  type="text"
                  name="schedule"
                  value={config.schedule || ''}
                  onChange={handleChange}
                  placeholder="0 9 * * 1-6"
                />
                <div className="helper-text">Format: Minute Hour Day Month Day-of-Week.</div>
                <div className="helper-text">
                  On each scheduled run, the system sends your template to all enabled WhatsApp targets.
                  Scheduled runs skip Sunday. The {'{tomorrow_waste_type}'} variable is resolved from your enabled calendar source for tomorrow.
                </div>
              </div>
            </div>



            <div className="glass-card">
              <div className="card-header">
                <div className="card-header-main">
                  <Bell size={20} />
                  Message Context Blueprint
                </div>
                <div className="card-header-tools">
                  <div className={`card-header-status ${getSectionStatusClass('template')}`}>
                    {getSectionStatusText('template')}
                  </div>
                  <button
                    className="btn btn-secondary mini-save-btn"
                    title="Save Template"
                    onClick={() => saveSection('template')}
                    disabled={savingState.template || !isSectionDirty('template')}
                  >
                    <Save size={14} />
                  </button>
                </div>
              </div>
              <div className="input-group">
                <label>Context Blueprint</label>
                <textarea
                  name="template"
                  value={config.template || ''}
                  onChange={handleChange}
                  placeholder="Type your message here..."
                  style={{ minHeight: '200px' }}
                ></textarea>
                <div className="helper-text">
                  <strong>Available Dynamic Variables:</strong><br />
                  {'{today_name}'} = Day of week (e.g. Monday)<br />
                  {'{today_room}'} = Room on duty today<br />
                  {'{tmw_room}'} = Room on duty tomorrow<br />
                  {'{tomorrow_waste_type}'} = Tomorrow&apos;s collection payload from iCal (e.g., Garbage and Compost)
                </div>
              </div>
            </div>

            <div className="action-row">
              <button className="btn" onClick={() => saveSection('all')} disabled={savingState.all || !sectionKeys.some((k) => isSectionDirty(k))}>
                <Save size={18} /> {savingState.all ? 'Saving All...' : 'Save All Changes'}
              </button>
              <button className="btn btn-secondary" onClick={handleTestSend} disabled={isTesting}>
                <Send size={18} /> {isTesting ? 'Sending Trigger...' : 'Manually Trigger Send'}
              </button>
            </div>
          </div>
        )}

        {activeTab === 'waste' && (
          <div className="tab-content fade-in">
            <div className="glass-card">
              <div className="card-header">
                <div className="card-header-main">
                  <Clock size={20} />
                  {config.collection_calendar_title || 'Collection Calendar'} Configuration
                </div>
                <div className="card-header-tools">
                  <div className={`card-header-status ${getSectionStatusClass('collection')}`}>
                    {getSectionStatusText('collection')}
                  </div>
                  <button
                    className="btn btn-secondary mini-save-btn"
                    title="Save Collection Alert"
                    onClick={() => saveSection('collection')}
                    disabled={savingState.collection || !isSectionDirty('collection')}
                  >
                    <Save size={14} />
                  </button>
                </div>
              </div>

              <div className="list-item-top" style={{ marginBottom: '14px' }}>
                <label className="toggle-label">
                  <input
                    type="checkbox"
                    checked={Boolean(config.collection_alert_enabled)}
                    onChange={(e) => setConfig((prev) => ({ ...prev, collection_alert_enabled: e.target.checked }))}
                  />
                  Enable Collection Alerts
                </label>
              </div>

              <div className="grid-2">
                <div className="input-group">
                  <label>Alert Time (daily check)</label>
                  <input
                    type="text"
                    name="collection_alert_time"
                    value={config.collection_alert_time || '19:00'}
                    onChange={handleChange}
                    placeholder="19:00"
                  />
                </div>
                <div className="input-group">
                  <label>Days Before Collection</label>
                  <input
                    type="text"
                    name="collection_alert_days_before"
                    value={config.collection_alert_days_before || '1'}
                    onChange={handleChange}
                    placeholder="1"
                  />
                </div>
              </div>

              <div className="input-group" style={{ marginTop: '14px' }}>
                <label>Collection Alert Template</label>
                <textarea
                  name="collection_template"
                  value={config.collection_template || ''}
                  onChange={handleChange}
                  placeholder="Customize collection reminder message..."
                  style={{ minHeight: '130px' }}
                ></textarea>
                <div className="helper-text">
                  Variables: {'{collection_waste_type}'}, {'{collection_date}'}, {'{collection_day_name}'}, {'{days_until_collection}'}.
                </div>
              </div>

              <div className="section-actions">
                <button
                  className="btn btn-secondary"
                  style={{ width: 'auto' }}
                  onClick={handlePreviewMessage}
                  disabled={isPreviewingMessage}
                >
                  <MessageSquare size={16} /> {isPreviewingMessage ? 'Previewing...' : 'Test Alert Preview'}
                </button>
                <button
                  className="btn btn-secondary"
                  style={{ width: 'auto' }}
                  onClick={handleTestCollectionSend}
                  disabled={isTestingCollectionSend}
                >
                  <Send size={16} /> {isTestingCollectionSend ? 'Sending...' : 'Send Test Now'}
                </button>
              </div>

              {messagePreview && (
                <div className="preview-panel">
                  <div className="preview-title">Collection Alert Preview</div>
                  <div className="preview-meta">
                    Targets: {(messagePreview.targets || []).join(', ') || 'None configured'}
                  </div>
                  <div className="preview-meta">
                    Collection date: {messagePreview.collection_date || 'Unknown'} | Found event: {messagePreview.collection_exists ? 'Yes' : 'No'}
                  </div>
                  <div className="preview-meta">
                    Waste type: {messagePreview.waste_type || 'Unknown'} | Days before: {messagePreview.days_before ?? 1} | Days until: {messagePreview.days_until_collection ?? 'N/A'}
                  </div>
                  <div className="preview-meta">
                    Should send today: {messagePreview.should_send_today ? 'Yes' : 'No'}
                  </div>
                  <pre className="preview-message">{messagePreview.message || '(No message generated)'}</pre>
                </div>
              )}
            </div>

            <div className="glass-card">
              <div className="card-header">
                <div className="card-header-main">
                  <Calendar size={20} />
                  {config.collection_calendar_title || 'Collection Calendar'} Sources
                </div>
                <div className="card-header-tools">
                  <div className={`card-header-status ${getSectionStatusClass('ical')}`}>
                    {getSectionStatusText('ical')}
                  </div>
                  <button
                    className="btn btn-secondary mini-save-btn"
                    title="Save iCal Sources"
                    onClick={() => saveSection('ical')}
                    disabled={savingState.ical || !isSectionDirty('ical')}
                  >
                    <Save size={14} />
                  </button>
                </div>
              </div>
              <div className="helper-text" style={{ marginBottom: '14px' }}>
                Configure iCal data sources used to determine tomorrow&apos;s collection type for Daily Duty alerts.
                This section controls schedule data, not message sending time.
              </div>

              <div className="list-stack">
                {config.ical_sources.map((source) => (
                  <div className="list-item" key={source.localId}>
                    <div className="list-item-top">
                      <label className="toggle-label">
                        <input
                          type="checkbox"
                          checked={Boolean(source.enabled)}
                          onChange={(e) => updateListField('ical_sources', source.localId, 'enabled', e.target.checked)}
                        />
                        Available
                      </label>
                      <button
                        className="btn btn-secondary"
                        title="Delete iCal source"
                        style={{ width: 'auto', padding: '8px 10px' }}
                        onClick={() => deleteListItem('ical_sources', source.localId)}
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>

                    <div className="grid-2">
                      <div className="input-group">
                        <label>Source Label</label>
                        <input
                          type="text"
                          value={source.label}
                          onChange={(e) => updateListField('ical_sources', source.localId, 'label', e.target.value)}
                          placeholder="Abbotsford Waste Calendar"
                        />
                      </div>
                      <div className="input-group">
                        <label>iCal Subscription URL</label>
                        <input
                          type="text"
                          value={source.url}
                          onChange={(e) => updateListField('ical_sources', source.localId, 'url', e.target.value)}
                          placeholder="https://recollect.net/api/places/.../events.ics"
                        />
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              <div className="section-actions">
                <button
                  className="btn btn-secondary"
                  style={{ width: 'auto' }}
                  onClick={() => addListItem('ical_sources')}
                >
                  <Plus size={16} /> Add iCal Source
                </button>
              </div>

              <div className="helper-text" style={{ marginTop: '10px' }}>
                Find your address on your city&apos;s waste website and copy the &quot;Add to iCal&quot; link.
              </div>
            </div>
          </div>
        )}

        {activeTab === 'cleaning' && (
          <div className="tab-content fade-in">
            <div className="glass-card">
              <div className="card-header">
                <div className="card-header-main">
                  🧹 {config.weekly_reminder_title || 'Weekly Reminder'}
                </div>
                <div className="card-header-tools">
                  <div className={`card-header-status ${getSectionStatusClass('cleaning')}`}>
                    {getSectionStatusText('cleaning')}
                  </div>
                  <button
                    className="btn btn-secondary mini-save-btn"
                    title="Save Reminder Details"
                    onClick={() => saveSection('cleaning')}
                    disabled={savingState.cleaning || !isSectionDirty('cleaning')}
                  >
                    <Save size={14} />
                  </button>
                </div>
              </div>

              <div className="list-item-top" style={{ marginBottom: '14px' }}>
                <label className="toggle-label">
                  <input
                    type="checkbox"
                    checked={Boolean(config.cleaning_reminder_enabled)}
                    onChange={(e) => setConfig((prev) => ({ ...prev, cleaning_reminder_enabled: e.target.checked }))}
                  />
                  Enable Context Message
                </label>
              </div>

              <div className="input-group" style={{ maxWidth: '300px', marginBottom: '14px' }}>
                <label>Cron Schedule</label>
                <input
                  type="text"
                  name="cleaning_reminder_schedule"
                  value={config.cleaning_reminder_schedule || '0 16 * * 0'}
                  onChange={handleChange}
                  placeholder="0 16 * * 0"
                  disabled={!config.cleaning_reminder_enabled}
                />
                <div className="helper-text">Format: Minute Hour Day Month Day-of-Week.<br />Ex: 0 16 * * 0 runs every Sunday at 4PM.</div>
              </div>

              <div className="input-group">
                <label>Cleaning Reminder Template</label>
                <textarea
                  name="cleaning_reminder_template"
                  value={config.cleaning_reminder_template || ''}
                  onChange={handleChange}
                  placeholder="Type your cleaning reminder message here..."
                  style={{ minHeight: '160px' }}
                  disabled={!config.cleaning_reminder_enabled}
                ></textarea>
                <div className="helper-text">
                  Sent to all enabled WhatsApp targets every Sunday at the configured time.
                  No dynamic variables — the message is sent as-is to all housemates.
                </div>
              </div>

              <div className="section-actions">
                <button
                  className="btn btn-secondary"
                  style={{ width: 'auto' }}
                  onClick={handlePreviewCleaning}
                  disabled={isPreviewingCleaning}
                >
                  <MessageSquare size={16} /> {isPreviewingCleaning ? 'Previewing...' : 'Preview Message'}
                </button>
                <button
                  className="btn btn-secondary"
                  style={{ width: 'auto' }}
                  onClick={handleTestCleaningSend}
                  disabled={isTestingCleaningSend}
                >
                  <Send size={16} /> {isTestingCleaningSend ? 'Sending...' : 'Send Test Now'}
                </button>
              </div>

              {cleaningPreview && (
                <div className="preview-panel" style={{ marginTop: '16px' }}>
                  <div className="preview-title">Cleaning Reminder Preview</div>
                  <div className="preview-meta">
                    Targets: {(cleaningPreview.targets || []).join(', ') || 'None configured'}
                  </div>
                  <div className="preview-meta">
                    Can send: {cleaningPreview.can_send ? 'Yes' : 'No — check targets & template'}
                  </div>
                  <pre className="preview-message">{cleaningPreview.message || '(No message generated)'}</pre>
                </div>
              )}
            </div>
          </div>
        )}

        {activeTab === 'settings' && (
          <div className="tab-content fade-in">
            <div className="glass-card" style={{ padding: '16px 24px' }}>
              <div className="helper-text" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Pencil size={14} /> <strong>Tip:</strong> Click the ✏️ icon on any tab name above to rename it inline.
              </div>
            </div>

            <div className="glass-card">
              <div className="card-header">
                <div className="card-header-main">
                  <MessageSquare size={20} />
                  Telegram Summary Notifications (Optional)
                </div>
                <div className="card-header-tools">
                  <div className={`card-header-status ${getSectionStatusClass('telegram')}`}>
                    {getSectionStatusText('telegram')}
                  </div>
                  <button
                    className="btn btn-secondary mini-save-btn"
                    title="Save Telegram Settings"
                    onClick={() => saveSection('telegram')}
                    disabled={savingState.telegram || !isSectionDirty('telegram')}
                  >
                    <Save size={14} />
                  </button>
                </div>
              </div>
              <div className="list-item-top" style={{ marginBottom: '14px' }}>
                <label className="toggle-label">
                  <input
                    type="checkbox"
                    checked={Boolean(config.telegram_enabled)}
                    onChange={(e) => setConfig((prev) => ({ ...prev, telegram_enabled: e.target.checked }))}
                  />
                  Available
                </label>
              </div>
              <div className="grid-2">
                <div className="input-group">
                  <label>TELEGRAM_BOT_TOKEN</label>
                  <input
                    type="text"
                    name="telegram_bot_token"
                    value={config.telegram_bot_token || ''}
                    onChange={handleChange}
                    placeholder="Telegram bot token"
                    disabled={!config.telegram_enabled}
                  />
                </div>
                <div className="input-group">
                  <label>TELEGRAM_CHAT_ID</label>
                  <input
                    type="text"
                    name="telegram_chat_id"
                    value={config.telegram_chat_id || ''}
                    onChange={handleChange}
                    placeholder="Telegram chat id"
                    disabled={!config.telegram_enabled}
                  />
                </div>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '14px' }}>
                <div className="helper-text">
                  Sends only automation summary status (success/failure), not the full WhatsApp message body.
                </div>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button
                    className="btn btn-secondary"
                    style={{ width: 'auto', padding: '8px 16px', fontSize: '0.85rem' }}
                    onClick={handleTestTelegram}
                    disabled={isTestingTelegram || !config.telegram_enabled}
                  >
                    {isTestingTelegram ? 'Testing...' : 'Test Connection'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'analytics' && (
          <div className="tab-content fade-in">

            {/* Summary Stat Cards */}
            <div className="stats-grid">
              <div
                className="stat-card"
                style={{ cursor: 'pointer', border: showBreakdownModal ? '1px solid var(--primary)' : '' }}
                onClick={() => setShowBreakdownModal(!showBreakdownModal)}
              >
                <div className="stat-icon stat-icon-total"><Zap size={20} /></div>
                <div className="stat-value">{logStats?.total ?? '—'}</div>
                <div className="stat-label">Total Events</div>
              </div>
              <div className="stat-card">
                <div className="stat-icon stat-icon-success"><TrendingUp size={20} /></div>
                <div className="stat-value">{logStats?.successRate ?? '—'}%</div>
                <div className="stat-label">Success Rate</div>
              </div>
              <div className="stat-card">
                <div className="stat-icon stat-icon-error"><AlertTriangle size={20} /></div>
                <div className="stat-value">{logStats?.error ?? '—'}</div>
                <div className="stat-label">Errors</div>
              </div>
              <div className="stat-card">
                <div className="stat-icon stat-icon-activity"><Activity size={20} /></div>
                <div className="stat-value">{formatTimeAgo(logStats?.lastActivity)}</div>
                <div className="stat-label">Last Activity</div>
              </div>
            </div>

            {/* Breakdown View */}
            {showBreakdownModal && logStats?.breakdown && (
              <div className="glass-card fade-in" style={{ marginTop: '-4px', borderTopLeftRadius: 0, borderTopRightRadius: 0 }}>
                <div className="card-header" style={{ marginBottom: '12px', fontSize: '1rem' }}>
                  <div className="card-header-main">Event Breakdown by Title</div>
                </div>
                <div className="breakdown-list" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '12px' }}>
                  {logStats.breakdown.map((item, idx) => (
                    <div key={idx} style={{ background: 'rgba(255,255,255,0.03)', padding: '12px 16px', borderRadius: '8px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontSize: '0.9rem', color: 'var(--foreground)' }}>{item.title}</span>
                      <span style={{ fontSize: '1.2rem', fontWeight: 600, color: 'var(--primary)' }}>{item.count}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* 7-Day Activity Chart */}
            <div className="glass-card">
              <div className="card-header">
                <div className="card-header-main">
                  <BarChart3 size={20} />
                  7-Day Activity
                </div>
              </div>
              {logStats?.dailyActivity && (
                <div className="chart-container">
                  {(() => {
                    const maxVal = Math.max(1, ...logStats.dailyActivity.map(d => d.success + d.error + d.system + d.skipped));
                    return logStats.dailyActivity.map((day, i) => {
                      const total = day.success + day.error + day.system + day.skipped;
                      const pct = (total / maxVal) * 100;
                      const dayLabel = new Date(day.date + 'T12:00:00').toLocaleDateString('en', { weekday: 'short' });
                      return (
                        <div key={i} className="chart-col">
                          <div className="chart-bar-wrap">
                            <span className="chart-count">{total}</span>
                            <div className="chart-bar" style={{ height: `${Math.max(pct, 4)}%` }}>
                              {day.error > 0 && <div className="bar-seg bar-error" style={{ flex: day.error }} />}
                              {day.success > 0 && <div className="bar-seg bar-success" style={{ flex: day.success }} />}
                              {day.system > 0 && <div className="bar-seg bar-system" style={{ flex: day.system }} />}
                              {day.skipped > 0 && <div className="bar-seg bar-skipped" style={{ flex: day.skipped }} />}
                            </div>
                          </div>
                          <span className="chart-label">{dayLabel}</span>
                        </div>
                      );
                    });
                  })()}
                </div>
              )}
              <div className="chart-legend">
                <span><span className="legend-dot" style={{ background: 'var(--success)' }} /> Success</span>
                <span><span className="legend-dot" style={{ background: 'var(--error)' }} /> Error</span>
                <span><span className="legend-dot" style={{ background: 'var(--system)' }} /> System</span>
                <span><span className="legend-dot" style={{ background: 'var(--warning)' }} /> Skipped</span>
              </div>
            </div>

            {/* Filter Pills + Log Timeline */}
            <div className="glass-card">
              <div className="card-header">
                <div className="card-header-main">
                  <Activity size={20} />
                  Event Timeline
                </div>
              </div>
              <div className="filter-pills" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>
                <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                  {['all', 'success', 'error', 'system', 'skipped', 'archived'].map(f => (
                    <button
                      key={f}
                      className={`filter-pill ${logFilter === f ? 'active' : ''} ${f !== 'all' ? `pill-${f}` : ''}`}
                      onClick={() => setLogFilter(f)}
                    >
                      {f.charAt(0).toUpperCase() + f.slice(1)}
                      {f !== 'all' && <span className="pill-count">{logStats?.[f] ?? 0}</span>}
                    </button>
                  ))}
                </div>
                <button
                  className={`btn btn-secondary archive-all-btn ${confirmArchiveAll ? 'btn-danger' : ''}`}
                  title={confirmArchiveAll ? "Click again to confirm" : "Archive All Unarchived Logs"}
                  onClick={handleArchiveAllLogs}
                  onMouseLeave={() => setConfirmArchiveAll(false)}
                  style={{
                    width: 'auto', display: 'flex', alignItems: 'center', gap: '6px', padding: '6px 12px', fontSize: '0.85rem',
                    backgroundColor: confirmArchiveAll ? '#ff4b4b' : '',
                    color: confirmArchiveAll ? '#fff' : ''
                  }}
                >
                  <Archive size={14} />
                  {confirmArchiveAll ? "Confirm Archive" : "Archive All"}
                </button>
              </div>

              {filteredLogs.length === 0 ? (
                <p style={{ color: 'var(--muted)', textAlign: 'center', margin: '40px 0' }}>No events match this filter.</p>
              ) : (
                <div className="timeline">
                  {filteredLogs.map((log) => (
                    <div key={log.id} className={`log-item ${log.status.toLowerCase()}`}>
                      <div className="log-icon">
                        {log.status === 'SUCCESS' ? <CheckCircle size={18} />
                          : log.status === 'ERROR' ? <XCircle size={18} />
                            : log.status === 'SYSTEM' ? <Settings2 size={18} />
                              : <Activity size={18} />}
                      </div>
                      <div className="log-content">
                        <div className="log-header">
                          <span className="log-title">{log.message}</span>
                          <span className="log-time">{new Date(log.timestamp + 'Z').toLocaleString()}</span>
                        </div>
                        <div className="log-details">{log.details}</div>
                        <span className="log-badge">{log.status}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {
          activeTab === 'whatsapp' && (
            <div className="tab-content fade-in">
              <div className="glass-card">
                <div className="card-header">
                  <div className="card-header-main">
                    <Settings2 size={20} />
                    WhatsApp Targets
                  </div>
                  <div className="card-header-tools">
                    <div className={`card-header-status ${getSectionStatusClass('whatsapp')}`}>
                      {getSectionStatusText('whatsapp')}
                    </div>
                    <button
                      className="btn btn-secondary mini-save-btn"
                      title="Save WhatsApp Targets"
                      onClick={() => saveSection('whatsapp')}
                      disabled={savingState.whatsapp || !isSectionDirty('whatsapp')}
                    >
                      <Save size={14} />
                    </button>
                  </div>
                </div>
                <div className="helper-text" style={{ marginBottom: '14px' }}>
                  Add multiple groups/contacts, toggle each reminder type on/off, and remove entries you do not want.
                </div>

                <div className="list-stack">
                  {config.whatsapp_targets.map((target) => (
                    <div className="list-item" key={target.localId}>
                      <div className="list-item-top" style={{ flexWrap: 'wrap', gap: '8px' }}>
                        <div style={{ display: 'flex', gap: '16px', flex: 1, flexWrap: 'wrap' }}>
                          <label className="toggle-label" title={config.daily_duty_title || "Daily Duty Alert"}>
                            <input
                              type="checkbox"
                              checked={Boolean(target.daily_enabled)}
                              onChange={(e) => updateListField('whatsapp_targets', target.localId, 'daily_enabled', e.target.checked)}
                            />
                            <Bell size={14} style={{ marginLeft: '4px', verticalAlign: 'middle' }} /> {config.daily_duty_title ? config.daily_duty_title.split(' ')[0] : 'Daily'}
                          </label>
                          <label className="toggle-label" title={config.collection_calendar_title || "Collection Calendar"}>
                            <input
                              type="checkbox"
                              checked={Boolean(target.collection_enabled)}
                              onChange={(e) => updateListField('whatsapp_targets', target.localId, 'collection_enabled', e.target.checked)}
                            />
                            <Calendar size={14} style={{ marginLeft: '4px', verticalAlign: 'middle' }} /> {config.collection_calendar_title ? config.collection_calendar_title.split(' ')[0] : 'Collection'}
                          </label>
                          <label className="toggle-label" title={config.weekly_reminder_title || "Weekly Reminder"}>
                            <input
                              type="checkbox"
                              checked={Boolean(target.cleaning_enabled)}
                              onChange={(e) => updateListField('whatsapp_targets', target.localId, 'cleaning_enabled', e.target.checked)}
                            />
                            🧹 {config.weekly_reminder_title ? config.weekly_reminder_title.split(' ')[0] : 'Cleaning'}
                          </label>
                          {customReminders.filter(r => !r.isNew).map(cr => {
                            const isChecked = target.custom_reminders && target.custom_reminders.includes(cr.id);
                            return (
                              <label key={cr.id} className="toggle-label" title={cr.title}>
                                <input
                                  type="checkbox"
                                  checked={Boolean(isChecked)}
                                  onChange={(e) => {
                                    const currentCustoms = target.custom_reminders || [];
                                    const newCustoms = e.target.checked
                                      ? [...currentCustoms, cr.id]
                                      : currentCustoms.filter(id => id !== cr.id);
                                    updateListField('whatsapp_targets', target.localId, 'custom_reminders', newCustoms);
                                  }}
                                />
                                ⚡ {cr.title ? cr.title.split(' ')[0] : 'Custom'}
                              </label>
                            );
                          })}
                        </div>
                        <button
                          className="btn btn-secondary"
                          title="Delete target"
                          style={{ width: 'auto', padding: '8px 10px' }}
                          onClick={() => deleteListItem('whatsapp_targets', target.localId)}
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>

                      <div className="grid-2">
                        <div className="input-group">
                          <label>Target Label</label>
                          <input
                            type="text"
                            value={target.label}
                            onChange={(e) => updateListField('whatsapp_targets', target.localId, 'label', e.target.value)}
                            placeholder="House Group / Contact Name"
                          />
                        </div>
                        <div className="input-group">
                          <label>Group JID / Contact JID</label>
                          <input
                            type="text"
                            value={target.jid}
                            onChange={(e) => updateListField('whatsapp_targets', target.localId, 'jid', e.target.value)}
                            placeholder="120363406057001887@g.us"
                          />
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="section-actions">
                  <button
                    className="btn btn-secondary"
                    style={{ width: 'auto' }}
                    onClick={() => addListItem('whatsapp_targets')}
                  >
                    <Plus size={16} /> Add Target
                  </button>
                </div>
              </div>
            </div>
          )
        }

        {
          activeTab === 'custom' && (
            <div className="tab-content fade-in">
              <div className="glass-card">
                <div className="card-header">
                  <div className="card-header-main">
                    <Plus size={20} /> Custom Reminders
                  </div>
                </div>
                <div className="helper-text" style={{ marginBottom: '14px' }}>
                  Create unlimited custom automated messages with their own schedules and targets.
                </div>

                <div className="list-stack">
                  {customReminders.map((reminder) => (
                    <div className="list-item" key={reminder.id}>
                      <div className="list-item-top" style={{ flexWrap: 'wrap', gap: '8px' }}>
                        <div style={{ display: 'flex', gap: '16px', flex: 1 }}>
                          <label className="toggle-label">
                            <input
                              type="checkbox"
                              checked={Boolean(reminder.enabled)}
                              onChange={(e) => handleUpdateCustomReminder(reminder.id, 'enabled', e.target.checked)}
                            />
                            Enabled
                          </label>
                          <span style={{ fontWeight: 600, color: 'var(--primary)', padding: '4px 0' }}>{reminder.title}</span>
                        </div>
                        <div style={{ display: 'flex', gap: '8px' }}>
                          <button
                            className="btn btn-secondary"
                            title="Test Send"
                            style={{ width: 'auto', padding: '8px 10px' }}
                            onClick={() => handleTestCustomReminder(reminder.id)}
                            disabled={reminder.isNew}
                          >
                            <Send size={16} />
                          </button>
                          <button
                            className="btn btn-secondary"
                            title="Save Reminder"
                            style={{ width: 'auto', padding: '8px 10px' }}
                            onClick={() => handleSaveCustomReminder(reminder)}
                          >
                            <Save size={16} />
                          </button>
                          <button
                            className={`btn btn-secondary ${confirmDeleteId === reminder.id ? 'btn-danger' : ''}`}
                            title={confirmDeleteId === reminder.id ? "Click again to confirm" : "Delete Reminder"}
                            style={{
                              width: 'auto',
                              padding: '8px 10px',
                              backgroundColor: confirmDeleteId === reminder.id ? '#ff4b4b' : '',
                              color: confirmDeleteId === reminder.id ? '#fff' : ''
                            }}
                            onClick={() => handleDeleteCustomReminder(reminder.id, reminder.isNew)}
                            onMouseLeave={() => setConfirmDeleteId(null)}
                          >
                            <Trash2 size={16} />
                          </button>
                        </div>
                      </div>

                      <div className="grid-2">
                        <div className="input-group">
                          <label>Title</label>
                          <input
                            type="text"
                            value={reminder.title}
                            onChange={(e) => handleUpdateCustomReminder(reminder.id, 'title', e.target.value)}
                            placeholder="My Custom Reminder"
                          />
                        </div>
                        <div className="input-group">
                          <label>Cron Schedule</label>
                          <input
                            type="text"
                            value={reminder.cron_schedule}
                            onChange={(e) => handleUpdateCustomReminder(reminder.id, 'cron_schedule', e.target.value)}
                            placeholder="0 10 * * *"
                          />
                        </div>
                      </div>
                      <div className="input-group">
                        <label>Message Template</label>
                        <textarea
                          value={reminder.template}
                          onChange={(e) => handleUpdateCustomReminder(reminder.id, 'template', e.target.value)}
                          placeholder="Your custom message here..."
                          rows={3}
                        />
                      </div>
                    </div>
                  ))}
                </div>
                <div className="section-actions">
                  <button
                    className="btn btn-secondary"
                    style={{ width: 'auto' }}
                    onClick={handleAddCustomReminder}
                  >
                    <Plus size={16} /> Add Custom Reminder
                  </button>
                </div>
              </div>
            </div>
          )}
      </main>
    </div >
  );
}

export default App;
