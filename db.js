const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'tracker.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS activities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    tier TEXT NOT NULL CHECK(tier IN ('daily','weekly','monthly')),
    time_of_day TEXT,
    allotted_minutes INTEGER NOT NULL DEFAULT 0,
    fixed_day TEXT,
    reminder_time TEXT,
    archived INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS completions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    activity_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    done INTEGER NOT NULL DEFAULT 0,
    actual_minutes INTEGER,
    UNIQUE(activity_id, date),
    FOREIGN KEY(activity_id) REFERENCES activities(id)
  );

  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    endpoint TEXT NOT NULL UNIQUE,
    subscription_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sent_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    activity_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    UNIQUE(activity_id, date)
  );

  CREATE TABLE IF NOT EXISTS digest_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    date TEXT NOT NULL,
    slot TEXT NOT NULL,
    UNIQUE(kind, date, slot)
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS google_tokens (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    email TEXT,
    access_token TEXT,
    refresh_token TEXT,
    expiry_date INTEGER
  );

  CREATE TABLE IF NOT EXISTS scheduled_slots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    activity_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'auto',
    status TEXT NOT NULL DEFAULT 'planned',
    google_task_id TEXT,
    suppress_app_reminder INTEGER NOT NULL DEFAULT 0,
    UNIQUE(activity_id, date),
    FOREIGN KEY(activity_id) REFERENCES activities(id)
  );
`);

const defaultSettings = {
  weekly_time_1: '10:00',
  weekly_time_2: '16:00',
  monthly_time_1: '10:15',
  monthly_time_2: '16:15',
  eod_time: '18:00',
  work_start: '09:00',
  work_end: '18:00',
  work_midpoint: '13:00',
  work_days: 'Mon,Tue,Wed,Thu,Fri',
  week_planning_time: '10:00',
  month_planning_time: '10:00',
};
const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
for (const [k, v] of Object.entries(defaultSettings)) insertSetting.run(k, v);

// Seed with the Leader Standard Work sample activities, only if the table is empty
const count = db.prepare('SELECT COUNT(*) AS c FROM activities').get().c;

if (count === 0) {
  const insert = db.prepare(`
    INSERT INTO activities (name, tier, time_of_day, allotted_minutes, fixed_day, reminder_time)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const seed = db.transaction(() => {
    // Daily
    insert.run('Check & respond emails, pending doc approval, send reports', 'daily', 'Morning', 20, null, '09:00');
    insert.run('Update previous day performance, calendar & project lists', 'daily', 'Morning', 20, null, '09:20');
    insert.run("Review today's plan, note issues, set daily goals", 'daily', 'Morning', 15, null, '09:40');
    insert.run('Check email, documents, reports', 'daily', 'Noon', 20, null, '13:00');
    insert.run('Check email, send reports, update task/project list', 'daily', 'Evening', 30, null, '17:30');

    // Weekly — items with an implied natural day get one; others go to Monday summary (fixed_day = null)
    insert.run('Gemba Walk - Plant & Peripheral 5S', 'weekly', null, 120, 'Mon', '10:00');
    insert.run('QA - Complaints, Rejections, RCCA, PFMEA, Audits', 'weekly', null, 120, null, null);
    insert.run('Continuous Improvement - Drives', 'weekly', null, 120, null, null);
    insert.run('Production Meeting with Production team', 'weekly', null, 60, 'Mon', '11:00');
    insert.run('Program Reviews', 'weekly', null, 120, null, null);
    insert.run('Weekly Business Review with HoDs', 'weekly', null, 90, 'Fri', '15:00');
    insert.run('New Initiatives Drive - Digital', 'weekly', null, 60, null, null);
    insert.run('New Initiatives Drive 2', 'weekly', null, 60, null, null);
    insert.run('Safety', 'weekly', null, 30, 'Mon', '09:00');
    insert.run('Employee interactions', 'weekly', null, 60, null, null);
    insert.run('Critical Actions Review - from Monthly ops/MCM', 'weekly', null, 60, null, null);
    insert.run('Facility/Layout projects', 'weekly', null, 30, null, null);
    insert.run('Supply chain Concerns', 'weekly', null, 30, null, null);
    insert.run('TOP', 'weekly', null, 60, null, null);
    insert.run('Capex Management', 'weekly', null, 60, null, null);
    insert.run('TPM/Maintenance', 'weekly', null, 60, null, null);

    // Monthly
    insert.run('Risk Assessment of under-industrialisation programs', 'monthly', null, 120, '1', '10:00');
    insert.run('Finance MIS & PIP', 'monthly', null, 120, null, null);
    insert.run('Man Management Review with HR and HoDs', 'monthly', null, 60, null, null);
    insert.run('Audit Management - Observations Status review', 'monthly', null, 60, null, null);
    insert.run('Monthly Management Review / Operation Council Meeting', 'monthly', null, 120, '1', '11:00');
    insert.run('SAKSHAM & VIHAAN Initiatives', 'monthly', null, 60, null, null);
    insert.run('5S Audit', 'monthly', null, 60, null, null);
    insert.run('Capacity Planning', 'monthly', null, 120, null, null);
    insert.run('BSC tracking', 'monthly', null, 60, null, null);
    insert.run('Parts Stability Review', 'monthly', null, 60, null, null);
  });

  seed();
  console.log('Seeded database with LSW sample activities.');
}

module.exports = db;
