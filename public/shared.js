/* Shared between the browser and the Node server. No dependencies. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FC = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const STANDARD = [
    ['Security and access', [
      'Perimeter fence, walls and gates intact with no gaps or damage',
      'All doors, roller shutters and windows lock properly',
      'CCTV cameras working, clean and recording (check playback)',
      'Intruder alarm armed, tested and free of faults',
      'Visitor and contractor log complete for the week',
      'Key register up to date and all keys accounted for',
      'Security lighting working around the building and yard',
      'Guard patrol records signed and on schedule']],
    ['Fire and life safety', [
      'Fire extinguishers in place, charged and inspection tags in date',
      'Emergency exits unlocked from inside, clear, with signs lit',
      'Fire alarm panel normal, with no faults or isolations',
      'Sprinkler heads unobstructed with clearance below',
      'Emergency lighting working',
      'Fire hose reels and hydrants accessible',
      'Evacuation plan and assembly point signs posted',
      'First aid kits complete and in date']],
    ['Health and safety', [
      'PPE available and worn (safety shoes, hi-vis vests, gloves)',
      'Forklift and MHE pre-use checks recorded',
      'MHE operators hold valid licences',
      'Pedestrian walkways marked, clear and respected',
      'No trip hazards: cables, stretch wrap, loose pallets or spills',
      'Ladders and step platforms in good condition',
      'Hazardous materials stored, segregated and labelled, with SDS available',
      'Spill kits stocked and accessible',
      'Battery charging area ventilated, with eyewash available']],
    ['Racking and building', [
      'Racking free of damage (bent uprights, beams, missing locks)',
      'Rack load signs displayed and loads within limits',
      'Pallets stored squarely with no overhang or leaning stacks',
      'Floor free of cracks, potholes or worn markings',
      'Roof, walls and skylights free of leaks',
      'Dock doors, levellers and bumpers working',
      'Lighting working throughout storage areas']],
    ['Cleanliness and hygiene', [
      'Floors swept and aisles free of debris',
      'Waste bins emptied, with waste and recycling segregated',
      'Washrooms clean and stocked',
      'Break rooms and rest areas clean',
      'No signs of pests; bait stations checked and logged',
      'Drains and gutters clear',
      'Loading docks and yard clean']],
    ['Organisation (5S)', [
      'Every rack location labelled and readable',
      'Stock stored in its assigned location',
      'No unlabelled or unidentified items',
      'Receiving and dispatch staging areas clear',
      'Damaged and returned goods quarantined and labelled',
      'Empty pallets stacked in the designated area',
      'Tools and equipment returned to their place',
      'Office and workstations tidy']],
    ['Inventory and records', [
      'Weekly cycle counts completed',
      'Receiving and dispatch paperwork filed',
      'FIFO / FEFO followed, with no expired stock in pick faces',
      'Temperature and humidity logs complete (where applicable)']],
    ['Utilities and equipment', [
      'Electrical panels closed, labelled and with clear access',
      'HVAC and ventilation working',
      'Generator and UPS tested (where applicable)',
      'No water leaks found']]
  ];

  const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
  const standardSections = () => STANDARD.map(([t, items]) => ({ id: uid(), title: t, items: items.map(x => ({ id: uid(), text: x })) }));
  const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ISO weeks, e.g. "2026-W45" */
  function isoWeek(date) {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const day = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - day);
    const y = d.getUTCFullYear();
    const w = Math.ceil(((d - Date.UTC(y, 0, 1)) / 864e5 + 1) / 7);
    return y + '-W' + String(w).padStart(2, '0');
  }
  function weekStart(key) {
    const [y, w] = key.split('-W').map(Number);
    const jan4 = new Date(Date.UTC(y, 0, 4));
    const day = jan4.getUTCDay() || 7;
    const mon = new Date(jan4);
    mon.setUTCDate(jan4.getUTCDate() - day + 1 + (w - 1) * 7);
    return mon;
  }
  function shiftWeek(key, n) {
    const m = weekStart(key); m.setUTCDate(m.getUTCDate() + 7 * n + 3);
    return isoWeek(new Date(m.getUTCFullYear(), m.getUTCMonth(), m.getUTCDate()));
  }
  const isWeekKey = k => typeof k === 'string' && /^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$/.test(k);
  const weekNo = key => +key.split('-W')[1];
  function weekRangeText(key) {
    const s = weekStart(key), e = new Date(s); e.setUTCDate(s.getUTCDate() + 6);
    const f = (d, o) => d.toLocaleDateString('en-GB', Object.assign({ timeZone: 'UTC' }, o));
    if (s.getUTCFullYear() !== e.getUTCFullYear()) return f(s, { day: 'numeric', month: 'long', year: 'numeric' }) + ' to ' + f(e, { day: 'numeric', month: 'long', year: 'numeric' });
    if (s.getUTCMonth() !== e.getUTCMonth()) return f(s, { day: 'numeric', month: 'long' }) + ' to ' + f(e, { day: 'numeric', month: 'long', year: 'numeric' });
    return f(s, { day: 'numeric' }) + ' to ' + f(e, { day: 'numeric', month: 'long', year: 'numeric' });
  }
  const TZ = 'Asia/Dubai';
  const fmtDate = ts => ts ? new Date(ts).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: TZ }) : '';
  const fmtDateTime = ts => ts ? fmtDate(ts) + ', ' + new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: TZ }) : '';

  /* Scoring */
  function stats(insp) {
    const r = { total: 0, pass: 0, fail: 0, na: 0, answered: 0, critical: 0, major: 0, minor: 0, noteMissing: 0, score: null, photos: 0, bySec: [] };
    (insp.sections || []).forEach(sec => {
      const s = { title: sec.title, pass: 0, fail: 0, na: 0, total: sec.items.length, answered: 0 };
      sec.items.forEach(it => {
        r.total++;
        const a = (insp.answers || {})[it.id];
        if (a && a.photos) r.photos += a.photos.length;
        if (!a || !a.s) return;
        r.answered++; s.answered++; r[a.s]++; s[a.s]++;
        if (a.s === 'fail') { r[a.sev || 'major']++; if (!(a.note || '').trim()) r.noteMissing++; }
      });
      s.score = s.pass + s.fail ? Math.round(s.pass / (s.pass + s.fail) * 100) : null;
      r.bySec.push(s);
    });
    r.score = r.pass + r.fail ? Math.round(r.pass / (r.pass + r.fail) * 100) : null;
    return r;
  }
  function issuesOf(i) {
    const out = [];
    (i.sections || []).forEach(sec => sec.items.forEach(it => { const a = (i.answers || {})[it.id]; if (a && a.s === 'fail') out.push({ sec, it, a }); }));
    const rank = { critical: 0, major: 1, minor: 2 };
    return out.sort((x, y) => rank[x.a.sev || 'major'] - rank[y.a.sev || 'major']);
  }
  function otherPhotos(i) {
    const out = [];
    (i.sections || []).forEach(sec => sec.items.forEach(it => { const a = (i.answers || {})[it.id]; if (a && a.s !== 'fail' && a.photos) a.photos.forEach(p => out.push({ it, id: p })); }));
    return out;
  }
  /* Rows for a week: active warehouses, plus submitted inspections for warehouses since removed */
  function weekRows(config, inspections) {
    const byWh = {};
    inspections.forEach(i => { byWh[i.warehouseId] = i; });
    const rows = (config.warehouses || []).filter(w => w.active !== false).map(w => ({ w, i: byWh[w.id] || null, active: true }));
    inspections.forEach(i => {
      if (!rows.find(r => r.w.id === i.warehouseId) && i.status === 'submitted')
        rows.push({ w: { id: i.warehouseId, name: i.warehouseName, code: i.warehouseCode }, i, active: false });
    });
    return rows;
  }
  function managerRows(m, rows) { return m.scope === 'all' || !Array.isArray(m.scope) ? rows : rows.filter(r => m.scope.includes(r.w.id)); }

  return { STANDARD, uid, standardSections, cap, esc, isoWeek, weekStart, shiftWeek, isWeekKey, weekNo, weekRangeText, fmtDate, fmtDateTime, stats, issuesOf, otherPhotos, weekRows, managerRows, TZ };
});
