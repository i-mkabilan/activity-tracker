// Pure scheduling engine: fits pending activities into free gaps around calendar
// events for a week. No Express/DB/Google imports — server.js wires this up.

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function pad(n) { return String(n).padStart(2, '0'); }

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}
function toHHMM(mins) {
  const h = Math.floor(mins / 60), m = mins % 60;
  return `${pad(h)}:${pad(m)}`;
}

// Calendar-date-only helpers, deliberately UTC-anchored so they never shift
// across a DST/timezone boundary — these represent a plain YYYY-MM-DD, not an instant.
function parseDateStr(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
function formatDateStr(d) {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
function addDays(s, n) {
  const d = parseDateStr(s);
  d.setUTCDate(d.getUTCDate() + n);
  return formatDateStr(d);
}
function weekdayName(s) { return DAY_NAMES[parseDateStr(s).getUTCDay()]; }
function dayOfMonth(s) { return String(parseDateStr(s).getUTCDate()); }
function monthKeyOf(s) { return s.slice(0, 7); }
function daysInMonth(monthKey) {
  const [y, m] = monthKey.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

// Converts an event's ISO datetime into Asia/Kolkata local {dateStr, minutes}.
function localParts(isoOrDateStr) {
  const d = new Date(isoOrDateStr);
  const local = new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  return {
    dateStr: `${local.getFullYear()}-${pad(local.getMonth() + 1)}-${pad(local.getDate())}`,
    minutes: local.getHours() * 60 + local.getMinutes(),
  };
}

// Merges a flat list of {start,end,allDay} calendar events into busy
// [{start,end}] minute-ranges (0-1440) for a single YYYY-MM-DD day.
function mergeBusyBlocks(events, dateStr) {
  const blocks = [];
  for (const e of events || []) {
    if (e.allDay) continue;
    const s = localParts(e.start);
    const en = localParts(e.end);
    if (dateStr < s.dateStr || dateStr > en.dateStr) continue;
    const start = dateStr === s.dateStr ? s.minutes : 0;
    const end = dateStr === en.dateStr ? en.minutes : 1440;
    if (end > start) blocks.push({ start, end });
  }
  blocks.sort((a, b) => a.start - b.start);
  const merged = [];
  for (const b of blocks) {
    const last = merged[merged.length - 1];
    if (last && b.start <= last.end) last.end = Math.max(last.end, b.end);
    else merged.push({ ...b });
  }
  return merged;
}

// Free [{start,end}] gaps within [dayStart,dayEnd] after removing busy blocks.
function freeGaps(busyBlocks, dayStart, dayEnd) {
  const gaps = [];
  let cursor = dayStart;
  for (const b of busyBlocks) {
    const bStart = Math.max(b.start, dayStart);
    const bEnd = Math.min(b.end, dayEnd);
    if (bStart >= dayEnd) break;
    if (bStart > cursor) gaps.push({ start: cursor, end: bStart });
    cursor = Math.max(cursor, bEnd);
  }
  if (cursor < dayEnd) gaps.push({ start: cursor, end: dayEnd });
  return gaps.filter(g => g.end > g.start);
}

// Earliest gap (in order) that fits `duration` minutes, optionally requiring
// the gap to start before `startBeforeMin`. Returns {index,start,end} or null.
function fitInGaps(gaps, duration, startBeforeMin) {
  for (let i = 0; i < gaps.length; i++) {
    const g = gaps[i];
    if (startBeforeMin != null && g.start >= startBeforeMin) continue;
    if (g.end - g.start >= duration) return { index: i, start: g.start, end: g.start + duration };
  }
  return null;
}

// Removes the used portion [gapStart,usedEnd) from gaps[index], splicing it out if empty.
function consumeGap(gaps, index, usedEnd) {
  const next = gaps.slice();
  const g = next[index];
  const remainder = { start: usedEnd, end: g.end };
  if (remainder.end > remainder.start) next[index] = remainder;
  else next.splice(index, 1);
  return next;
}

function buildWeekPlan({ activities, completions, calendarEvents, weekStart, today, settings }) {
  const workStart = toMinutes(settings.work_start || '09:00');
  const workEnd = toMinutes(settings.work_end || '18:00');
  const midpoint = toMinutes(settings.work_midpoint || '13:00');
  const workDays = (settings.work_days || 'Mon,Tue,Wed,Thu,Fri').split(',').map(s => s.trim());

  const weekDates = [];
  for (let i = 0; i < 7; i++) {
    const ds = addDays(weekStart, i);
    if (workDays.includes(weekdayName(ds)) && ds >= today) weekDates.push(ds);
  }

  const doneSet = new Set(completions.filter(c => c.done).map(c => `${c.activity_id}|${c.date}`));
  const isCompletedOn = (id, date) => doneSet.has(`${id}|${date}`);
  const isCompletedInRange = (id, from, to) =>
    completions.some(c => c.done && c.activity_id === id && c.date >= from && c.date <= to);

  const dayGaps = {};
  for (const ds of weekDates) {
    const busy = mergeBusyBlocks(calendarEvents, ds);
    for (const a of activities) {
      if (a.tier === 'daily' || !a.fixed_day || !a.reminder_time) continue;
      const matches = a.tier === 'weekly' ? a.fixed_day === weekdayName(ds) : a.fixed_day === dayOfMonth(ds);
      if (!matches) continue;
      const start = toMinutes(a.reminder_time);
      busy.push({ start, end: start + (a.allotted_minutes || 30) });
    }
    busy.sort((x, y) => x.start - y.start);
    const merged = [];
    for (const b of busy) {
      const last = merged[merged.length - 1];
      if (last && b.start <= last.end) last.end = Math.max(last.end, b.end);
      else merged.push({ ...b });
    }
    dayGaps[ds] = freeGaps(merged, workStart, workEnd);
  }

  const placed = [];
  const unscheduled = [];

  function place(activity, dates) {
    const duration = activity.allotted_minutes || 15;
    for (const ds of dates) {
      const gaps = dayGaps[ds];
      if (!gaps) continue;
      let hit = activity.tier === 'daily' ? fitInGaps(gaps, duration, midpoint) : null;
      if (!hit) hit = fitInGaps(gaps, duration, null);
      if (hit) {
        dayGaps[ds] = consumeGap(gaps, hit.index, hit.end);
        placed.push({ activity_id: activity.id, date: ds, start_time: toHHMM(hit.start), end_time: toHHMM(hit.end), source: 'auto' });
        return true;
      }
    }
    return false;
  }

  // Pass 1: daily activities recur every work day, morning-first.
  const dailyActs = activities.filter(a => a.tier === 'daily');
  for (const ds of weekDates) {
    for (const a of dailyActs) {
      if (isCompletedOn(a.id, ds)) continue;
      if (!place(a, [ds])) unscheduled.push({ activity_id: a.id, date: ds });
    }
  }

  // Pass 2: weekly activities without a fixed day, spread across this week's days.
  const weeklyFlex = activities.filter(a => a.tier === 'weekly' && !(a.fixed_day && a.reminder_time));
  if (weekDates.length) {
    const weekEnd = weekDates[weekDates.length - 1];
    const weeklyPending = weeklyFlex.filter(a => !isCompletedInRange(a.id, weekStart, weekEnd));
    weeklyPending.forEach((a, i) => {
      const startIdx = i % weekDates.length;
      const rotation = weekDates.slice(startIdx).concat(weekDates.slice(0, startIdx));
      if (!place(a, rotation)) unscheduled.push({ activity_id: a.id });
    });
  }

  // Pass 3: monthly activities without a fixed day, spread across the month, sliced to this week.
  const monthKey = monthKeyOf(weekStart);
  const totalDays = daysInMonth(monthKey);
  const monthWorkDays = [];
  for (let d = 1; d <= totalDays; d++) {
    const ds = `${monthKey}-${pad(d)}`;
    if (workDays.includes(weekdayName(ds)) && ds >= today) monthWorkDays.push(ds);
  }
  const monthlyFlex = activities.filter(a => a.tier === 'monthly' && !(a.fixed_day && a.reminder_time));
  const monthStart = `${monthKey}-01`;
  const monthEnd = `${monthKey}-${pad(totalDays)}`;
  const monthlyPending = monthlyFlex.filter(a => !isCompletedInRange(a.id, monthStart, monthEnd));
  if (monthWorkDays.length && monthlyPending.length) {
    monthlyPending.forEach((a, i) => {
      const idx = Math.floor((i * monthWorkDays.length) / monthlyPending.length);
      const assignedDate = monthWorkDays[idx];
      if (!weekDates.includes(assignedDate)) return; // falls in a different week
      if (!place(a, [assignedDate])) unscheduled.push({ activity_id: a.id, date: assignedDate });
    });
  }

  return { placed, unscheduled };
}

module.exports = {
  toMinutes, toHHMM, addDays, weekdayName, dayOfMonth,
  mergeBusyBlocks, freeGaps, fitInGaps, consumeGap, buildWeekPlan,
};
