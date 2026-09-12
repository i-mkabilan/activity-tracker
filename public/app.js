let currentTier = 'daily';
let editingActivityId = null;
const todayStr = new Date().toISOString().slice(0, 10);

document.getElementById('todayLabel').textContent = new Date().toLocaleDateString(undefined, {
  weekday: 'long', month: 'short', day: 'numeric'
});

document.querySelectorAll('.tier-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tier-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentTier = btn.dataset.tier;
    document.getElementById('tierLabel').textContent =
      currentTier === 'daily' ? "Today's routine" :
      currentTier === 'weekly' ? "This week" : "This month";
    document.getElementById('tierHint').textContent =
      currentTier === 'daily' ? '' : 'Notification times for this tier are set in ⚙ Settings, not per activity.';
    loadActivities();
  });
});

async function loadActivities() {
  const [acts, completions] = await Promise.all([
    fetch(`/api/activities?tier=${currentTier}`).then(r => r.json()),
    fetch(`/api/completions?from=2000-01-01&to=2100-01-01`).then(r => r.json())
  ]);

  const compByAct = {};
  completions.forEach(c => { compByAct[c.activity_id] = compByAct[c.activity_id] || {}; compByAct[c.activity_id][c.date] = c; });

  const list = document.getElementById('activityList');
  list.innerHTML = '';

  if (acts.length === 0) {
    list.innerHTML = '<div class="empty">Nothing here yet. Add your first activity below.</div>';
  }

  let doneCount = 0;
  acts.forEach(a => {
    const doneToday = !!(compByAct[a.id]?.[todayStr]?.done);
    if (doneToday) doneCount++;

    const row = document.createElement('div');
    row.className = 'activity';
    const metaParts = [];
    if (a.time_of_day) metaParts.push(a.time_of_day);
    if (a.reminder_time) metaParts.push(a.reminder_time);
    if (a.allotted_minutes) metaParts.push(`${a.allotted_minutes} min`);

    row.innerHTML = `
      <div class="check ${doneToday ? 'done' : ''}" data-id="${a.id}">
        <svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
      </div>
      <div class="act-body">
        <p class="act-name ${doneToday ? 'done' : ''}">${a.name}</p>
        <p class="act-meta">${metaParts.join(' · ')}</p>
      </div>
      ${a.fixed_day ? `<span class="tag">${a.fixed_day}</span>` : ''}
      ${a.tier === 'daily' ? `<button class="edit-time" data-edit="${a.id}" data-name="${a.name.replace(/"/g, '&quot;')}" data-time="${a.reminder_time || ''}" title="Edit reminder time">⏰</button>` : ''}
      <button class="del" data-del="${a.id}">&times;</button>
    `;
    list.appendChild(row);
  });

  document.getElementById('tierCount').textContent = `${doneCount} / ${acts.length} done`;

  list.querySelectorAll('.check').forEach(el => {
    el.addEventListener('click', async () => {
      const id = el.dataset.id;
      const nowDone = !el.classList.contains('done');
      await fetch('/api/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ activity_id: id, date: todayStr, done: nowDone })
      });
      loadActivities();
      loadAnalytics();
    });
  });

  list.querySelectorAll('[data-edit]').forEach(el => {
    el.addEventListener('click', () => {
      editingActivityId = el.dataset.edit;
      document.getElementById('editTimeName').textContent = el.dataset.name;
      document.getElementById('editTimeInput').value = el.dataset.time;
      document.getElementById('editTimeBackdrop').classList.add('open');
    });
  });

  list.querySelectorAll('[data-del]').forEach(el => {
    el.addEventListener('click', async () => {
      await fetch(`/api/activities/${el.dataset.del}`, { method: 'DELETE' });
      loadActivities();
      loadAnalytics();
    });
  });
}

async function loadAnalytics() {
  const a = await fetch('/api/analytics').then(r => r.json());

  document.getElementById('streakBadge').textContent = `${a.streak}-day streak`;

  setBar('Daily', a.daily);
  setBar('Weekly', a.weekly);
  setBar('Monthly', a.monthly);

  const weekBars = document.getElementById('weekBars');
  weekBars.innerHTML = '';
  const dayLabels = ['M','T','W','T','F','S','S'];
  a.trend.forEach((t, i) => {
    const pct = t.total ? Math.round((t.done / t.total) * 100) : 0;
    const col = document.createElement('div');
    col.className = 'wbar-col';
    col.innerHTML = `
      <div class="wbar"><div class="wbar-fill" style="height:${pct}%"></div></div>
      <span class="wbar-label">${dayLabels[i]}</span>
    `;
    weekBars.appendChild(col);
  });
}

function setBar(label, stats) {
  const key = label.toLowerCase();
  const pct = stats.total ? Math.round((stats.done / stats.total) * 100) : 0;
  document.getElementById(`fill${label}`).style.width = `${pct}%`;
  document.getElementById(`val${label}`).textContent =
    `${stats.done}/${stats.total} · ${stats.totalActual}m/${stats.totalAllotted}m`;
}

// Add-activity modal
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
  if (tier === currentTier) loadActivities();
  loadAnalytics();
});

loadActivities();
loadAnalytics();

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

  const reg = await navigator.serviceWorker.register('/sw.js');
  const existing = await reg.pushManager.getSubscription();

  if (existing) return; // already subscribed

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

initPush();

// ---- Edit reminder time modal ----
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
  loadActivities();
});

// ---- Settings modal ----
const settingsBackdrop = document.getElementById('settingsBackdrop');

document.getElementById('settingsBtn').addEventListener('click', async () => {
  const s = await fetch('/api/settings').then(r => r.json());
  document.getElementById('setWeekly1').value = s.weekly_time_1 || '';
  document.getElementById('setWeekly2').value = s.weekly_time_2 || '';
  document.getElementById('setMonthly1').value = s.monthly_time_1 || '';
  document.getElementById('setMonthly2').value = s.monthly_time_2 || '';
  document.getElementById('setEod').value = s.eod_time || '';
  settingsBackdrop.classList.add('open');
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
  };
  await fetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  settingsBackdrop.classList.remove('open');
});
