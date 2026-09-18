// Pure scheduling engine: suggests calendar-aware time slots for flexible
// weekly/monthly activities. No Express/DB/Google imports — server.js wires this up.

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

// The last date in `monthKey` (YYYY-MM) whose weekday is `weekdayIndex` (0=Sun..6=Sat).
function lastWeekdayOfMonth(monthKey, weekdayIndex) {
  const total = daysInMonth(monthKey);
  for (let d = total; d >= 1; d--) {
    const ds = `${monthKey}-${pad(d)}`;
    if (parseDateStr(ds).getUTCDay() === weekdayIndex) return ds;
  }
  return null;
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

// Earliest gap (in order) that fits `duration` minutes. Returns {index,start,end} or null.
function fitInGaps(gaps, duration) {
  for (let i = 0; i < gaps.length; i++) {
    const g = gaps[i];
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

function workWindow(settings) {
  return {
    workStart: toMinutes(settings.work_start || '09:00'),
    workEnd: toMinutes(settings.work_end || '18:00'),
    workDays: (settings.work_days || 'Mon,Tue,Wed,Thu,Fri').split(',').map(s => s.trim()),
  };
}

// Seeds one day's busy blocks from calendar events + every activity with a
// reminder_time that applies to that date (daily every day; weekly/monthly
// fixed-day activities on their matching date; already-accepted slots).
function seedDayBusy(dateStr, calendarEvents, activities, acceptedByDate) {
  const busy = mergeBusyBlocks(calendarEvents, dateStr);
  for (const a of activities) {
    if (!a.reminder_time) continue;
    let matches = false;
    if (a.tier === 'daily') matches = true;
    else if (a.fixed_day) matches = a.tier === 'weekly' ? a.fixed_day === weekdayName(dateStr) : a.fixed_day === dayOfMonth(dateStr);
    if (!matches) continue;
    const start = toMinutes(a.reminder_time);
    busy.push({ start, end: start + (a.allotted_minutes || 15) });
  }
  for (const s of (acceptedByDate[dateStr] || [])) {
    busy.push({ start: toMinutes(s.start_time), end: toMinutes(s.end_time) });
  }
  busy.sort((x, y) => x.start - y.start);
  const merged = [];
  for (const b of busy) {
    const last = merged[merged.length - 1];
    if (last && b.start <= last.end) last.end = Math.max(last.end, b.end);
    else merged.push({ ...b });
  }
  return merged;
}

function isCompletedInRange(completions, id, from, to) {
  return completions.some(c => c.done && c.activity_id === id && c.date >= from && c.date <= to);
}

// Suggests slots for weekly-tier activities without a fixed_day, spread across
// this week's work days, avoiding calendar events / fixed activities / already-accepted slots.
function buildWeeklySuggestions({ activities, completions, calendarEvents, alreadyAccepted, weekStart, today, settings }) {
  const { workStart, workEnd, workDays } = workWindow(settings);

  const weekDates = [];
  for (let i = 0; i < 7; i++) {
    const ds = addDays(weekStart, i);
    if (workDays.includes(weekdayName(ds)) && ds >= today) weekDates.push(ds);
  }

  const acceptedByDate = {};
  for (const s of alreadyAccepted || []) (acceptedByDate[s.date] = acceptedByDate[s.date] || []).push(s);

  const dayGaps = {};
  for (const ds of weekDates) dayGaps[ds] = freeGaps(seedDayBusy(ds, calendarEvents, activities, acceptedByDate), workStart, workEnd);

  const placed = [];
  const unscheduled = [];
  function place(activity, dates) {
    const duration = activity.allotted_minutes || 15;
    for (const ds of dates) {
      const gaps = dayGaps[ds];
      if (!gaps) continue;
      const hit = fitInGaps(gaps, duration);
      if (hit) {
        dayGaps[ds] = consumeGap(gaps, hit.index, hit.end);
        placed.push({ activity_id: activity.id, date: ds, start_time: toHHMM(hit.start), end_time: toHHMM(hit.end) });
        return true;
      }
    }
    return false;
  }

  if (weekDates.length) {
    const weekEnd = weekDates[weekDates.length - 1];
    const acceptedIds = new Set((alreadyAccepted || []).map(s => s.activity_id));
    const flexible = activities.filter(a => a.tier === 'weekly' && !a.fixed_day && !acceptedIds.has(a.id));
    const pending = flexible.filter(a => !isCompletedInRange(completions, a.id, weekStart, weekEnd));
    pending.forEach((a, i) => {
      const startIdx = i % weekDates.length;
      const rotation = weekDates.slice(startIdx).concat(weekDates.slice(0, startIdx));
      if (!place(a, rotation)) unscheduled.push({ activity_id: a.id });
    });
  }

  return { placed, unscheduled };
}

// Suggests slots for monthly-tier activities without a fixed_day, spread across
// the whole month's work days.
function buildMonthlySuggestions({ activities, completions, calendarEvents, alreadyAccepted, monthKey, today, settings }) {
  const { workStart, workEnd, workDays } = workWindow(settings);

  const total = daysInMonth(monthKey);
  const monthDates = [];
  for (let d = 1; d <= total; d++) {
    const ds = `${monthKey}-${pad(d)}`;
    if (workDays.includes(weekdayName(ds)) && ds >= today) monthDates.push(ds);
  }

  const acceptedByDate = {};
  for (const s of alreadyAccepted || []) (acceptedByDate[s.date] = acceptedByDate[s.date] || []).push(s);

  const dayGaps = {};
  for (const ds of monthDates) dayGaps[ds] = freeGaps(seedDayBusy(ds, calendarEvents, activities, acceptedByDate), workStart, workEnd);

  const placed = [];
  const unscheduled = [];
  function place(activity, dates) {
    const duration = activity.allotted_minutes || 15;
    for (const ds of dates) {
      const gaps = dayGaps[ds];
      if (!gaps) continue;
      const hit = fitInGaps(gaps, duration);
      if (hit) {
        dayGaps[ds] = consumeGap(gaps, hit.index, hit.end);
        placed.push({ activity_id: activity.id, date: ds, start_time: toHHMM(hit.start), end_time: toHHMM(hit.end) });
        return true;
      }
    }
    return false;
  }

  if (monthDates.length) {
    const monthStart = `${monthKey}-01`;
    const monthEnd = `${monthKey}-${pad(total)}`;
    const acceptedIds = new Set((alreadyAccepted || []).map(s => s.activity_id));
    const flexible = activities.filter(a => a.tier === 'monthly' && !a.fixed_day && !acceptedIds.has(a.id));
    const pending = flexible.filter(a => !isCompletedInRange(completions, a.id, monthStart, monthEnd));
    pending.forEach((a, i) => {
      const startIdx = i % monthDates.length;
      const rotation = monthDates.slice(startIdx).concat(monthDates.slice(0, startIdx));
      if (!place(a, rotation)) unscheduled.push({ activity_id: a.id });
    });
  }

  return { placed, unscheduled };
}

module.exports = {
  toMinutes, toHHMM, addDays, weekdayName, dayOfMonth, monthKeyOf, daysInMonth, lastWeekdayOfMonth,
  mergeBusyBlocks, freeGaps, fitInGaps, consumeGap,
  buildWeeklySuggestions, buildMonthlySuggestions,
};
