const PDFDocument = require('pdfkit');

function daysInMonth(year, monthIndex) {
  return new Date(year, monthIndex + 1, 0).getDate();
}

// Assigns each date of the month to a display week (1-4, folding any 5th week into week 4)
// and a weekday column (Mon-Fri only; weekends are skipped in the grid, matching the original template).
function buildCalendarMap(year, monthIndex) {
  const total = daysInMonth(year, monthIndex);
  const map = {}; // dateStr -> { week, col } col: 0=Mon..4=Fri
  const firstDow = new Date(year, monthIndex, 1).getDay(); // 0=Sun..6=Sat
  const firstMonOffset = (firstDow === 0 ? 6 : firstDow - 1); // days since that week's Monday

  for (let day = 1; day <= total; day++) {
    const dow = new Date(year, monthIndex, day).getDay();
    if (dow === 0 || dow === 6) continue; // skip weekends
    const col = dow - 1; // Mon=0 .. Fri=4
    let week = Math.ceil((day + firstMonOffset) / 7);
    if (week > 4) week = 4; // fold any partial 5th week into week 4
    const dateStr = `${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    map[dateStr] = { week, col };
  }
  return map;
}

function generateMonthlyReport(res, { monthStr, activities, completions }) {
  const [year, monthNum] = monthStr.split('-').map(Number);
  const monthIndex = monthNum - 1;
  const monthName = new Date(year, monthIndex, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  const calMap = buildCalendarMap(year, monthIndex);

  // completions: array of {activity_id, date, done}. Build lookup.
  const doneSet = new Set(completions.filter(c => c.done).map(c => `${c.activity_id}|${c.date}`));

  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 28 });
  doc.pipe(res);

  const pageW = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const dayCol = 15.5;
  const nameColW = 190;
  const timeColW = 42;
  const weekGap = 4;
  const weekW = dayCol * 5;

  doc.font('Helvetica-Bold').fontSize(16).fillColor('#1e2621')
    .text('Leadership Standard Work', doc.page.margins.left, doc.page.margins.top, { continued: false });
  doc.font('Helvetica').fontSize(10).fillColor('#5c655d')
    .text(`Monthly Report — ${monthName}`, doc.page.margins.left, doc.page.margins.top + 20);

  let y = doc.page.margins.top + 46;

  function drawColumnHeaders() {
    const headerY = y;
    doc.font('Helvetica-Bold').fontSize(7).fillColor('#1e2621');
    doc.text('Activity', doc.page.margins.left + 4, headerY + 6, { width: nameColW - 8 });
    doc.text('Time', doc.page.margins.left + nameColW, headerY + 6, { width: timeColW - 4, align: 'center' });

    let wx = doc.page.margins.left + nameColW + timeColW;
    for (let w = 1; w <= 4; w++) {
      doc.font('Helvetica-Bold').fontSize(6.5).text(`WEEK ${w}`, wx, headerY, { width: weekW, align: 'center' });
      const days = ['M', 'T', 'W', 'T', 'F'];
      days.forEach((d, i) => {
        doc.font('Helvetica').fontSize(6.5).fillColor('#5c655d')
          .text(d, wx + i * dayCol, headerY + 9, { width: dayCol, align: 'center' });
      });
      wx += weekW + weekGap;
    }
    y += 20;
    doc.moveTo(doc.page.margins.left, y).lineTo(doc.page.margins.left + pageW, y).strokeColor('#dde2d7').lineWidth(0.5).stroke();
  }

  function drawSectionHeader(label) {
    doc.rect(doc.page.margins.left, y, pageW, 18).fill('#1e2621');
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor('#edf0ea')
      .text(label, doc.page.margins.left + 6, y + 4.5);
    y += 18;
    drawColumnHeaders();
  }

  function drawActivityRow(a) {
    const rowH = 16;
    if (y + rowH > doc.page.height - doc.page.margins.bottom - 20) {
      doc.addPage();
      y = doc.page.margins.top;
      drawColumnHeaders();
    }
    doc.font('Helvetica').fontSize(7.5).fillColor('#1e2621')
      .text(a.name, doc.page.margins.left + 4, y + 4, { width: nameColW - 8, height: rowH, ellipsis: true });
    doc.font('Helvetica').fontSize(7).fillColor('#5c655d')
      .text(a.reminder_time || (a.allotted_minutes ? `${a.allotted_minutes}m` : ''), doc.page.margins.left + nameColW, y + 4.5, { width: timeColW - 4, align: 'center' });

    let wx = doc.page.margins.left + nameColW + timeColW;
    for (let w = 1; w <= 4; w++) {
      for (let col = 0; col < 5; col++) {
        // find a date in this week/col that matches, and check completion
        const match = Object.entries(calMap).find(([, v]) => v.week === w && v.col === col);
        let mark = '';
        if (match) {
          const [dateStr] = match;
          if (doneSet.has(`${a.id}|${dateStr}`)) mark = 'P';
        }
        doc.rect(wx + col * dayCol, y, dayCol, rowH).strokeColor('#dde2d7').lineWidth(0.4).stroke();
        if (mark) {
          doc.font('Helvetica-Bold').fontSize(7).fillColor('#3f6b53')
            .text(mark, wx + col * dayCol, y + 4, { width: dayCol, align: 'center' });
        }
      }
      wx += weekW + weekGap;
    }
    y += rowH;
  }

  const tiers = [
    { key: 'daily', label: 'DAILY ACTIVITIES' },
    { key: 'weekly', label: 'WEEKLY ACTIVITIES' },
    { key: 'monthly', label: 'MONTHLY ACTIVITIES' },
  ];

  tiers.forEach(({ key, label }, idx) => {
    const acts = activities.filter(a => a.tier === key);
    if (!acts.length) return;
    if (idx > 0) y += 14;
    drawSectionHeader(label);
    acts.forEach(drawActivityRow);
  });

  // Summary footer
  y += 18;
  if (y > doc.page.height - doc.page.margins.bottom - 40) { doc.addPage(); y = doc.page.margins.top; }
  const totalActs = activities.length;
  const totalDone = completions.filter(c => c.done).length;
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#1e2621')
    .text(`Total activities tracked: ${totalActs}    |    Total completions logged this month: ${totalDone}`, doc.page.margins.left, y);

  doc.end();
}

module.exports = { generateMonthlyReport };
