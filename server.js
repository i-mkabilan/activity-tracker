const express = require('express');
const path = require('path');
const webpush = require('web-push');
const cron = require('node-cron');
const db = require('./db');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---- Push setup ----
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || 'BFg-HGhCoNz_FRRg3HJck-NX7fPuThp2DqP5nQG4qKj8PUXteX8xAVBnEJeeWTVPXVCWzEslEneh28HoBf_ksNs';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || 'gKL2m9xowYtMr_N2ulJzIYszLOPHiFiEGu7ZkOJIfbA';
webpush.setVapidDetails('mailto:you@example.com', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

app.post('/api/subscribe', (req, res) => {
  const sub = req.body;
  db.prepare(`
    INSERT INTO push_subscriptions (endpoint, subscription_json)
    VALUES (?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET subscription_json = ?
  `).run(sub.endpoint, JSON.stringify(sub), JSON.stringify(sub));
  res.json({ ok: true });
});

async function sendPush(title, body, tag) {
  const subs = db.prepare('SELECT * FROM push_subscriptions').all();
  for (const row of subs) {
    try {
      await webpush.sendNotification(JSON.parse(row.subscription_json), JSON.stringify({ title, body, tag }));
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(row.id);
      } else {
        console.error('Push error:', err.message);
      }
    }
  }
}

// ---- Scheduler: runs every minute, checks activities against current time ----
function nowParts() {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return { time: `${hh}:${mm}`, day: dayNames[now.getDay()], date: now.toISOString().slice(0, 10), dateOfMonth: String(now.getDate()) };
}

function alreadySent(activityId, dateKey) {
  return !!db.prepare('SELECT 1 FROM sent_log WHERE activity_id = ? AND date = ?').get(activityId, dateKey);
}
function markSent(activityId, dateKey) {
  db.prepare('INSERT OR IGNORE INTO sent_log (activity_id, date) VALUES (?, ?)').run(activityId, dateKey);
}

cron.schedule('* * * * *', async () => {
  const { time, day, date, dateOfMonth } = nowParts();
  const activities = db.prepare('SELECT * FROM activities WHERE archived = 0').all();

  for (const a of activities) {
    // Daily: fires every day at reminder_time
    if (a.tier === 'daily' && a.reminder_time === time) {
      const key = `${date}`;
      if (!alreadySent(a.id, key)) {
        await sendPush(`${a.time_of_day || 'Reminder'}: ${a.name}`, `${a.allotted_minutes} min allotted`, `daily-${a.id}`);
        markSent(a.id, key);
      }
    }

    // Weekly: fixed day + time
    if (a.tier === 'weekly' && a.fixed_day === day && a.reminder_time === time) {
      const key = `${date}`;
      if (!alreadySent(a.id, key)) {
        await sendPush(a.name, `Weekly · ${a.allotted_minutes} min allotted`, `weekly-${a.id}`);
        markSent(a.id, key);
      }
    }

    // Monthly: fixed date-of-month + time
    if (a.tier === 'monthly' && a.fixed_day === dateOfMonth && a.reminder_time === time) {
      const key = `${date}`;
      if (!alreadySent(a.id, key)) {
        await sendPush(a.name, `Monthly · ${a.allotted_minutes} min allotted`, `monthly-${a.id}`);
        markSent(a.id, key);
      }
    }
  }

  // Monday 09:00 — summary of weekly items with no fixed day
  if (day === 'Mon' && time === '09:00') {
    const loose = activities.filter(a => a.tier === 'weekly' && !a.fixed_day);
    if (loose.length) {
      await sendPush('This week', loose.map(a => a.name).join(', '), 'weekly-summary');
    }
  }

  // 1st of month, 09:00 — summary of monthly items with no fixed date
  if (dateOfMonth === '1' && time === '09:00') {
    const loose = activities.filter(a => a.tier === 'monthly' && !a.fixed_day);
    if (loose.length) {
      await sendPush('This month', loose.map(a => a.name).join(', '), 'monthly-summary');
    }
  }
}, { timezone: 'Asia/Kolkata' });

// ---- Helpers ----
function isoDate(d) {
  return d.toISOString().slice(0, 10);
}
function startOfWeek(d) {
  const date = new Date(d);
  const day = date.getDay(); // 0 = Sunday
  const diff = (day === 0 ? -6 : 1) - day; // move to Monday
  date.setDate(date.getDate() + diff);
  date.setHours(0, 0, 0, 0);
  return date;
}
function daysBetween(a, b) {
  return Math.round((b - a) / 86400000);
}

// ---- Activities ----
app.get('/api/activities', (req, res) => {
  const tier = req.query.tier;
  const rows = tier
    ? db.prepare('SELECT * FROM activities WHERE tier = ? AND archived = 0 ORDER BY id').all(tier)
    : db.prepare('SELECT * FROM activities WHERE archived = 0 ORDER BY tier, id').all();
  res.json(rows);
});

app.post('/api/activities', (req, res) => {
  const { name, tier, time_of_day, allotted_minutes, fixed_day, reminder_time } = req.body;
  if (!name || !tier) return res.status(400).json({ error: 'name and tier are required' });
  const info = db.prepare(`
    INSERT INTO activities (name, tier, time_of_day, allotted_minutes, fixed_day, reminder_time)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(name, tier, time_of_day || null, allotted_minutes || 0, fixed_day || null, reminder_time || null);
  res.json({ id: info.lastInsertRowid });
});

app.delete('/api/activities/:id', (req, res) => {
  db.prepare('UPDATE activities SET archived = 1 WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---- Completions ----
// Toggle or set completion for an activity on a given date (defaults to today)
app.post('/api/completions', (req, res) => {
  const { activity_id, date, done, actual_minutes } = req.body;
  const d = date || isoDate(new Date());
  db.prepare(`
    INSERT INTO completions (activity_id, date, done, actual_minutes)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(activity_id, date) DO UPDATE SET done = ?, actual_minutes = ?
  `).run(activity_id, d, done ? 1 : 0, actual_minutes || null, done ? 1 : 0, actual_minutes || null);
  res.json({ ok: true });
});

// Get completions for a date range
app.get('/api/completions', (req, res) => {
  const { from, to } = req.query;
  const rows = db.prepare('SELECT * FROM completions WHERE date BETWEEN ? AND ?').all(from, to);
  res.json(rows);
});

// ---- Analytics ----
app.get('/api/analytics', (req, res) => {
  const today = new Date();
  const todayStr = isoDate(today);
  const weekStart = isoDate(startOfWeek(today));
  const monthStart = todayStr.slice(0, 7) + '-01';

  const activities = db.prepare('SELECT * FROM activities WHERE archived = 0').all();
  const allCompletions = db.prepare('SELECT * FROM completions').all();

  const compMap = {}; // activity_id -> date -> row
  for (const c of allCompletions) {
    compMap[c.activity_id] = compMap[c.activity_id] || {};
    compMap[c.activity_id][c.date] = c;
  }

  function statsFor(tier, sinceStr) {
    const acts = activities.filter(a => a.tier === tier);
    let totalAllotted = 0, totalActual = 0, done = 0, total = 0;
    for (const a of acts) {
      total++;
      totalAllotted += a.allotted_minutes;
      const c = compMap[a.id]?.[todayStr] || Object.values(compMap[a.id] || {}).find(x => x.date >= sinceStr);
      if (c && c.done) {
        done++;
        totalActual += c.actual_minutes || a.allotted_minutes;
      }
    }
    return { total, done, totalAllotted, totalActual };
  }

  // Last 7 days trend (count of daily activities done per day)
  const trend = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const dStr = isoDate(d);
    const dailyActs = activities.filter(a => a.tier === 'daily');
    let doneCount = 0;
    for (const a of dailyActs) {
      if (compMap[a.id]?.[dStr]?.done) doneCount++;
    }
    trend.push({ date: dStr, done: doneCount, total: dailyActs.length });
  }

  // Streak: consecutive days (ending today) where all daily activities were completed
  let streak = 0;
  const dailyActs = activities.filter(a => a.tier === 'daily');
  for (let i = 0; i < 365; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const dStr = isoDate(d);
    const allDone = dailyActs.length > 0 && dailyActs.every(a => compMap[a.id]?.[dStr]?.done);
    if (allDone) streak++;
    else break;
  }

  res.json({
    date: todayStr,
    daily: statsFor('daily', todayStr),
    weekly: statsFor('weekly', weekStart),
    monthly: statsFor('monthly', monthStart),
    trend,
    streak,
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Activity tracker running at http://localhost:${PORT}`);
});
