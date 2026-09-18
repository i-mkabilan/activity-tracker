let currentTier = 'daily';
let editingActivityId = null;
const todayStr = new Date().toISOString().slice(0, 10);

let selectedDate = todayStr;                  // Daily tab
let currentWeekStart = mondayOf(new Date());   // Weekly tab
let currentMonthKey = todayStr.slice(0, 7);    // Monthly tab
let chooseTimeCtx = null;

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

document.getElementById('todayLabel').textContent = new Date().toLocaleDateString(undefined, {
  weekday: 'long', month: 'short', day: 'numeric'
});

// ---- Calendar-date-only arithmetic, UTC-anchored so it never shifts across the
// viewer's local timezone (a local-time Date round-tripped through toISOString()
// can land on the wrong calendar day for UTC+ timezones). ----
function pad2(n) { return String(n).padStart(2, '0'); }
function fmtDateStr(d) { return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`; }

function mondayOf(d) {
  const date = d instanceof Date ? d : new Date(d);
  const utc = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = utc.getUTCDay();
  utc.setUTCDate(utc.getUTCDate() + (day === 0 ? -6 : 1) - day);
  return fmtDateStr(utc);
}
function addDaysStr(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const utc = new Date(Date.UTC(y, m - 1, d));
  utc.setUTCDate(utc.getUTCDate() + n);
  return fmtDateStr(utc);
}
function shiftMonthKey(monthKey, delta) {
  const [y, m] = monthKey.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`;
}
function dateForWeekday(weekStart, dayName) {
  const targetIdx = DAY_NAMES.indexOf(dayName);
  let offset = targetIdx - 1; // weekStart is always Monday (index 1)
  if (offset < 0) offset += 7;
  return addDaysStr(weekStart, offset);
}
function addMinutesToTime(hhmm, minutes) {
  const [h, m] = hhmm.split(':').map(Number);
  const total = h * 60 + m + minutes;
  return `${pad2(Math.floor(total / 60) % 24)}:${pad2(total % 60)}`;
}
function escapeAttr(s) { return String(s).replace(/"/g, '&quot;'); }
function formatDayLabel(dateStr) {
  return new Date(dateStr + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

// ---- Tab switching ----
document.querySelectorAll('.tier-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tier-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentTier = btn.dataset.tier;
    renderCurrentTier();
  });
});

function renderCurrentTier() {
  document.getElementById('dailyDateRow').style.display = currentTier === 'daily' ? 'flex' : 'none';
  document.getElementById('periodToolbar').style.display = currentTier === 'daily' ? 'none' : 'flex';
  document.getElementById('calendarSection').style.display = 'none';

  document.getElementById('tierLabel').textContent =
    currentTier === 'daily' ? "Today's routine" :
    currentTier === 'weekly' ? "This week" : "This month";
  document.getElementById('tierHint').textContent =
    currentTier === 'daily' ? '' : 'Notification times for this tier are set in Settings, not per activity.';

  if (currentTier === 'daily') loadDaily(selectedDate);
  else if (currentTier === 'weekly') loadWeekly(currentWeekStart);
  else loadMonthly(currentMonthKey);
}

// ---- Daily date navigation ----
const dailyDateInput = document.getElementById('dailyDateInput');
dailyDateInput.value = selectedDate;
dailyDateInput.addEventListener('change', () => {
  selectedDate = dailyDateInput.value || todayStr;
  loadDaily(selectedDate);
});
document.getElementById('prevDayBtn').addEventListener('click', () => {
  selectedDate = addDaysStr(selectedDate, -1);
  dailyDateInput.value = selectedDate;
  loadDaily(selectedDate);
});
document.getElementById('nextDayBtn').addEventListener('click', () => {
  selectedDate = addDaysStr(selectedDate, 1);
  dailyDateInput.value = selectedDate;
  loadDaily(selectedDate);
});

// ---- Weekly/Monthly period navigation ----
document.getElementById('prevPeriodBtn').addEventListener('click', () => {
  if (currentTier === 'weekly') { currentWeekStart = addDaysStr(currentWeekStart, -7); loadWeekly(currentWeekStart); }
  else if (currentTier === 'monthly') { currentMonthKey = shiftMonthKey(currentMonthKey, -1); loadMonthly(currentMonthKey); }
});
document.getElementById('nextPeriodBtn').addEventListener('click', () => {
  if (currentTier === 'weekly') { currentWeekStart = addDaysStr(currentWeekStart, 7); loadWeekly(currentWeekStart); }
  else if (currentTier === 'monthly') { currentMonthKey = shiftMonthKey(currentMonthKey, 1); loadMonthly(currentMonthKey); }
});

// ---- Daily tab ----
async function loadDaily(dateStr) {
  await refreshCalendarSection(dateStr);

  const [acts, completions] = await Promise.all([
    fetch('/api/activities?tier=daily').then(r => r.json()),
    fetch(`/api/completions?from=${dateStr}&to=${dateStr}`).then(r => r.json())
  ]);
  const doneSet = new Set(completions.filter(c => c.done).map(c => c.activity_id));

  const list = document.getElementById('activityList');
  if (acts.length === 0) {
    list.innerHTML = '<div class="empty">Nothing here yet. Add your first activity below.</div>';
    document.getElementById('tierCount').textContent = '0 / 0 done';
    return;
  }

  let doneCount = 0;
  list.innerHTML = acts.map(a => {
    const done = doneSet.has(a.id);
    if (done) doneCount++;
    const metaParts = [];
    if (a.time_of_day) metaParts.push(a.time_of_day);
    if (a.reminder_time) metaParts.push(a.reminder_time);
    if (a.allotted_minutes) metaParts.push(`${a.allotted_minutes} min`);
    return `
      <div class="activity">
        <div class="check ${done ? 'done' : ''}" data-check="${a.id}" data-date="${dateStr}">
          <svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
        </div>
        <div class="act-body">
          <p class="act-name ${done ? 'done' : ''}">${a.name}</p>
          <p class="act-meta">${metaParts.join(' · ')}</p>
        </div>
        <button class="edit-time" data-edit="${a.id}" data-name="${escapeAttr(a.name)}" data-time="${a.reminder_time || ''}" title="Edit reminder time"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><polyline points="12 7 12 12 16 14"></polyline></svg></button>
        <button class="del" data-del="${a.id}">&times;</button>
      </div>
    `;
  }).join('');

  document.getElementById('tierCount').textContent = `${doneCount} / ${acts.length} done`;

  list.querySelectorAll('[data-check]').forEach(el => {
    el.addEventListener('click', async () => {
      const nowDone = !el.classList.contains('done');
      await fetch('/api/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ activity_id: el.dataset.check, date: el.dataset.date, done: nowDone })
      });
      loadDaily(dateStr);
      refreshStreak();
    });
  });
  wireEditAndDelete(() => loadDaily(dateStr));
}

async function refreshCalendarSection(dateStr) {
  const status = await fetch('/api/calendar/status').then(r => r.json());
  refreshConnectBanner(status);
  if (!status.connected) {
    document.getElementById('calendarSection').style.display = 'none';
    return;
  }
  document.getElementById('calendarSection').style.display = 'block';
  const data = await fetch(`/api/calendar/range?from=${dateStr}&to=${dateStr}`).then(r => r.json());
  const list = document.getElementById('calendarEvents');
  if (!data.events || data.events.length === 0) {
    list.innerHTML = '<div class="empty">No meetings — open day ahead.</div>';
    return;
  }
  list.innerHTML = data.events.map(e => {
    const timeLabel = e.allDay ? 'All day' : new Date(e.start).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    return `
      <div class="cal-event">
        <span class="cal-event-time">${timeLabel}</span>
        <span class="cal-event-name">${e.summary}</span>
      </div>
    `;
  }).join('');
}

// ---- Weekly tab ----
async function loadWeekly(weekStart) {
  currentWeekStart = weekStart;
  const weekEnd = addDaysStr(weekStart, 6);
  document.getElementById('periodLabel').textContent =
    `${formatDayLabel(weekStart).replace(/^\w+, /, '')} – ${formatDayLabel(weekEnd).replace(/^\w+, /, '')}`;

  const [acts, completions, schedule] = await Promise.all([
    fetch('/api/activities?tier=weekly').then(r => r.json()),
    fetch(`/api/completions?from=${weekStart}&to=${weekEnd}`).then(r => r.json()),
    fetch(`/api/schedule/week?weekStart=${weekStart}`).then(r => r.json())
  ]);

  renderPeriodTier(acts, completions, schedule.slots || [], {
    fixedDate: a => dateForWeekday(weekStart, a.fixed_day),
    defaultDate: weekStart < todayStr ? todayStr : weekStart,
    reload: () => loadWeekly(currentWeekStart),
  });
}

// ---- Monthly tab ----
async function loadMonthly(monthKey) {
  currentMonthKey = monthKey;
  const [y, m] = monthKey.split('-').map(Number);
  const monthEnd = fmtDateStr(new Date(Date.UTC(y, m, 0)));
  document.getElementById('periodLabel').textContent =
    new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' });

  const [acts, completions, schedule] = await Promise.all([
    fetch('/api/activities?tier=monthly').then(r => r.json()),
    fetch(`/api/completions?from=${monthKey}-01&to=${monthEnd}`).then(r => r.json()),
    fetch(`/api/schedule/month?month=${monthKey}`).then(r => r.json())
  ]);

  const monthStart = `${monthKey}-01`;
  renderPeriodTier(acts, completions, schedule.slots || [], {
    fixedDate: a => `${monthKey}-${pad2(Number(a.fixed_day))}`,
    defaultDate: monthStart < todayStr ? todayStr : monthStart,
    reload: () => loadMonthly(currentMonthKey),
  });
}

// Shared renderer for Weekly/Monthly: each activity is fixed / accepted / suggested / unscheduled.
function renderPeriodTier(acts, completions, slots, { fixedDate, defaultDate, reload }) {
  const slotByActivity = {};
  slots.forEach(s => { slotByActivity[s.activity_id] = s; });
  const doneDates = {};
  completions.forEach(c => {
    if (!c.done) return;
    doneDates[c.activity_id] = doneDates[c.activity_id] || new Set();
    doneDates[c.activity_id].add(c.date);
  });

  const list = document.getElementById('activityList');
  if (acts.length === 0) {
    list.innerHTML = '<div class="empty">Nothing here yet. Add your first activity below.</div>';
    document.getElementById('tierCount').textContent = '0 / 0 done';
    return;
  }

  let doneCount = 0;
  list.innerHTML = acts.map(a => {
    if (a.fixed_day) {
      const date = fixedDate(a);
      const done = !!doneDates[a.id]?.has(date);
      if (done) doneCount++;
      return committedRowHtml(a, date, a.fixed_day, done, a.reminder_time);
    }
    const slot = slotByActivity[a.id];
    if (slot && slot.status === 'accepted') {
      const done = !!doneDates[a.id]?.has(slot.date);
      if (done) doneCount++;
      return committedRowHtml(a, slot.date, formatDayLabel(slot.date).split(',')[0], done, slot.start_time);
    }
    if (slot && slot.status === 'suggested') return suggestionRowHtml(a, slot);
    return unscheduledRowHtml(a, defaultDate);
  }).join('');

  document.getElementById('tierCount').textContent = `${doneCount} / ${acts.length} done`;
  wirePeriodRowHandlers(reload);
}

function committedRowHtml(a, dateStr, tagLabel, done, time) {
  const metaParts = [];
  if (time) metaParts.push(time);
  if (a.allotted_minutes) metaParts.push(`${a.allotted_minutes} min`);
  return `
    <div class="activity">
      <div class="check ${done ? 'done' : ''}" data-check="${a.id}" data-date="${dateStr}">
        <svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
      </div>
      <div class="act-body">
        <p class="act-name ${done ? 'done' : ''}">${a.name}</p>
        <p class="act-meta">${metaParts.join(' · ')}</p>
      </div>
      <span class="tag">${tagLabel}</span>
      <button class="del" data-del="${a.id}">&times;</button>
    </div>
  `;
}

function suggestionRowHtml(a, slot) {
  return `
    <div class="activity suggestion-row">
      <div class="act-body">
        <p class="act-name">${a.name}</p>
        <p class="act-meta">Suggested: ${formatDayLabel(slot.date)} · ${slot.start_time}–${slot.end_time}</p>
      </div>
      <div class="suggestion-actions">
        <button class="btn-accept" data-accept="${a.id}" data-date="${slot.date}" data-start="${slot.start_time}" data-end="${slot.end_time}">Accept</button>
        <button class="btn-choose" data-choose="${a.id}" data-name="${escapeAttr(a.name)}" data-date="${slot.date}" data-time="${slot.start_time}" data-minutes="${a.allotted_minutes || 15}">Choose a different time</button>
      </div>
      <button class="del" data-del="${a.id}">&times;</button>
    </div>
  `;
}

function unscheduledRowHtml(a, defaultDate) {
  return `
    <div class="activity suggestion-row">
      <div class="act-body">
        <p class="act-name">${a.name}</p>
        <p class="act-meta">No free slot found this period</p>
      </div>
      <div class="suggestion-actions">
        <button class="btn-choose" data-choose="${a.id}" data-name="${escapeAttr(a.name)}" data-date="${defaultDate}" data-time="" data-minutes="${a.allotted_minutes || 15}">Choose a time</button>
      </div>
      <button class="del" data-del="${a.id}">&times;</button>
    </div>
  `;
}

function wirePeriodRowHandlers(reload) {
  document.querySelectorAll('[data-check]').forEach(el => {
    el.addEventListener('click', async () => {
      const nowDone = !el.classList.contains('done');
      await fetch('/api/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ activity_id: el.dataset.check, date: el.dataset.date, done: nowDone })
      });
      reload();
      refreshStreak();
    });
  });
  document.querySelectorAll('[data-accept]').forEach(el => {
    el.addEventListener('click', async () => {
      await fetch('/api/schedule/accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ activity_id: Number(el.dataset.accept), date: el.dataset.date, start_time: el.dataset.start, end_time: el.dataset.end })
      });
      reload();
    });
  });
  document.querySelectorAll('[data-choose]').forEach(el => {
    el.addEventListener('click', () => openChooseTime(el.dataset, reload));
  });
  document.querySelectorAll('[data-del]').forEach(el => {
    el.addEventListener('click', async () => {
      await fetch(`/api/activities/${el.dataset.del}`, { method: 'DELETE' });
      reload();
    });
  });
}

function wireEditAndDelete(reload) {
  document.querySelectorAll('[data-edit]').forEach(el => {
    el.addEventListener('click', () => {
      editingActivityId = el.dataset.edit;
      document.getElementById('editTimeName').textContent = el.dataset.name;
      document.getElementById('editTimeInput').value = el.dataset.time;
      document.getElementById('editTimeBackdrop').classList.add('open');
    });
  });
  document.querySelectorAll('[data-del]').forEach(el => {
    el.addEventListener('click', async () => {
      await fetch(`/api/activities/${el.dataset.del}`, { method: 'DELETE' });
      reload();
    });
  });
}

// ---- Choose-a-time modal (accept a suggestion with an override, or schedule an unscheduled task) ----
function openChooseTime(data, reload) {
  chooseTimeCtx = { activityId: Number(data.choose), minutes: Number(data.minutes) || 15, reload };
  document.getElementById('chooseTimeName').textContent = data.name;
  document.getElementById('chooseTimeDate').value = data.date || '';
  document.getElementById('chooseTimeInput').value = data.time || '';
  document.getElementById('chooseTimeBackdrop').classList.add('open');
}

document.getElementById('chooseTimeCancelBtn').addEventListener('click', () => {
  document.getElementById('chooseTimeBackdrop').classList.remove('open');
  chooseTimeCtx = null;
});

document.getElementById('chooseTimeSaveBtn').addEventListener('click', async () => {
  if (!chooseTimeCtx) return;
  const date = document.getElementById('chooseTimeDate').value;
  const start = document.getElementById('chooseTimeInput').value;
  if (!date || !start) return;
  const end = addMinutesToTime(start, chooseTimeCtx.minutes);
  await fetch('/api/schedule/accept', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ activity_id: chooseTimeCtx.activityId, date, start_time: start, end_time: end, manual: true })
  });
  document.getElementById('chooseTimeBackdrop').classList.remove('open');
  const reload = chooseTimeCtx.reload;
  chooseTimeCtx = null;
  reload();
});

// ---- Add-activity modal ----
const backdrop = document.getElementById('modalBackdrop');
document.getElementById('addBtn').addEventListener('click', () => {
  document.getElementById('newTier').value = currentTier;
  backdrop.classList.add('open');
});
document.getElementById('cancelBtn').addEventListener('click', () => backdrop.classList.remove('open'));
document.getElementById('saveBtn').addEventListener('click', async () => {
  const name = document.getElementById('newName').value.trim();
  if (!name) return;
  const tier = document.getElementById('newTier').value;
  const allotted_minutes = parseInt(document.getElementById('newMinutes').value) || 0;
  await fetch('/api/activities', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, tier, allotted_minutes })
  });
  document.getElementById('newName').value = '';
  document.getElementById('newMinutes').value = '';
  backdrop.classList.remove('open');
  if (tier === currentTier) renderCurrentTier();
});

// ---- Edit reminder time modal (Daily only) ----
const editTimeBackdrop = document.getElementById('editTimeBackdrop');
document.getElementById('editTimeCancelBtn').addEventListener('click', () => {
  editTimeBackdrop.classList.remove('open');
  editingActivityId = null;
});
document.getElementById('editTimeSaveBtn').addEventListener('click', async () => {
  const newTime = document.getElementById('editTimeInput').value;
  if (!editingActivityId || !newTime) return;
  await fetch(`/api/activities/${editingActivityId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reminder_time: newTime })
  });
  editTimeBackdrop.classList.remove('open');
  editingActivityId = null;
  loadDaily(selectedDate);
});

// ---- Google Calendar connect banner (top-level, all tabs) ----
function refreshConnectBanner(status) {
  document.getElementById('connectBanner').style.display = status.connected ? 'none' : 'flex';
}
document.getElementById('connectBtn').addEventListener('click', () => {
  window.location.href = '/auth/google';
});

// ---- Analytics modal ----
document.getElementById('analyticsBtn').addEventListener('click', async () => {
  await loadAnalyticsModal();
  document.getElementById('analyticsBackdrop').classList.add('open');
});
document.getElementById('analyticsCloseBtn').addEventListener('click', () => {
  document.getElementById('analyticsBackdrop').classList.remove('open');
});

async function refreshStreak() {
  const a = await fetch('/api/analytics').then(r => r.json());
  document.getElementById('streakBadge').textContent = `${a.streak}-day streak`;
}

async function loadAnalyticsModal() {
  const [a, h] = await Promise.all([
    fetch('/api/analytics').then(r => r.json()),
    fetch('/api/history').then(r => r.json())
  ]);

  document.getElementById('streakBadge').textContent = `${a.streak}-day streak`;
  renderBreakdown(a);
  setBar('Daily', a.daily);
  setBar('Weekly', a.weekly);
  setBar('Monthly', a.monthly);

  const weekBars = document.getElementById('weekBars');
  const dayLabels = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
  weekBars.innerHTML = a.trend.map((t, i) => {
    const pct = t.total ? Math.round((t.done / t.total) * 100) : 0;
    return `
      <div class="wbar-col">
        <div class="wbar"><div class="wbar-fill" style="height:${pct}%"></div></div>
        <span class="wbar-label">${dayLabels[i]}</span>
      </div>
    `;
  }).join('');

  document.getElementById('historyDailyList').innerHTML = h.daily.map(d => `
    <div class="history-day-row">
      <span class="history-day-date">${d.label}</span>
      <span class="history-day-stat ${d.done === d.total && d.total > 0 ? 'full' : ''}">${d.done}/${d.total} done</span>
    </div>
  `).join('') || '<div class="empty">No history yet.</div>';

  document.getElementById('historyWeeklyList').innerHTML = h.weekly.map(w => `
    <div class="history-row-item">
      <span class="history-day-date">${w.label}</span>
      <span class="history-day-stat ${w.done === w.total && w.total > 0 ? 'full' : ''}">${w.done}/${w.total} completed</span>
    </div>
  `).join('') || '<div class="empty">No history yet.</div>';

  document.getElementById('historyMonthlyList').innerHTML = h.monthly.map(m => `
    <div class="history-row-item">
      <span class="history-day-date">${m.label}</span>
      <span class="history-day-stat ${m.done === m.total && m.total > 0 ? 'full' : ''}">${m.done}/${m.total} completed</span>
    </div>
  `).join('') || '<div class="empty">No history yet.</div>';
}

function renderBreakdown(a) {
  const rows = [
    { label: 'Daily', done: a.daily.done, remaining: a.daily.total - a.daily.done },
    { label: 'Weekly', done: a.weekly.done, remaining: a.weekly.total - a.weekly.done, planned: a.weekly.planned, unplanned: a.weekly.unplanned },
    { label: 'Monthly', done: a.monthly.done, remaining: a.monthly.total - a.monthly.done, planned: a.monthly.planned, unplanned: a.monthly.unplanned },
  ];
  document.getElementById('breakdownGrid').innerHTML = rows.map(r => `
    <div class="breakdown-card">
      <p class="breakdown-title">${r.label}</p>
      <p class="breakdown-stat"><span>${r.done}</span> done</p>
      <p class="breakdown-stat"><span>${r.remaining}</span> remaining</p>
      ${r.planned !== undefined ? `
        <p class="breakdown-stat sub"><span>${r.planned}</span> planned</p>
        <p class="breakdown-stat sub"><span>${r.unplanned}</span> unplanned</p>
      ` : ''}
    </div>
  `).join('');
}

function setBar(label, stats) {
  const pct = stats.total ? Math.round((stats.done / stats.total) * 100) : 0;
  document.getElementById(`fill${label}`).style.width = `${pct}%`;
  document.getElementById(`val${label}`).textContent =
    `${stats.done}/${stats.total} · ${stats.totalActual}m/${stats.totalAllotted}m`;
}

document.getElementById('reportMonth').value = new Date().toISOString().slice(0, 7);
document.getElementById('downloadReportBtn').addEventListener('click', () => {
  const month = document.getElementById('reportMonth').value;
  window.open(`/api/report/monthly?month=${month}`, '_blank');
});

// ---- Settings modal ----
const settingsBackdrop = document.getElementById('settingsBackdrop');
document.getElementById('settingsBtn').addEventListener('click', async () => {
  const [s, status] = await Promise.all([
    fetch('/api/settings').then(r => r.json()),
    fetch('/api/calendar/status').then(r => r.json())
  ]);
  document.getElementById('setWeekly1').value = s.weekly_time_1 || '';
  document.getElementById('setWeekly2').value = s.weekly_time_2 || '';
  document.getElementById('setMonthly1').value = s.monthly_time_1 || '';
  document.getElementById('setMonthly2').value = s.monthly_time_2 || '';
  document.getElementById('setEod').value = s.eod_time || '';
  document.getElementById('setWeekPlanning').value = s.week_planning_time || '';
  document.getElementById('setMonthPlanning').value = s.month_planning_time || '';
  document.getElementById('setWorkStart').value = s.work_start || '';
  document.getElementById('setWorkEnd').value = s.work_end || '';
  document.getElementById('setWorkDays').value = s.work_days || '';

  document.getElementById('settingsCalStatus').style.display = status.connected ? 'flex' : 'none';
  document.getElementById('settingsCalEmail').textContent = status.connected ? `Connected: ${status.email}` : '';

  settingsBackdrop.classList.add('open');
});

document.getElementById('disconnectBtn').addEventListener('click', async () => {
  await fetch('/api/calendar/disconnect', { method: 'POST' });
  document.getElementById('settingsCalStatus').style.display = 'none';
  refreshConnectBanner({ connected: false });
  if (currentTier === 'daily') loadDaily(selectedDate);
});
document.getElementById('settingsCancelBtn').addEventListener('click', () => {
  settingsBackdrop.classList.remove('open');
});
document.getElementById('settingsSaveBtn').addEventListener('click', async () => {
  const payload = {
    weekly_time_1: document.getElementById('setWeekly1').value,
    weekly_time_2: document.getElementById('setWeekly2').value,
    monthly_time_1: document.getElementById('setMonthly1').value,
    monthly_time_2: document.getElementById('setMonthly2').value,
    eod_time: document.getElementById('setEod').value,
    week_planning_time: document.getElementById('setWeekPlanning').value,
    month_planning_time: document.getElementById('setMonthPlanning').value,
    work_start: document.getElementById('setWorkStart').value,
    work_end: document.getElementById('setWorkEnd').value,
    work_days: document.getElementById('setWorkDays').value,
  };
  await fetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  settingsBackdrop.classList.remove('open');
});

// ---- Push notifications ----
const VAPID_PUBLIC_KEY = 'BFg-HGhCoNz_FRRg3HJck-NX7fPuThp2DqP5nQG4qKj8PUXteX8xAVBnEJeeWTVPXVCWzEslEneh28HoBf_ksNs';

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map(c => c.charCodeAt(0)));
}

async function initPush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;

  let refreshed = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (refreshed) return;
    refreshed = true;
    window.location.reload();
  });

  const reg = await navigator.serviceWorker.register('/sw.js');
  reg.update();
  const existing = await reg.pushManager.getSubscription();

  if (existing) return;

  if (Notification.permission === 'default') {
    document.getElementById('notifyBanner').style.display = 'flex';
  } else if (Notification.permission === 'granted') {
    subscribe(reg);
  }
}

async function subscribe(reg) {
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
  });
  await fetch('/api/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(sub)
  });
  document.getElementById('notifyBanner').style.display = 'none';
}

document.getElementById('notifyBtn').addEventListener('click', async () => {
  const permission = await Notification.requestPermission();
  if (permission === 'granted') {
    const reg = await navigator.serviceWorker.ready;
    subscribe(reg);
  } else {
    document.getElementById('notifyBanner').style.display = 'none';
  }
});

// ---- Init ----
initPush();
renderCurrentTier();
refreshStreak();
