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

app.post('/api/completions/bulk', (req, res) => {
  const { activity_ids, date } = req.body;
  const d = date || isoDate(new Date());
  const upsert = db.prepare(`
    INSERT INTO completions (activity_id, date, done)
    VALUES (?, ?, 1)
    ON CONFLICT(activity_id, date) DO UPDATE SET done = 1
  `);
  for (const id of (activity_ids || [])) upsert.run(id, d);
  res.json({ ok: true, count: (activity_ids || []).length });
});

app.post('/api/subscribe', (req, res) => {
  const sub = req.body;
  db.prepare(`
    INSERT INTO push_subscriptions (endpoint, subscription_json)
    VALUES (?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET subscription_json = ?
  `).run(sub.endpoint, JSON.stringify(sub), JSON.stringify(sub));
  res.json({ ok: true });
});

async function sendPush(title, body, tag, data) {
  const subs = db.prepare('SELECT * FROM push_subscriptions').all();
  for (const row of subs) {
    try {
      await webpush.sendNotification(JSON.parse(row.subscription_json), JSON.stringify({ title, body, tag, data }));
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

function digestSent(kind, dateKey, slot) {
  return !!db.prepare('SELECT 1 FROM digest_log WHERE kind = ? AND date = ? AND slot = ?').get(kind, dateKey, slot);
}
function markDigestSent(kind, dateKey, slot) {
  db.prepare('INSERT OR IGNORE INTO digest_log (kind, date, slot) VALUES (?, ?, ?)').run(kind, dateKey, slot);
}

function isCompletedOn(activityId, dateStr) {
  return !!db.prepare('SELECT 1 FROM completions WHERE activity_id = ? AND date = ? AND done = 1').get(activityId, dateStr);
}
function isCompletedSince(activityId, sinceStr, todayStr) {
  return !!db.prepare('SELECT 1 FROM completions WHERE activity_id = ? AND date >= ? AND date <= ? AND done = 1')
    .get(activityId, sinceStr, todayStr);
}


app.get('/api/settings', (req, res) => {
  const rows = db.prepare('SELECT * FROM settings').all();
  const out = {};
  rows.forEach(r => out[r.key] = r.value);
  res.json(out);
});

app.post('/api/settings', (req, res) => {
  const upsert = db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = ?
  `);
  for (const [k, v] of Object.entries(req.body)) {
    upsert.run(k, v, v);
  }
  res.json({ ok: true });
});

function getSettings() {
  const rows = db.prepare('SELECT * FROM settings').all();
  const out = {};
  rows.forEach(r => out[r.key] = r.value);
  return out;
}

const { generateMonthlyReport } = require('./report');

app.get('/api/report/monthly', (req, res) => {
  const monthStr = req.query.month || new Date().toISOString().slice(0, 7); // YYYY-MM
  const activities = db.prepare('SELECT * FROM activities WHERE archived = 0 ORDER BY tier, id').all();
  const [year, monthNum] = monthStr.split('-').map(Number);
  const from = `${monthStr}-01`;
  const lastDay = new Date(year, monthNum, 0).getDate();
  const to = `${monthStr}-${String(lastDay).padStart(2, '0')}`;
  const completions = db.prepare('SELECT * FROM completions WHERE date >= ? AND date <= ?').all(from, to);

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="LSW-Report-${monthStr}.pdf"`);
  generateMonthlyReport(res, { monthStr, activities, completions });
});

app.get('/api/history', (req, res) => {
  const today = new Date();
  const activities = db.prepare('SELECT * FROM activities WHERE archived = 0').all();
  const dailyActs = activities.filter(a => a.tier === 'daily');
  const weeklyActs = activities.filter(a => a.tier === 'weekly');
  const monthlyActs = activities.filter(a => a.tier === 'monthly');

  function isCompletedOn(id, d) {
    return !!db.prepare('SELECT 1 FROM completions WHERE activity_id=? AND date=? AND done=1').get(id, d);
  }
  function isCompletedSince(id, since, until) {
    return !!db.prepare('SELECT 1 FROM completions WHERE activity_id=? AND date>=? AND date<=? AND done=1').get(id, since, until);
  }

  // Last 14 days, daily completion
  const daily = [];
  for (let i = 0; i < 14; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const dStr = isoDate(d);
    const done = dailyActs.filter(a => isCompletedOn(a.id, dStr)).length;
    daily.push({
      label: i === 0 ? 'Today' : d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }),
      done, total: dailyActs.length
    });
  }

  // Last 4 weeks
  const weekly = [];
  for (let i = 0; i < 4; i++) {
    const ref = new Date(today);
    ref.setDate(ref.getDate() - i * 7);
    const wStart = startOfWeek(ref);
    const wEnd = new Date(wStart); wEnd.setDate(wEnd.getDate() + 6);
    const wStartStr = isoDate(wStart);
    const wEndStr = isoDate(wEnd < today ? wEnd : today);
    const done = weeklyActs.filter(a => isCompletedSince(a.id, wStartStr, wEndStr)).length;
    weekly.push({
      label: i === 0 ? 'This week' : `Week of ${wStart.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`,
      done, total: weeklyActs.length
    });
  }

  // Last 3 months
  const monthly = [];
  for (let i = 0; i < 3; i++) {
    const ref = new Date(today.getFullYear(), today.getMonth() - i, 1);
    const mStart = isoDate(ref);
    const mEndDate = new Date(ref.getFullYear(), ref.getMonth() + 1, 0);
    const mEnd = isoDate(mEndDate < today ? mEndDate : today);
    const done = monthlyActs.filter(a => isCompletedSince(a.id, mStart, mEnd)).length;
    monthly.push({
      label: i === 0 ? 'This month' : ref.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }),
      done, total: monthlyActs.length
    });
  }

  res.json({ daily, weekly, monthly });
});

app.get('/api/debug', (req, res) => {
  const activities = db.prepare('SELECT id, name, tier, reminder_time, fixed_day FROM activities WHERE archived = 0').all();
  const subs = db.prepare('SELECT id, endpoint, created_at FROM push_subscriptions').all();
  res.json({ serverTimeNow: nowParts(), activities, subscriptionCount: subs.length, subscriptions: subs });
});

cron.schedule('* * * * *', async () => {
  const { time, date } = nowParts();
  console.log(`[cron tick] ${date} ${time}`);
  const activities = db.prepare('SELECT * FROM activities WHERE archived = 0').all();
  const settings = getSettings();

  // ---- Daily: at each distinct daily reminder time, list everything due-so-far that's still unfinished ----
  const dailyActs = activities.filter(a => a.tier === 'daily' && a.reminder_time);
  const distinctDailyTimes = [...new Set(dailyActs.map(a => a.reminder_time))];

  if (distinctDailyTimes.includes(time) && !digestSent('daily', date, time)) {
    const pending = dailyActs.filter(a => a.reminder_time <= time && !isCompletedOn(a.id, date));
    if (pending.length) {
      const names = pending.map(a => a.name).join(', ');
      await sendPush(`${pending.length} daily activities remaining`, names, 'daily-digest', { ids: pending.map(a => a.id), date });
    }
    markDigestSent('daily', date, time);
  }

  // ---- Weekly: two checkpoints a day (first half / second half), within working hours ----
  const weeklyTimes = [settings.weekly_time_1, settings.weekly_time_2].filter(Boolean);
  if (weeklyTimes.includes(time) && !digestSent('weekly', date, time)) {
    const weekStart = isoDate(startOfWeek(new Date()));
    const pending = activities.filter(a => a.tier === 'weekly' && !isCompletedSince(a.id, weekStart, date));
    if (pending.length) {
      const names = pending.map(a => a.name).join(', ');
      await sendPush(`${pending.length} weekly activities remaining`, names, 'weekly-digest');
    }
    markDigestSent('weekly', date, time);
  }

  // ---- Monthly: two checkpoints a day, within working hours ----
  const monthlyTimes = [settings.monthly_time_1, settings.monthly_time_2].filter(Boolean);
  if (monthlyTimes.includes(time) && !digestSent('monthly', date, time)) {
    const monthStart = date.slice(0, 7) + '-01';
    const pending = activities.filter(a => a.tier === 'monthly' && !isCompletedSince(a.id, monthStart, date));
    if (pending.length) {
      const names = pending.map(a => a.name).join(', ');
      await sendPush(`${pending.length} monthly activities remaining`, names, 'monthly-digest');
    }
    markDigestSent('monthly', date, time);
  }

  // ---- End of day: today's status + tomorrow's daily lineup ----
  if (time === settings.eod_time && !digestSent('eod', date, time)) {
    const doneToday = dailyActs.filter(a => isCompletedOn(a.id, date));
    const pendingToday = dailyActs.filter(a => !isCompletedOn(a.id, date));
    const tomorrowNames = dailyActs.map(a => a.name);

    let body = `Today: ${doneToday.length}/${dailyActs.length} done.`;
    if (pendingToday.length) body += ` Missed: ${pendingToday.map(a => a.name).join(', ')}.`;
    if (tomorrowNames.length) body += ` Tomorrow: ${tomorrowNames.join(', ')}.`;

    await sendPush('Daily status', body, 'eod-digest');
    markDigestSent('eod', date, time);
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

app.patch('/api/activities/:id', (req, res) => {
  const { reminder_time, time_of_day, fixed_day } = req.body;
  const a = db.prepare('SELECT * FROM activities WHERE id = ?').get(req.params.id);
  if (!a) return res.status(404).json({ error: 'not found' });
  db.prepare('UPDATE activities SET reminder_time = ?, time_of_day = ?, fixed_day = ? WHERE id = ?')
    .run(reminder_time ?? a.reminder_time, time_of_day ?? a.time_of_day, fixed_day ?? a.fixed_day, req.params.id);
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
