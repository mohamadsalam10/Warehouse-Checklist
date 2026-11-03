const FC = require('./public/shared.js');
const { esc, cap, stats, issuesOf, otherPhotos, weekNo, weekRangeText, fmtDate, fmtDateTime, managerRows } = FC;

const pl = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const scoreTxt = s => s == null ? 'N/A' : s + '%';
const scoreCol = s => s != null && s < 75 ? '#FE5000' : '#0A0A0A';
const barCol = s => s == null ? '#BDBDBD' : s >= 90 ? '#0A0A0A' : s >= 75 ? '#8A8A8A' : '#FE5000';
const sevStyle = { critical: 'background:#FE5000;color:#FFFFFF', major: 'background:#0A0A0A;color:#FFFFFF', minor: 'background:#E6E6E6;color:#3A3A3A' };

const subjectFor = week => `Weekly facility inspection: week ${weekNo(week)} (${weekRangeText(week)})`;

/* ---------- Email to one manager (Arial, table layout, inline styles for email clients) ---------- */
function buildEmail({ week, rows, manager, appUrl, photoUrl, attachmentNote }) {
  const mine = managerRows(manager, rows);
  const sub = mine.filter(r => r.i && r.i.status === 'submitted');
  const totIssues = sub.reduce((n, r) => n + stats(r.i).fail, 0);
  const totCrit = sub.reduce((n, r) => n + stats(r.i).critical, 0);
  const first = String(manager.name || '').trim().split(/\s+/)[0] || 'there';
  const F = 'font-family:Arial,Helvetica,sans-serif;';
  const td = 'padding:8px 10px;border-bottom:1px solid #E6E6E6;font-size:13px;' + F;

  let html = `<div style="${F}color:#0A0A0A;max-width:640px;margin:0 auto;font-size:14px;line-height:1.5">
  <div style="background:#0A0A0A;border-bottom:3px solid #FE5000;padding:14px 20px;color:#FFFFFF;font-weight:bold;font-size:17px">storage<span style="color:#FE5000">.</span>ae
    <span style="float:right;font-weight:normal;font-size:10px;letter-spacing:2px;color:#BDBDBD;line-height:24px">WEEKLY FACILITY INSPECTION</span></div>
  <div style="padding:20px">
  <p style="margin:0 0 12px">Dear ${esc(first)},</p>
  <p style="margin:0 0 16px">The facility inspection for week ${weekNo(week)} (${weekRangeText(week)}) is complete. ${sub.length} warehouse${sub.length === 1 ? '' : 's'} inspected, ${totIssues} issue${totIssues === 1 ? '' : 's'} found${totCrit ? `, <b>${totCrit} critical</b>` : ''}.</p>
  <table role="presentation" cellspacing="0" cellpadding="0" style="border-collapse:collapse;width:100%;margin:0 0 20px">
    <tr>${['Warehouse', 'Score', 'Issues', 'Critical'].map((h, n) => `<th style="background:#0A0A0A;color:#FFFFFF;font-size:10px;letter-spacing:1px;text-transform:uppercase;padding:8px 10px;text-align:${n ? 'right' : 'left'};${F}">${h}</th>`).join('')}</tr>
    ${mine.map(({ w, i }) => {
      if (!i || i.status !== 'submitted') return `<tr><td style="${td}"><b>${esc(w.name)}</b></td><td colspan="3" style="${td}color:#6B6B6B;text-align:right">Not submitted</td></tr>`;
      const st = stats(i);
      return `<tr><td style="${td}"><b>${esc(w.name)}</b></td><td style="${td}text-align:right;font-weight:bold;color:${scoreCol(st.score)}">${scoreTxt(st.score)}</td><td style="${td}text-align:right">${st.fail}</td><td style="${td}text-align:right">${st.critical}</td></tr>`;
    }).join('')}
  </table>`;

  sub.forEach(({ w, i }) => {
    const st = stats(i), iss = issuesOf(i);
    html += `<h2 style="${F}font-size:17px;margin:22px 0 4px">${esc(w.name)}: ${scoreTxt(st.score)}</h2>
    <p style="margin:0 0 10px;color:#6B6B6B;font-size:12px">Inspected by ${esc(i.submittedByName || 'a supervisor')} on ${fmtDate(i.submittedAt)}. ${st.pass} passed, ${st.fail} failed, ${st.na} not applicable.</p>`;
    if (!iss.length) html += `<p style="margin:0 0 10px"><b>No issues found.</b></p>`;
    iss.forEach(x => {
      html += `<div style="border-top:1px solid #E6E6E6;padding:10px 0">
        <span style="${sevStyle[x.a.sev || 'major']};font-size:10px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;padding:2px 6px">${cap(x.a.sev || 'major')}</span>
        <b>${esc(x.it.text)}</b> <span style="color:#6B6B6B;font-size:12px">${esc(x.sec.title)}</span>
        ${x.a.note ? `<div style="margin-top:4px;color:#2B2B2B">${esc(x.a.note)}</div>` : ''}
        ${(x.a.photos || []).length ? `<div style="margin-top:6px">${x.a.photos.map(p => `<a href="${photoUrl(p)}"><img src="${photoUrl(p)}" width="120" height="120" alt="Photo: ${esc(x.it.text)}" style="width:120px;height:120px;object-fit:cover;border:1px solid #E6E6E6;margin:0 6px 6px 0"></a>`).join('')}</div>` : ''}
      </div>`;
    });
  });

  html += `<p style="margin:24px 0 0">${attachmentNote ? 'The full report with all photos is attached.' : 'Photos above link to full size.'}${appUrl ? ` You can also <a href="${esc(appUrl)}/#reports/${week}" style="color:#004FE5">open the report in Facility Check</a>.` : ''}</p>
  <p style="margin:16px 0 0">Thanks,<br>Facility Check</p>
  </div>
  <div style="border-top:1px solid #E6E6E6;padding:12px 20px;color:#767676;font-size:11px">storage.ae | Operations | Internal use only. Sent automatically by Facility Check.</div>
  </div>`;

  // Plain-text alternative
  const lines = [`Dear ${first},`, '', `The facility inspection for week ${weekNo(week)} (${weekRangeText(week)}) is complete. ${pl(sub.length, 'warehouse')} inspected, ${pl(totIssues, 'issue')} found${totCrit ? `, ${totCrit} critical` : ''}.`, ''];
  mine.forEach(({ w, i }) => {
    if (!i || i.status !== 'submitted') { lines.push(`${w.name}: not submitted`, ''); return; }
    const st = stats(i);
    lines.push(`${w.name}: score ${scoreTxt(st.score)}, ${pl(st.fail, 'issue')}${st.critical ? ` (${st.critical} critical)` : ''}`);
    issuesOf(i).forEach(x => lines.push(`  - [${cap(x.a.sev || 'major')}] ${x.it.text}${x.a.note ? ': ' + x.a.note : ''}`));
    lines.push('');
  });
  lines.push(attachmentNote ? 'The full report with all photos is attached.' : '', appUrl ? `Open the report: ${appUrl}/#reports/${week}` : '', '', 'Thanks,', 'Facility Check');

  return { subject: subjectFor(week), html, text: lines.join('\n'), hasRows: mine.length > 0 };
}

/* ---------- Downloadable / attached report (storage.ae internal report chrome) ---------- */
function buildReportFile({ week, rows, photoData }) {
  const img = (id, alt) => photoData[id] ? `<img src="${photoData[id]}" alt="${esc(alt)}" class="ph">` : '';
  const sub = rows.filter(r => r.i && r.i.status === 'submitted');
  const all = sub.map(r => stats(r.i));
  const avg = all.filter(x => x.score != null);
  const avgScore = avg.length ? Math.round(avg.reduce((n, x) => n + x.score, 0) / avg.length) : null;
  const totIssues = all.reduce((n, x) => n + x.fail, 0), totCrit = all.reduce((n, x) => n + x.critical, 0);
  let body = `<div class="hdr"><div class="logo"><i></i><span>storage<b>.</b>ae</span></div><div class="lbl">Weekly facility inspection / Operations</div></div>
  <div class="wrap">
    <span class="lab">Week ${weekNo(week)} | ${weekRangeText(week)}</span>
    <h1>${sub.length} of ${rows.length} warehouses inspected${avgScore != null ? `, average score <span class="o">${avgScore}%</span>` : ''}.</h1>
    <p class="lead">${totIssues} issue${totIssues === 1 ? '' : 's'} found${totCrit ? `, ${totCrit} critical` : ''}. Generated ${fmtDateTime(Date.now())}.</p>
    <div class="stats">
      <div><span class="lab">Inspected</span><b>${sub.length}/${rows.length}</b></div>
      <div><span class="lab">Issues</span><b>${totIssues}</b></div>
      <div><span class="lab">Critical</span><b>${totCrit}</b></div>
      <div class="key"><span class="lab">Average score</span><b>${scoreTxt(avgScore)}</b></div>
    </div>
    <p class="note">Note: score = points passed ÷ (points passed + points failed). N/A points are excluded.</p>
    <div class="sh"><span class="lab">Section 01</span><h2>Results by warehouse</h2></div>
    <table class="tb"><tr><th>Warehouse</th><th class="r">Score</th><th class="r">Passed</th><th class="r">Issues</th><th class="r">Critical</th><th>Inspected by</th></tr>` +
    rows.map(({ w, i }) => {
      if (!i || i.status !== 'submitted') return `<tr><td><b>${esc(w.name)}</b></td><td colspan="5" class="m">${i ? 'In progress' : 'Not submitted'}</td></tr>`;
      const st = stats(i);
      return `<tr><td><b>${esc(w.name)}</b></td><td class="r"><b style="color:${scoreCol(st.score)}">${scoreTxt(st.score)}</b></td><td class="r">${st.pass}</td><td class="r">${st.fail}</td><td class="r">${st.critical}</td><td>${esc(i.submittedByName || '')}, ${fmtDate(i.submittedAt)}</td></tr>`;
    }).join('') + '</table>';
  sub.forEach(({ w, i }, n) => {
    const st = stats(i), iss = issuesOf(i), others = otherPhotos(i);
    body += `<div class="wh"><div class="sh"><span class="lab">Section ${String(n + 2).padStart(2, '0')}</span><h2>${esc(w.name)} <span style="float:right;color:${scoreCol(st.score)}">${scoreTxt(st.score)}</span></h2></div>
      <p class="m">${st.pass} passed, ${st.fail} failed, ${st.na} not applicable. Inspected by ${esc(i.submittedByName || '')} on ${fmtDate(i.submittedAt)}.</p>
      <table class="bars">${st.bySec.map(s => `<tr><td class="bl">${esc(s.title)}</td><td><div class="tr"><div style="width:${s.score || 0}%;background:${barCol(s.score)}"></div></div></td><td class="r bv">${scoreTxt(s.score)}</td></tr>`).join('')}</table>
      <h3>Issues found (${iss.length})</h3>
      ${iss.length ? iss.map(x => `<div class="iss"><span class="tag" style="${sevStyle[x.a.sev || 'major']}">${cap(x.a.sev || 'major')}</span> <b>${esc(x.it.text)}</b> <span class="m sm">${esc(x.sec.title)}</span>${x.a.note ? `<div class="nt">${esc(x.a.note)}</div>` : ''}<div>${(x.a.photos || []).map(p => img(p, x.it.text)).join('')}</div></div>`).join('') : '<p><b>No issues found.</b></p>'}
      ${others.length ? `<h3>Other photos</h3><div>${others.map(o => `<figure>${img(o.id, o.it.text)}<figcaption>${esc(o.it.text)}</figcaption></figure>`).join('')}</div>` : ''}
    </div>`;
  });
  body += `</div><div class="foot"><span>storage.ae | Operations</span><span>Internal use only</span><span>Formerly 800 Storage</span></div>`;
  const css = `*{box-sizing:border-box}b,strong{font-weight:700}body{margin:0;font-family:'Poppins',Arial,Helvetica,sans-serif;color:#0A0A0A;background:#FFFFFF;line-height:1.5;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .hdr{background:#0A0A0A;border-bottom:4px solid #FE5000;display:flex;align-items:center;justify-content:space-between;padding:18px 40px;gap:16px;flex-wrap:wrap}
  .logo{display:flex;align-items:center;gap:8px;font-weight:700;color:#FFFFFF;font-size:19px;letter-spacing:-.01em}.logo i{width:20px;height:20px;border-radius:5px;background:#FE5000;display:block}.logo b{color:#FE5000}
  .hdr .lbl{font-weight:500;font-size:10px;color:#9A9A9A;letter-spacing:.24em;text-transform:uppercase}
  .wrap{max-width:860px;margin:0 auto;padding:36px 40px 24px}.lab{display:block;font-weight:700;font-size:10px;color:#FE5000;letter-spacing:.24em;text-transform:uppercase}
  h1{font-size:30px;line-height:1.15;letter-spacing:-.02em;margin:10px 0 8px}.o{color:#FE5000}.lead{color:#444444;margin:0 0 22px}
  .stats{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}.stats div{background:#F5F5F3;padding:14px 16px}.stats b{display:block;font-size:26px;letter-spacing:-.02em;margin-top:4px}
  .stats .key{background:#FE5000}.stats .key .lab,.stats .key b{color:#FFFFFF}.note{font-size:11px;color:#6B6B6B;margin:8px 0 0}
  .sh{margin:34px 0 10px}.sh .lab::before{content:"";display:inline-block;width:20px;height:2px;background:#FE5000;vertical-align:middle;margin-right:10px}.sh h2{font-size:22px;letter-spacing:-.02em;margin:6px 0 0}
  .tb{border-collapse:collapse;width:100%;font-size:13px}.tb th{background:#0A0A0A;color:#FFFFFF;font-size:9px;letter-spacing:.14em;text-transform:uppercase;text-align:left;padding:10px;border-bottom:2px solid #FE5000}.tb td{padding:10px;border-bottom:1px solid #E6E6E6}.r{text-align:right!important}
  .m{color:#6B6B6B}.sm{font-size:12px}.wh{page-break-inside:avoid}.wh .m{margin:0 0 12px}
  .bars{border-collapse:collapse;width:100%;font-size:13px}.bars td{padding:4px 0}.bl{width:40%;padding-right:12px!important}.bv{width:56px}.tr{background:#EEEEEE;height:9px}.tr div{height:9px}
  h3{font-size:16px;margin:20px 0 8px}.iss{border-top:1px solid #E6E6E6;padding:10px 0}.tag{font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;padding:2px 7px;border-radius:4px}
  .nt{margin-top:4px;color:#2B2B2B}.ph{width:160px;height:160px;object-fit:cover;border-radius:6px;margin:8px 8px 0 0;border:1px solid #E6E6E6}
  figure{display:inline-block;margin:0 8px 8px 0;vertical-align:top;width:160px}figure .ph{margin:0}figcaption{font-size:11px;color:#6B6B6B}
  .foot{max-width:860px;margin:0 auto;padding:12px 40px 32px;border-top:1px solid #E6E6E6;display:flex;justify-content:space-between;font-size:10px;color:#767676;gap:12px;flex-wrap:wrap}
  @media (max-width:600px){.stats{grid-template-columns:repeat(2,1fr)}.wrap,.hdr,.foot{padding-left:18px;padding-right:18px}}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>storage.ae | Facility inspection, week ${weekNo(week)}</title><link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;700&display=swap" rel="stylesheet"><style>${css}</style></head><body>${body}</body></html>`;
}

module.exports = { buildEmail, buildReportFile, subjectFor };
