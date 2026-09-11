const express = require('express');
const path = require('path');
const db = require('./db');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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
