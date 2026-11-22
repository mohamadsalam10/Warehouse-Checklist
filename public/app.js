(function () {
'use strict';
const { esc, cap, uid, stats, issuesOf, otherPhotos, isoWeek, shiftWeek, weekNo, weekRangeText, fmtDate, fmtDateTime, weekRows, managerRows, standardSections, STANDARD } = window.FC;
const main = document.getElementById('main');
const LABEL = { pass: 'Pass', fail: 'Fail', na: 'N/A' };
const SEVS = ['minor', 'major', 'critical'];
const clone = o => JSON.parse(JSON.stringify(o));
// The current week comes from the server (Dubai time), so a phone set to another time zone still sees the right week.
let THIS_WEEK = isoWeek(new Date());
function setThisWeek(w) { if (!w || w === THIS_WEEK) return; if (S.week === THIS_WEEK) S.week = w; THIS_WEEK = w; }

const S = {
  user: null, needsSetup: false, canEdit: false,
  config: null, sender: null, mail: null, users: null,
  week: THIS_WEEK, inspections: {}, weekLoaded: false, report: null, mailConfigured: true,
  tab: 'inspect', draft: null, itemMap: {}, collapsed: {}, expanded: {}, uploading: {},
  editWh: null, armed: null, edOpen: {}, importPreview: null, setupTab: 'warehouses', cl: null, job: null, rec: null, readOnly: false, stale: false, sending: false
};

/* ---------- API ---------- */
async function api(method, url, body) {
  const init = { method, headers: { 'X-FC': '1' }, credentials: 'same-origin' };
  if (body instanceof Blob) { init.body = body; init.headers['Content-Type'] = body.type || 'image/jpeg'; }
  else if (body !== undefined) { init.body = JSON.stringify(body); init.headers['Content-Type'] = 'application/json'; }
  let res;
  try { res = await fetch(url, init); }
  catch (e) { const er = new Error('Can’t reach the server. Check your connection.'); er.status = 0; throw er; }
  let data = null;
  try { data = await res.json(); } catch (e) {}
  if (res.status === 401 && S.user) { S.user = null; S.draft = null; renderAuth(); }
  if (!res.ok) { const er = new Error((data && data.error) || 'Something went wrong.'); er.status = res.status; throw er; }
  return data;
}

/* ---------- Toast, lightbox ---------- */
let toastT;
function toast(msg) { const t = document.getElementById('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 3600); }
const lb = document.getElementById('lightbox');
lb.addEventListener('click', () => { lb.hidden = true; });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !lb.hidden) lb.hidden = true; });
function viewPhoto(id) { lb.querySelector('img').src = '/api/photos/' + id; lb.hidden = false; }

/* ---------- Saving ---------- */
const writers = {};
const saveEl = document.getElementById('saveState');
function setSave(state, msg) {
  saveEl.className = 'save-state' + (state === 'error' ? ' err' : '');
  saveEl.textContent = state === 'saving' ? 'Saving…' : state === 'saved' ? 'Saved' : state === 'error' ? (msg || 'Not saved') : '';
}
function queueSave(key, run, delay) {
  const w = writers[key] || (writers[key] = {});
  w.run = run;
  clearTimeout(w.timer);
  setSave('saving');
  return new Promise(res => { (w.waiters || (w.waiters = [])).push(res); w.timer = setTimeout(() => flush(key), delay == null ? 700 : delay); });
}
async function flush(key) {
  const w = writers[key];
  w.timer = null;
  if (w.running) { w.again = true; return; }
  w.running = true;
  const waiters = w.waiters || []; w.waiters = [];
  let ok = false;
  try { await w.run(); ok = true; setSave('saved'); }
  catch (e) {
    setSave('error', e.status === 0 ? 'Offline' : 'Not saved');
    if (e.status !== 401) toast(e.status === 0 ? 'Couldn’t save. Check your connection; your changes stay on this screen.' : e.message);
  }
  w.running = false;
  waiters.forEach(r => r(ok));
  if (w.again) { w.again = false; flush(key); }
}
const pending = key => { const w = writers[key]; return !!(w && (w.timer || w.running)); };
async function flushAll() { await Promise.all(Object.keys(writers).filter(pending).map(k => new Promise(r => { const w = writers[k]; (w.waiters || (w.waiters = [])).push(r); if (w.timer) { clearTimeout(w.timer); flush(k); } }))); }
const saveConfig = d => queueSave('config', async () => { const r = await api('PUT', '/api/config', S.config); if (!pending('config')) S.config = r.config; }, d);
function saveDraft(d) {
  const dr = S.draft;
  S.inspections[dr.warehouseId] = clone(dr);
  return queueSave('insp:' + dr.week + ':' + dr.warehouseId, async () => {
    const r = await api('PUT', `/api/inspections/${dr.week}/${encodeURIComponent(dr.warehouseId)}`, { answers: dr.answers });
    if (S.draft === dr && JSON.stringify(r.inspection.sections) !== JSON.stringify(dr.sections)) {
      // The server snapshotted a newer checklist when this inspection was created.
      dr.sections = r.inspection.sections; indexItems(); renderChecklist();
    }
  }, d);
}

/* ---------- Helpers ---------- */
const scoreClass = s => s == null ? '' : s >= 90 ? 'good' : s >= 75 ? 'mid' : 'bad';
const activeWh = () => (S.config.warehouses || []).filter(w => w.active !== false);
const rowsForWeek = () => weekRows(S.config, Object.values(S.inspections));
const supervisorsOf = whId => (S.users || []).filter(u => u.role === 'supervisor' && u.active && (u.warehouses || []).includes(whId));

/* ---------- Tabs ---------- */
const isCleanerUser = () => S.user && S.user.role === 'cleaner';
function roleTabs() {
  if (S.canEdit) return [['inspect', 'Inspect'], ['fixes', 'Work orders'], ['reports', 'Reports'], ['cleaning', 'Cleaning'], ['setup', 'Setup'], ['account', 'Account']];
  if (isCleanerUser()) return [['today', 'Today'], ['schedule', 'My schedule']];
  return [['inspect', 'Inspect'], ['fixes', 'Work orders']];
}
const homeTab = () => isCleanerUser() ? 'today' : 'inspect';
function allowedTab(t) { return t === 'account' || roleTabs().some(x => x[0] === t); }
function renderTabs() {
  const el = document.getElementById('tabs');
  if (!S.user) { el.innerHTML = ''; return; }
  const tabs = roleTabs();
  el.innerHTML = tabs.map(([k, l]) => `<button class="tab" data-tab="${k}" ${S.tab === k ? 'aria-current="page"' : ''}>${l}</button>`).join('') +
    (S.canEdit ? '' : `<button class="tab tab-sm" data-tab="account" ${S.tab === 'account' ? 'aria-current="page"' : ''}>${esc(S.user.name.split(' ')[0])} | Account</button>`);
}
document.getElementById('tabs').addEventListener('click', e => { const b = e.target.closest('[data-tab]'); if (b) goTab(b.dataset.tab); });
function goTab(t) {
  if (!allowedTab(t)) t = homeTab();
  if (S.draft) closeDraft();
  if (S.job) closeJob();
  if (S.fix) closeFix();
  S.tab = t; S.armed = null; S.editWh = null;
  history.replaceState(null, '', t === homeTab() ? location.pathname : `#${t}${t === 'reports' && S.week !== THIS_WEEK ? '/' + S.week : ''}`);
  renderTabs(); render(); window.scrollTo(0, 0);
  if (t === 'setup' && S.canEdit) loadUsers();
  if (t === 'cleaning' && S.canEdit) loadRecords().then(() => { if (S.tab === 'cleaning') renderCleaning(); });
  if (t === 'fixes') loadFixes().then(() => { if (S.tab === 'fixes' && !S.fix) renderFixes(); });
  if ((t === 'today' || t === 'schedule') && isCleanerUser()) loadCleaner().then(() => { if (S.tab === t && !S.job) render(); });
}

/* ---------- Auth screens ---------- */
function renderAuth() {
  renderTabs(); setSave('');
  const bar = document.querySelector('.cl-bar'); bar && bar.remove();
  if (S.needsSetup) {
    main.innerHTML = `<div class="auth"><span class="eyebrow dash">First-time setup</span><h1>Create the admin account</h1>
      <p>You’ll use this to add warehouses, managers and supervisors.</p>
      <div class="field"><label for="aName">Your name</label><input type="text" id="aName" autocomplete="name"></div>
      <div class="field"><label for="aEmail">Email</label><input type="email" id="aEmail" autocomplete="email"></div>
      <div class="field"><label for="aPw">Password (8 characters or more)</label><input type="password" id="aPw" autocomplete="new-password" style="width:100%;min-height:40px;border:1px solid var(--line);border-radius:8px;padding:9px 12px;background:var(--surface)"></div>
      <p class="err-text" id="aErr" hidden></p>
      <button class="btn primary" data-dosetup>Create admin account</button></div>`;
  } else {
    main.innerHTML = `<div class="auth"><span class="eyebrow dash">Facility Check</span><h1>Sign in</h1>
      <p>Use the email and password your admin gave you.</p>
      <div class="field"><label for="lEmail">Email</label><input type="email" id="lEmail" autocomplete="username"></div>
      <div class="field"><label for="lPw">Password</label><input type="password" id="lPw" autocomplete="current-password" style="width:100%;min-height:40px;border:1px solid var(--line);border-radius:8px;padding:9px 12px;background:var(--surface)"></div>
      <p class="err-text" id="lErr" hidden></p>
      <button class="btn primary" data-dologin>Sign in</button></div>`;
  }
  const f = main.querySelector('input'); f && f.focus();
}
async function doLogin() {
  const err = document.getElementById('lErr');
  try { const r = await api('POST', '/api/auth/login', { email: document.getElementById('lEmail').value, password: document.getElementById('lPw').value }); await signedIn(r.user); }
  catch (e) { err.hidden = false; err.textContent = e.message; }
}
async function doSetup() {
  const err = document.getElementById('aErr');
  try { const r = await api('POST', '/api/auth/setup', { name: document.getElementById('aName').value, email: document.getElementById('aEmail').value, password: document.getElementById('aPw').value }); S.needsSetup = false; await signedIn(r.user); S.tab = 'setup'; renderTabs(); render(); loadUsers(); }
  catch (e) { err.hidden = false; err.textContent = e.message; }
}
async function signedIn(user) {
  S.user = user; S.canEdit = user.role === 'admin';
  try { const me = await api('GET', '/api/me'); setThisWeek(me.thisWeek); } catch (e) {}
  main.innerHTML = '<div class="loading">Loading…</div>';
  if (!allowedTab(S.tab)) S.tab = homeTab();
  if (user.role === 'cleaner') { renderTabs(); await loadCleaner(); render(); return; }
  await loadConfig();
  renderTabs();
  await loadWeek();
  if (S.tab === 'cleaning') await loadRecords();
  if (S.tab === 'fixes') await loadFixes();
  if (S.canEdit) loadUsers();
  render();
}
async function signOut() {
  await flushAll();
  try { await api('POST', '/api/auth/logout'); } catch (e) {}
  S.user = null; S.draft = null; S.job = null; S.fix = null; S.fx = null; S.cl = null; S.rec = null; S.config = null; S.tab = 'inspect';
  history.replaceState(null, '', location.pathname);
  renderAuth();
}

/* ---------- Loading ---------- */
async function loadConfig() {
  const r = await api('GET', '/api/config');
  S.config = r.config; S.sender = r.sender || null; S.mail = r.mail || null;
}
async function loadWeek() {
  const wk = S.week;
  try {
    const r = await api('GET', '/api/weeks/' + wk);
    if (wk !== S.week) return;
    const m = {};
    r.inspections.forEach(i => { m[i.warehouseId] = i; });
    if (S.draft && S.draft.week === wk) m[S.draft.warehouseId] = clone(S.draft);
    Object.keys(writers).forEach(k => { if (pending(k) && k.startsWith('insp:' + wk + ':')) { const id = k.split(':')[2]; if (S.inspections[id]) m[id] = S.inspections[id]; } });
    S.inspections = m; S.report = r.report; S.mailConfigured = r.mailConfigured; S.weekLoaded = true; S.fixed = r.fixed || []; S.openByWh = r.openByWh || {};
  } catch (e) { S.weekLoaded = true; if (e.status !== 401) toast(e.message); }
}
async function loadUsers() {
  try { const r = await api('GET', '/api/users'); S.users = r.users; if (!S.draft && !setupFocused() && (S.tab === 'setup' || S.tab === 'inspect')) render(); } catch (e) {}
}
const setupFocused = () => main.contains(document.activeElement) && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);

/* ---------- Main render ---------- */
function render() {
  if (!S.user) return renderAuth();
  if (S.draft || S.job || S.fix) return;
  if (!allowedTab(S.tab)) S.tab = homeTab();
  if (S.tab === 'today') return renderToday();
  if (S.tab === 'schedule') return renderSchedule();
  if (S.tab === 'account') return renderAccount();
  if (!S.config) { main.innerHTML = '<div class="loading">Loading…</div>'; return; }
  if (S.tab === 'cleaning') return renderCleaning();
  if (S.tab === 'fixes') return renderFixes();
  if (S.tab === 'setup' && S.canEdit) renderSetup();
  else if (S.tab === 'reports') renderReports();
  else if (S.tab === 'account') renderAccount();
  else renderInspectHome();
}
function weekHeader(sub) {
  const atNow = S.week === THIS_WEEK;
  return `<section class="week" aria-label="Inspection week">
    <div class="week-num"><span class="wk">Week</span><span class="big">${weekNo(S.week)}</span></div>
    <div class="week-info">
      <div class="range">${weekRangeText(S.week)}</div>
      ${sub ? `<div class="week-sub">${sub}</div>` : ''}
      <div class="week-nav">
        <button class="btn ghost sm" data-week="-1">‹ Previous week</button>
        ${atNow ? '' : '<button class="btn ghost sm" data-week="0">This week</button>'}
        <button class="btn ghost sm" data-week="1" ${atNow ? 'disabled' : ''}>Next week ›</button>
      </div>
    </div></section>`;
}

/* ---------- Inspect home ---------- */
function renderInspectHome() {
  const whs = activeWh();
  if (!whs.length && !S.canEdit) {
    main.innerHTML = weekHeader() + `<div class="empty"><h2>No warehouses assigned to you</h2><p>An admin needs to assign your warehouses before you can start the weekly checks.</p></div>`;
    return;
  }
  if (!whs.length) {
    main.innerHTML = weekHeader() + `<div class="empty"><h2>No warehouses yet</h2><p>${S.canEdit ? 'Add your warehouses, managers and supervisors in Setup to start the weekly checks.' : 'An admin needs to add warehouses before inspections can start.'}</p>${S.canEdit ? '<button class="btn primary" data-go="setup">Open Setup</button>' : ''}</div>`;
    return;
  }
  const done = whs.filter(w => S.inspections[w.id] && S.inspections[w.id].status === 'submitted').length;
  let html = weekHeader();
  html += S.weekLoaded ? `<p class="progress-line"><strong>${done} of ${whs.length}</strong> ${S.canEdit ? 'warehouses' : 'of your warehouses'} inspected this week</p>` : `<p class="progress-line">Loading this week’s inspections…</p>`;
  if (!(S.config.sections || []).length) html += `<div class="banner info"><div>The checklist is empty.${S.canEdit ? ' Add checklist points in Setup first.' : ' Ask an admin to set it up.'}</div>${S.canEdit ? '<button class="btn" data-go="setup">Open Setup</button>' : ''}</div>`;
  if (S.weekLoaded && done === whs.length && !S.canEdit) {
    html += `<div class="banner"><div><strong>All your warehouses are inspected for week ${weekNo(S.week)}.</strong> Thank you. The report goes to managers once every warehouse is done.</div></div>`;
  } else if (S.weekLoaded && done === whs.length) {
    const r = S.report;
    const msg = r && (r.status === 'sent' || r.status === 'partial') ? `Report emailed to managers on ${fmtDateTime(r.sentAt)}.` : r && r.status === 'failed' ? 'The report email didn’t go out. Check Reports.' : 'The report is being emailed to managers.';
    html += `<div class="banner ${r && r.status === 'failed' ? 'info' : ''}"><div><strong>All warehouses are inspected for week ${weekNo(S.week)}.</strong> ${msg}</div><button class="btn primary" data-go="reports">View report</button></div>`;
  }
  html += '<ul class="wh-list">' + whs.map(w => {
    const i = S.inspections[w.id]; const st = i ? stats(i) : null;
    let status, cls = '';
    if (!i) status = '<span class="pill">Not started</span>';
    else if (i.status === 'submitted') { cls = 'st-submitted'; status = `<span class="pill ok">Submitted</span><span class="score ${scoreClass(st.score)}">${st.score == null ? '–' : st.score + '%'}</span>`; }
    else { cls = 'st-draft'; status = `<span class="pill prog">In progress, ${st.answered} of ${st.total}</span>`; }
    return `<li><button class="wh ${cls}" data-open="${esc(w.id)}"><span class="wh-name">${esc(w.name)}</span><span class="wh-meta">${esc([w.code, w.location].filter(Boolean).join(', ')) || '&nbsp;'}${(S.openByWh || {})[w.id] ? ` | <span class="warn-t">${S.openByWh[w.id]} open work order${S.openByWh[w.id] === 1 ? '' : 's'}</span>` : ''}${S.canEdit && S.users ? (() => { const sv = supervisorsOf(w.id); return sv.length ? ` | ${esc(sv.map(u => u.name).join(', '))}` : ' | <span class="warn-t">No supervisor assigned</span>'; })() : ''}</span><span class="wh-status">${status}</span></button></li>`;
  }).join('') + '</ul>';
  main.innerHTML = html;
}

/* ---------- Checklist ---------- */
function indexItems() {
  S.itemMap = {}; let no = 0;
  S.draft.sections.forEach(sec => sec.items.forEach(it => { S.itemMap[it.id] = { it, sec, no: ++no }; }));
}
function openInspection(whId) {
  const w = S.config.warehouses.find(x => x.id === whId); if (!w) return;
  const ex = S.inspections[whId];
  if (!ex && !(S.config.sections || []).length) { toast('The checklist is empty. An admin needs to add points in Setup.'); return; }
  S.draft = ex ? clone(ex) : { week: S.week, warehouseId: whId, warehouseName: w.name, warehouseCode: w.code || '', sections: clone(S.config.sections), answers: {}, status: 'draft' };
  if (!S.draft.answers || Array.isArray(S.draft.answers)) S.draft.answers = {};
  indexItems();
  S.expanded = {}; S.collapsed = {};
  renderChecklist(); window.scrollTo(0, 0);
}
function closeDraft() {
  if (S.draft) S.inspections[S.draft.warehouseId] = clone(S.draft);
  S.draft = null; S.itemMap = {};
  const bar = document.querySelector('.cl-bar'); bar && bar.remove();
}
function renderChecklist() {
  const d = S.draft, ro = d.status === 'submitted';
  let html = `<div class="cl-head"><button class="btn ghost sm" data-back>‹ All warehouses</button>
    <div style="margin-top:20px"><span class="eyebrow">Facility inspection | Weekly</span></div><h1>${esc(d.warehouseName)}</h1>
    <div class="cl-sub">Week ${weekNo(d.week)}, ${weekRangeText(d.week)}${d.warehouseCode ? ' | ' + esc(d.warehouseCode) : ''}</div></div>`;
  if (ro) html += `<div class="banner"><div>Submitted ${fmtDateTime(d.submittedAt)} by ${esc(d.submittedByName || 'a supervisor')}.</div><button class="btn" data-reopen>Reopen to edit</button></div>`;
  else html += `<p class="hint">Mark each point Pass, Fail or N/A and add photos wherever they help. Your progress saves as you go.</p><div class="keyline"><span class="eyebrow">Key line</span><span>Every Fail needs a note and a severity before the inspection can be submitted.</span></div>`;
  html += d.sections.map((sec, i) => sectionHTML(sec, ro, i)).join('');
  main.innerHTML = html;
  let bar = document.querySelector('.cl-bar');
  if (!bar) { bar = document.createElement('div'); bar.className = 'cl-bar'; document.body.appendChild(bar); }
  bar.innerHTML = `<div class="cl-bar-in"><div class="bar-progress"><div class="meter"><span id="meter"></span></div><div class="bar-text" id="barText"></div></div>
    ${ro ? '<button class="btn primary" data-back>Done</button>' : '<button class="btn primary" data-submit>Submit inspection</button>'}</div>`;
  updateProgress();
}
function sectionHTML(sec, ro, idx) {
  const open = !S.collapsed[sec.id];
  return `<section class="sec" data-sec="${esc(sec.id)}">
    <button class="sec-head" data-toggle="${esc(sec.id)}" aria-expanded="${open}"><span class="sec-title"><span class="eyebrow dash">Section ${String(idx + 1).padStart(2, '0')}</span><h2>${esc(sec.title)}</h2></span><span class="sec-right"><span class="sec-count" data-count="${esc(sec.id)}"></span><span class="chev" aria-hidden="true">▾</span></span></button>
    <div class="sec-body">${ro ? '' : `<div class="sec-tools"><button class="link-btn" data-allpass="${esc(sec.id)}">Mark remaining as Pass</button></div>`}
    ${itemsWithGroups(sec, ro)}</div></section>`;
}
function itemsWithGroups(sec, ro) {
  let last = null;
  return sec.items.map(it => { const g = it.group || ''; const h = g && g !== last ? `<div class="grp">${esc(g)}</div>` : ''; last = g; return h + itemHTML(it, ro); }).join('');
}
function itemHTML(it, ro) {
  const a = S.draft.answers[it.id] || {};
  const s = a.s, photos = a.photos || [];
  const show = s === 'fail' || (a.note || '').trim() || photos.length || S.expanded[it.id] || S.uploading[it.id];
  let extra = '';
  if (show) {
    extra = `<div class="extra">
      ${s === 'fail' ? `<div class="sev" role="group" aria-label="Severity"><span class="sev-label">Severity</span>${SEVS.map(v => `<button type="button" class="chip ${v}" data-sev="${v}" aria-pressed="${(a.sev || 'major') === v}" ${ro ? 'disabled' : ''}>${cap(v)}</button>`).join('')}</div>` : ''}
      ${s === 'fail' && (it.action || it.category) ? `<p class="fix">${it.action ? `<span class="fix-l">Corrective action</span>${esc(it.action)}` : ''}${it.category ? ` <span class="tag minor">${esc(it.category)}</span>` : ''}</p>` : ''}
      ${ro && !(a.note || '').trim() ? '' : `<textarea data-note rows="2" aria-label="Note for: ${esc(it.text)}" placeholder="${s === 'fail' ? 'What’s wrong and what action is needed? (required)' : 'Note (optional)'}" ${ro ? 'readonly' : ''}>${esc(a.note || '')}</textarea>`}
      <div class="photos">${photos.map(id => `<div class="ph"><img src="/api/photos/${esc(id)}" alt="Photo for ${esc(it.text)}" loading="lazy" data-view="${esc(id)}">${ro ? '' : `<button class="ph-x" data-rmphoto="${esc(id)}" aria-label="Remove photo">×</button>`}</div>`).join('')}
      ${S.uploading[it.id] ? `<div class="ph up">Uploading…</div>` : ''}
      ${!ro ? `<label class="ph add"><input class="vh" type="file" accept="image/*" multiple data-photo aria-label="Add photo"><span>+ Photo</span></label>` : ''}</div>
    </div>`;
  }
  const no = (S.itemMap[it.id] || {}).no;
  return `<div class="item ${s ? 'is-' + s : ''}" data-item="${esc(it.id)}">
    <div class="item-row"><span class="item-no">${no ? String(no).padStart(2, '0') : ''}</span><p class="item-text">${esc(it.text)}</p>
      <div class="seg" role="group" aria-label="Result for: ${esc(it.text)}">${['pass', 'fail', 'na'].map(v => `<button type="button" class="seg-b ${v}" data-set="${v}" aria-pressed="${s === v}" ${ro ? 'disabled' : ''}>${LABEL[v]}</button>`).join('')}</div>
    </div>${extra || (ro ? '' : '<button class="link-btn" data-expand>Add note or photo</button>')}</div>`;
}
function rerenderItem(id, focusSel) {
  const el = main.querySelector(`[data-item="${CSS.escape(id)}"]`); if (!el) return;
  const ref = S.itemMap[id]; if (!ref) return;
  const tmp = document.createElement('div'); tmp.innerHTML = itemHTML(ref.it, S.draft.status === 'submitted');
  const nu = tmp.firstElementChild; el.replaceWith(nu);
  if (focusSel) { const f = nu.querySelector(focusSel); f && f.focus(); }
}
function updateProgress() {
  if (!S.draft) return;
  const st = stats(S.draft);
  const m = document.getElementById('meter'); if (m) m.style.width = (st.total ? st.answered / st.total * 100 : 0) + '%';
  const t = document.getElementById('barText');
  if (t) t.textContent = `${st.answered} of ${st.total} checked${st.fail ? `, ${st.fail} issue${st.fail > 1 ? 's' : ''}` : ''}` + (st.score != null ? `, score ${st.score}%` : '');
  st.bySec.forEach((s, i) => {
    const sec = S.draft.sections[i]; const el = main.querySelector(`[data-count="${CSS.escape(sec.id)}"]`);
    if (el) el.innerHTML = `${s.answered}/${s.total}` + (s.fail ? ` <span class="issues-n">${s.fail} failed</span>` : '');
  });
}
function setAnswer(id, v) {
  const a = S.draft.answers[id] || (S.draft.answers[id] = {});
  a.s = a.s === v ? null : v;
  if (a.s === 'fail' && !a.sev) a.sev = 'major';
  saveDraft(); rerenderItem(id, a.s === 'fail' && !(a.note || '').trim() ? '[data-note]' : `[data-set="${v}"]`); updateProgress();
}
async function compress(file) {
  try {
    const bmp = await createImageBitmap(file);
    const max = 1600, r = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas'); c.width = Math.round(bmp.width * r); c.height = Math.round(bmp.height * r);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    const b = await new Promise(res => c.toBlob(res, 'image/jpeg', 0.82));
    return b || file;
  } catch (e) { return file; }
}
async function addPhotos(id, files) {
  if (!files.length) return;
  const dr = S.draft;
  S.uploading[id] = (S.uploading[id] || 0) + files.length; rerenderItem(id);
  for (const f of files) {
    try {
      let blob = await compress(f);
      if (!/^image\/(jpeg|png|webp)$/.test(blob.type)) throw Object.assign(new Error('Use a JPG, PNG or WebP photo.'), { status: 415 });
      const r = await api('POST', '/api/photos', blob);
      const a = dr.answers[id] || (dr.answers[id] = {});
      (a.photos || (a.photos = [])).push(r.id);
      if (S.draft === dr) saveDraft();
    } catch (e) { toast(e.status === 415 ? e.message : e.status === 413 ? 'That photo is too large.' : 'Photo didn’t upload. ' + e.message); }
    S.uploading[id]--;
    if (S.draft === dr) rerenderItem(id);
  }
  if (S.uploading[id] <= 0) delete S.uploading[id];
  if (S.draft === dr) rerenderItem(id);
}
async function submitDraft(btn) {
  const d = S.draft, st = stats(d);
  if (st.answered < st.total || st.noteMissing) {
    const parts = [];
    if (st.answered < st.total) parts.push(`${st.total - st.answered} point${st.total - st.answered > 1 ? 's' : ''} still to check`);
    if (st.noteMissing) parts.push(`${st.noteMissing} failed point${st.noteMissing > 1 ? 's need' : ' needs'} a note`);
    toast(parts.join(' and ') + '.');
    for (const sec of d.sections) for (const it of sec.items) {
      const a = d.answers[it.id];
      if (!a || !a.s || (a.s === 'fail' && !(a.note || '').trim())) {
        S.collapsed[sec.id] = false;
        const h = main.querySelector(`[data-toggle="${CSS.escape(sec.id)}"]`); h && h.setAttribute('aria-expanded', 'true');
        const el = main.querySelector(`[data-item="${CSS.escape(it.id)}"]`);
        if (el) { el.classList.add('flag'); el.scrollIntoView({ block: 'center', behavior: 'smooth' }); setTimeout(() => el.classList.remove('flag'), 2500); }
        return;
      }
    }
    return;
  }
  btn.disabled = true; btn.textContent = 'Submitting…';
  await flushAll();
  try {
    const r = await api('POST', `/api/inspections/${d.week}/${encodeURIComponent(d.warehouseId)}/submit`, { answers: d.answers });
    S.inspections[d.warehouseId] = r.inspection;
    S.draft = null; closeDraft();
    toast(r.weekComplete ? 'All warehouses are done. The report is being emailed to managers.' : `${d.warehouseName} submitted`);
    render(); window.scrollTo(0, 0);
    loadWeek().then(() => { if (!S.draft && S.tab === 'inspect') render(); });
    if (r.weekComplete) setTimeout(() => loadWeek().then(() => { if (!S.draft) render(); }), 5000);
  } catch (e) { toast(e.message); btn.disabled = false; btn.textContent = 'Submit inspection'; }
}
async function reopenDraft() {
  const d = S.draft;
  try {
    const r = await api('POST', `/api/inspections/${d.week}/${encodeURIComponent(d.warehouseId)}/reopen`);
    S.draft = Object.assign(clone(r.inspection), { answers: d.answers });
    S.inspections[d.warehouseId] = clone(S.draft);
    renderChecklist();
  } catch (e) { toast(e.message); }
}

/* ---------- Cleaner app: today's work orders and schedule ---------- */
const prettyDate = d => new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const jobTotal = j => (j.sections || []).reduce((n, s) => n + s.items.length, 0);
const jobDone = j => Object.keys(j.checks || {}).length;
function jobState(j, today) {
  if (j.status === 'done') return ['done', 'Done'];
  if (j.startedAt || jobDone(j) || (j.photos || []).length) return j.date < today ? ['late', 'Not finished'] : ['prog', 'In progress'];
  return j.date < today ? ['missed', 'Missed'] : ['todo', 'Not started'];
}
const statePill = ([k, l]) => `<span class="pill ${k === 'done' ? 'ok' : k === 'prog' ? 'prog' : k === 'missed' || k === 'late' ? 'bad' : ''}">${l}</span>`;
async function loadCleaner() {
  try { S.cl = await api('GET', '/api/cleaner/today'); } catch (e) { if (e.status !== 401) toast(e.message); }
}
function dayHeader(date, sub) {
  const d = new Date(date + 'T00:00:00Z');
  return `<section class="week" aria-label="Today"><div class="week-num"><span class="wk">${d.toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' })}</span><span class="big">${d.getUTCDate()}</span></div>
    <div class="week-info"><div class="range">${d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' })}</div>${sub ? `<div class="week-sub">${sub}</div>` : ''}</div></section>`;
}
function renderToday() {
  if (!S.cl) { main.innerHTML = '<div class="loading">Loading…</div>'; return; }
  const jobs = S.cl.jobs, done = jobs.filter(j => j.status === 'done').length;
  let html = dayHeader(S.cl.date, jobs.length ? `${done} of ${jobs.length} work order${jobs.length === 1 ? '' : 's'} done today` : '');
  if (!jobs.length) { main.innerHTML = html + `<div class="empty"><h2>Nothing scheduled today</h2><p>You have no warehouses to clean today.</p></div>` + tomorrowHTML(); return; }
  if (done === jobs.length) html += `<div class="banner"><div><strong>All done for today.</strong> Thank you.</div></div>`;
  html += '<ul class="wh-list">' + jobs.map(j => {
    const st = jobState(j, S.cl.date), tot = jobTotal(j);
    return `<li><button class="wh ${st[0] === 'done' ? 'st-submitted' : st[0] === 'prog' ? 'st-draft' : ''}" data-openjob="${j.id}"><span class="wh-name">${esc(j.warehouseName)}</span><span class="wh-meta">${esc(j.location || '') || '&nbsp;'}</span>
      <span class="wh-status">${statePill(st)}${tot ? `<span class="muted" style="font-size:.875rem">${jobDone(j)}/${tot}</span>` : ''}</span></button></li>`;
  }).join('') + '</ul>';
  main.innerHTML = html + tomorrowHTML();
}
function whByLocation(list) {
  const by = {};
  list.forEach(w => { const l = w.location || ''; (by[l] = by[l] || []).push(w); });
  return Object.keys(by).sort().map(l => `<div class="up-loc">${l ? `<span class="loc-t">${esc(l)}</span>` : ''}<span>${by[l].map(w => esc(w.name)).join(', ')}</span></div>`).join('');
}
function tomorrowHTML() {
  const t = (S.cl.upcoming || [])[1]; if (!t) return '';
  return `<section class="panel tomorrow"><span class="eyebrow dash">Tomorrow</span><h2>${prettyDate(t.date).replace(/ \d{4}$/, '')}</h2>
    ${t.warehouses.length ? `<p class="hint" style="margin-bottom:10px">${t.warehouses.length} warehouse${t.warehouses.length === 1 ? '' : 's'} to clean:</p>${whByLocation(t.warehouses)}` : '<p class="hint" style="margin:0">Nothing scheduled. Day off.</p>'}
    <button class="link-btn" data-tab-go="schedule" style="margin-top:8px">See the next 7 days</button></section>`;
}
function openJob(id) {
  const j = S.cl.jobs.find(x => x.id === +id); if (!j) return;
  S.job = clone(j); renderJob(); window.scrollTo(0, 0);
}
function closeJob() {
  if (S.job) { const i = S.cl.jobs.findIndex(x => x.id === S.job.id); if (i >= 0) S.cl.jobs[i] = clone(S.job); }
  S.job = null; const bar = document.querySelector('.cl-bar'); bar && bar.remove();
}
function renderJob() {
  const j = S.job, ro = j.status === 'done', tot = jobTotal(j);
  let html = `<div class="cl-head"><button class="btn ghost sm" data-backjob>‹ Today’s work orders</button>
    <div style="margin-top:20px"><span class="eyebrow">Cleaning work order</span></div><h1>${esc(j.warehouseName)}</h1>
    <div class="cl-sub">${prettyDate(j.date)}${j.location ? ' | ' + esc(j.location) : ''}</div></div>`;
  if (ro) html += `<div class="banner"><div>Marked done at ${new Date(j.completedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}.</div><button class="btn" data-reopenjob>Reopen</button></div>`;
  else html += `<p class="hint">Tick each point as you finish it. When you’re done, add photos of the cleaned warehouse if you can, then tap Mark as done.</p>`;
  if (!tot) html += `<div class="status-box wait"><strong>No cleaning points are set up yet.</strong><p>You can still add photos and mark this work order as done.</p></div>`;
  html += (j.sections || []).map((sec, si) => {
    const n = sec.items.filter(i => j.checks[i.id]).length;
    let last = null;
    return `<section class="sec"><div class="sec-head" style="cursor:default"><span class="sec-title"><span class="eyebrow dash">Section ${String(si + 1).padStart(2, '0')}</span><h2>${esc(sec.title)}</h2></span><span class="sec-right"><span data-jcount="${esc(sec.id)}">${n}/${sec.items.length}</span></span></div>
      <div class="sec-body">${sec.items.map(it => { const g = it.group || ''; const h = g && g !== last ? `<div class="grp">${esc(g)}</div>` : ''; last = g;
        return h + `<label class="tick ${j.checks[it.id] ? 'on' : ''}"><input type="checkbox" data-tick="${esc(it.id)}" ${j.checks[it.id] ? 'checked' : ''} ${ro ? 'disabled' : ''}><span class="box" aria-hidden="true"></span><span>${esc(it.text)}</span></label>`; }).join('')}</div></section>`;
  }).join('');
  html += `<section class="panel"><span class="eyebrow dash">After cleaning</span><h2>Photos and note</h2>
    <p class="hint">Optional. Photos of the cleaned warehouse help managers review the work.</p>
    <div class="photos">${(j.photos || []).map(p => `<div class="ph"><img src="/api/photos/${esc(p)}" alt="Photo of ${esc(j.warehouseName)} after cleaning" loading="lazy" data-view="${esc(p)}">${ro ? '' : `<button class="ph-x" data-rmjobphoto="${esc(p)}" aria-label="Remove photo">×</button>`}</div>`).join('')}
      ${S.uploading.job ? '<div class="ph up">Uploading…</div>' : ''}${ro ? '' : `<label class="ph add"><input class="vh" type="file" accept="image/*" multiple data-jobphoto aria-label="Add photos"><span>+ Photo</span></label>`}</div>
    ${ro && !j.note ? '' : `<textarea data-jobnote rows="2" style="margin-top:12px" placeholder="Note (optional). If a point couldn’t be done, explain why here." aria-label="Note" ${ro ? 'readonly' : ''}>${esc(j.note || '')}</textarea>`}
  </section>`;
  main.innerHTML = html;
  let bar = document.querySelector('.cl-bar');
  if (!bar) { bar = document.createElement('div'); bar.className = 'cl-bar'; document.body.appendChild(bar); }
  bar.innerHTML = `<div class="cl-bar-in"><div class="bar-progress"><div class="meter"><span id="meter"></span></div><div class="bar-text" id="barText"></div></div>${ro ? '<button class="btn primary" data-backjob>Done</button>' : '<button class="btn primary" data-completejob>Mark as done</button>'}</div>`;
  updateJobProgress();
}
function updateJobProgress() {
  const j = S.job; if (!j) return;
  const tot = jobTotal(j), n = jobDone(j);
  const m = document.getElementById('meter'); if (m) m.style.width = (tot ? n / tot * 100 : 100) + '%';
  const t = document.getElementById('barText'); if (t) t.textContent = tot ? `${n} of ${tot} points done` : 'No points to tick';
  (j.sections || []).forEach(sec => { const el = main.querySelector(`[data-jcount="${CSS.escape(sec.id)}"]`); if (el) el.textContent = `${sec.items.filter(i => j.checks[i.id]).length}/${sec.items.length}`; });
}
function saveJob(d) {
  const j = S.job;
  const i = S.cl.jobs.findIndex(x => x.id === j.id); if (i >= 0) S.cl.jobs[i] = clone(j);
  return queueSave('job:' + j.id, async () => { const r = await api('PUT', '/api/cleaning/jobs/' + j.id, { checks: j.checks, photos: j.photos, note: j.note }); if (S.job && S.job.id === j.id) S.job.startedAt = r.job.startedAt; }, d);
}
async function addJobPhotos(files) {
  const j = S.job; if (!files.length) return;
  S.uploading.job = (S.uploading.job || 0) + files.length; renderJob();
  for (const f of files) {
    try {
      const blob = await compress(f);
      if (!/^image\/(jpeg|png|webp)$/.test(blob.type)) throw new Error('Use a JPG, PNG or WebP photo.');
      const r = await api('POST', '/api/photos', blob);
      j.photos = (j.photos || []).concat(r.id);
      if (S.job === j) saveJob(400);
    } catch (e) { toast('Photo didn’t upload. ' + e.message); }
    S.uploading.job--;
  }
  delete S.uploading.job;
  if (S.job === j) renderJob();
}
async function completeJob(btn) {
  const j = S.job, left = jobTotal(j) - jobDone(j);
  if (left && !String(j.note || '').trim()) {
    toast(`${left} point${left === 1 ? ' isn’t' : 's aren’t'} ticked. Tick ${left === 1 ? 'it' : 'them'}, or add a note explaining why.`);
    const n = main.querySelector('[data-jobnote]'); n && (n.scrollIntoView({ block: 'center', behavior: 'smooth' }), n.focus());
    return;
  }
  btn.disabled = true; btn.textContent = 'Saving…';
  await flushAll();
  try {
    const r = await api('POST', `/api/cleaning/jobs/${j.id}/complete`, { checks: j.checks, photos: j.photos, note: j.note });
    S.job = r.job; closeJob(); toast(`${r.job.warehouseName} done`); render(); window.scrollTo(0, 0);
  } catch (e) { toast(e.message); btn.disabled = false; btn.textContent = 'Mark as done'; }
}
async function reopenJob() {
  try { const r = await api('POST', `/api/cleaning/jobs/${S.job.id}/reopen`); S.job = r.job; renderJob(); } catch (e) { toast(e.message); }
}
function renderSchedule() {
  if (!S.cl) { main.innerHTML = '<div class="loading">Loading…</div>'; return; }
  const up = S.cl.upcoming || [];
  let html = `<span class="eyebrow dash">My schedule</span><h1 class="page-title" style="margin-bottom:8px">Next 7 days</h1>
    <p class="hint">Where you’re cleaning, so you can prepare. Work orders open on the day itself.</p>
    <ul class="up-list">` + up.map((d, i) => `<li class="${i === 0 ? 'is-today' : i === 1 ? 'is-tomorrow' : ''}">
      <div class="up-day"><strong>${new Date(d.date + 'T00:00:00Z').toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' })}</strong>
        <span class="muted">${new Date(d.date + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'long', timeZone: 'UTC' })}</span>
        ${i === 0 ? '<span class="pill prog">Today</span>' : i === 1 ? '<span class="pill">Tomorrow</span>' : ''}</div>
      <div class="up-wh">${d.warehouses.length ? whByLocation(d.warehouses) : '<span class="muted">Day off</span>'}</div></li>`).join('') + '</ul>';
  const cl = S.cl.checklist || [];
  html += `<section class="panel"><span class="eyebrow dash">Cleaning points</span><h2>What to do at each warehouse</h2>
    ${cl.length ? cl.map(sec => `<h4 style="margin:16px 0 6px">${esc(sec.title)}</h4><ul class="plain">${sec.items.map(i => `<li>${esc(i.text)}</li>`).join('')}</ul>`).join('') : '<p class="muted">No cleaning points are set up yet.</p>'}</section>`;
  main.innerHTML = html;
}

/* ---------- Admin: cleaning records ---------- */
const addDaysKey = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
async function loadRecords() {
  const f = S.recF || (S.recF = {});
  try {
    const r = await api('GET', `/api/cleaning/records?${f.from ? 'from=' + f.from + '&' : ''}${f.to ? 'to=' + f.to : ''}`);
    S.rec = r; if (!f.from) f.from = r.from; if (!f.to) f.to = r.to;
  } catch (e) { if (e.status !== 401) toast(e.message); }
}
function renderCleaning() {
  const f = S.recF || (S.recF = {}), R = S.rec;
  let html = `<span class="eyebrow dash">Cleaning</span><h1 class="page-title" style="margin-bottom:16px">Cleaning records</h1>`;
  if (!R) { main.innerHTML = html + '<div class="loading">Loading…</div>'; return; }
  const today = R.today;
  const cleaners = [...new Map(R.jobs.map(j => [j.cleanerId, j.cleanerName])).entries()];
  const whs = [...new Map(R.jobs.map(j => [j.warehouseId, j.warehouseName])).entries()];
  const jobs = R.jobs.filter(j => (!f.cleaner || j.cleanerId === +f.cleaner) && (!f.wh || j.warehouseId === f.wh) && (!f.st || jobState(j, today)[0] === f.st));
  const count = k => jobs.filter(j => jobState(j, today)[0] === k).length;
  const quick = [['Today', today, today], ['Yesterday', addDaysKey(today, -1), addDaysKey(today, -1)], ['Last 7 days', addDaysKey(today, -6), today], ['Last 30 days', addDaysKey(today, -29), today]];
  html += `<div class="filters">
    <div class="send-actions" style="margin:0">${quick.map(([l, a, b]) => `<button class="btn sm ${f.from === a && f.to === b ? 'primary' : ''}" data-recq="${a}|${b}">${l}</button>`).join('')}</div>
    <div class="filter-row">
      <label>From <input type="date" data-recf="from" value="${f.from || ''}" max="${today}"></label>
      <label>To <input type="date" data-recf="to" value="${f.to || ''}" max="${today}"></label>
      <select data-recf="cleaner" aria-label="Cleaner"><option value="">All cleaners</option>${cleaners.map(([id, n]) => `<option value="${id}" ${+f.cleaner === id ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select>
      <select data-recf="wh" aria-label="Warehouse"><option value="">All warehouses</option>${whs.map(([id, n]) => `<option value="${esc(id)}" ${f.wh === id ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select>
      <select data-recf="st" aria-label="Status"><option value="">Any status</option>${[['done', 'Done'], ['prog', 'In progress'], ['todo', 'Not started'], ['late', 'Not finished'], ['missed', 'Missed']].map(([k, l]) => `<option value="${k}" ${f.st === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
    </div></div>`;
  html += `<div class="rec-stats">${[['Done', count('done')], ['In progress', count('prog')], ['Not started', count('todo')], ['Not finished', count('late')], ['Missed', count('missed')]].map(([l, n]) => `<div><span class="lab">${l}</span><b>${n}</b></div>`).join('')}</div>`;
  if (!jobs.length) html += `<div class="empty"><h2>No work orders</h2><p>No cleaning was scheduled for these dates and filters. Work orders come from cleaner schedules in Setup > Cleaning.</p></div>`;
  const byDate = {};
  jobs.forEach(j => (byDate[j.date] = byDate[j.date] || []).push(j));
  Object.keys(byDate).sort().reverse().forEach(d => {
    html += `<h3 class="rec-date">${prettyDate(d)}</h3><ul class="rec-list">` + byDate[d].map(j => {
      const st = jobState(j, today), tot = jobTotal(j), open = S.recOpen === j.id;
      return `<li class="${open ? 'open' : ''}"><button class="rec-row" data-recopen="${j.id}" aria-expanded="${open}">
          <span class="rec-main"><strong>${esc(j.warehouseName)}</strong><span class="muted">${esc([j.location, j.cleanerName].filter(Boolean).join(' | '))}</span></span>
          <span class="rec-side">${statePill(st)}<span class="muted">${tot ? jobDone(j) + '/' + tot : ''}${(j.photos || []).length ? ` | ${j.photos.length} photo${j.photos.length === 1 ? '' : 's'}` : ''}${j.completedAt ? ' | ' + new Date(j.completedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : ''}</span></span></button>
        ${open ? `<div class="rec-detail">
          ${(j.sections || []).map(sec => `<h4>${esc(sec.title)}</h4><ul class="plain ticks">${sec.items.map(i => `<li class="${j.checks[i.id] ? 'y' : 'n'}">${j.checks[i.id] ? '✓' : '✗'} ${esc(i.text)}</li>`).join('')}</ul>`).join('')}
          ${j.note ? `<p class="issue-note"><strong>Note:</strong> ${esc(j.note)}</p>` : ''}
          ${(j.photos || []).length ? `<div class="gallery" style="margin-top:12px">${j.photos.map(p => `<figure><img src="/api/photos/${esc(p)}" alt="Photo of ${esc(j.warehouseName)} after cleaning" loading="lazy" data-view="${esc(p)}"></figure>`).join('')}</div>` : '<p class="muted" style="font-size:.875rem">No photos.</p>'}
          ${j.status === 'done' ? `<button class="btn sm" style="margin-top:12px" data-recreopen="${j.id}">Reopen work order</button>` : ''}
        </div>` : ''}</li>`;
    }).join('') + '</ul>';
  });
  main.innerHTML = html;
}

/* ---------- Work orders from failed points (supervisors and admins) ---------- */
async function loadFixes() {
  const st = S.fxStatus || 'open';
  try { const r = await api('GET', '/api/issues?status=' + st); S.fx = { status: st, list: r.issues }; } catch (e) { if (e.status !== 401) toast(e.message); }
}
const reportedText = f => `Reported week ${weekNo(f.firstWeek)}${f.lastWeek !== f.firstWeek ? `, last failed week ${weekNo(f.lastWeek)}` : ''}${f.timesReported > 1 ? ` (${f.timesReported} times)` : ''}`;
function renderFixes() {
  const st = S.fxStatus || 'open';
  let html = `<span class="eyebrow dash">Work orders</span><h1 class="page-title" style="margin-bottom:8px">Fix failed points</h1>
    <p class="hint">Every point marked Fail on an inspection becomes a work order here. If the same point fails again while its order is open, the existing order is updated, not duplicated. Add a note and “after” photos if you can, then mark it fixed.</p>
    <div class="send-actions"><button class="btn sm ${st === 'open' ? 'primary' : ''}" data-fxstatus="open">Open</button><button class="btn sm ${st === 'fixed' ? 'primary' : ''}" data-fxstatus="fixed">Fixed (last 120 days)</button></div>`;
  if (!S.fx || S.fx.status !== st) { main.innerHTML = html + '<div class="loading">Loading…</div>'; return; }
  const list = S.fx.list;
  if (!list.length) { main.innerHTML = html + `<div class="empty"><h2>${st === 'open' ? 'No open work orders' : 'Nothing fixed yet'}</h2><p>${st === 'open' ? 'Failed inspection points will appear here.' : 'Fixed work orders from the last 120 days appear here.'}</p></div>`; return; }
  const byWh = {};
  list.forEach(f => (byWh[f.warehouseName] = byWh[f.warehouseName] || []).push(f));
  Object.keys(byWh).sort().forEach(wn => {
    html += `<h3 class="rec-date">${esc(wn)} <span class="muted" style="font-weight:500;font-size:.875rem">${byWh[wn].length} ${st === 'open' ? 'open' : 'fixed'}</span></h3><ul class="wh-list">` +
      byWh[wn].map(f => `<li><button class="wh fx-card ${f.status === 'fixed' ? 'st-submitted' : 'sev-' + f.severity}" data-openfx="${f.id}">
        <span class="wh-name" style="font-size:1.05rem">${esc(f.pointText)}</span>
        <span class="wh-meta">${esc([f.sectionTitle, f.group].filter(Boolean).join(' / '))} | ${f.status === 'fixed' ? `Fixed ${fmtDate(f.fixedAt)}${f.fixedByName ? ' by ' + esc(f.fixedByName) : ''}` : reportedText(f)}${f.status === 'open' && f.passedWeek ? ` | <span class="ok-t">Passed in week ${weekNo(f.passedWeek)}</span>` : ''}</span>
        <span class="wh-status">${f.status === 'fixed' ? '<span class="pill ok">Fixed</span>' : `<span class="tag ${f.severity}">${cap(f.severity)}</span>`}${(f.beforePhotos.length + f.afterPhotos.length) ? `<span class="muted" style="font-size:.8125rem">${f.beforePhotos.length + f.afterPhotos.length} photo${f.beforePhotos.length + f.afterPhotos.length === 1 ? '' : 's'}</span>` : ''}</span></button></li>`).join('') + '</ul>';
  });
  main.innerHTML = html;
}
function openFix(id) { const f = S.fx.list.find(x => x.id === +id); if (!f) return; S.fix = clone(f); renderFix(); window.scrollTo(0, 0); }
function closeFix() {
  if (S.fix && S.fx) { const i = S.fx.list.findIndex(x => x.id === S.fix.id); if (i >= 0) S.fx.list[i] = clone(S.fix); }
  S.fix = null; const bar = document.querySelector('.cl-bar'); bar && bar.remove();
}
function renderFix() {
  const f = S.fix, ro = f.status === 'fixed';
  const ph = (list, rm) => list.map(p => `<div class="ph"><img src="/api/photos/${esc(p)}" alt="Photo" loading="lazy" data-view="${esc(p)}">${rm && !ro ? `<button class="ph-x" data-rmfxphoto="${esc(p)}" aria-label="Remove photo">×</button>` : ''}</div>`).join('');
  let html = `<div class="cl-head"><button class="btn ghost sm" data-backfx>‹ Work orders</button>
    <div style="margin-top:20px"><span class="eyebrow">Work order | ${esc(f.warehouseName)}</span></div><h1>${esc(f.pointText)}</h1>
    <div class="cl-sub">${esc([f.sectionTitle, f.group].filter(Boolean).join(' / '))}${f.category ? ' | ' + esc(f.category) : ''}</div></div>`;
  if (ro) html += `<div class="banner"><div>Fixed ${fmtDateTime(f.fixedAt)}${f.fixedByName ? ' by ' + esc(f.fixedByName) : ''}.</div><button class="btn" data-reopenfx>Reopen</button></div>`;
  if (!ro && f.passedWeek) html += `<div class="status-box ok"><strong>This point was marked Pass in the week ${weekNo(f.passedWeek)} inspection.</strong><p>If it’s resolved, mark the work order as fixed.</p></div>`;
  html += `<section class="panel"><span class="eyebrow dash">Before</span><h2>What was found</h2>
    <p class="hint" style="margin-bottom:8px"><span class="tag ${f.severity}">${cap(f.severity)}</span> ${reportedText(f)}.</p>
    ${f.lastNote || f.firstNote ? `<p class="issue-note">${esc(f.lastNote || f.firstNote)}</p>` : ''}
    ${f.firstNote && f.lastNote && f.firstNote !== f.lastNote ? `<p class="issue-note muted" style="font-size:.875rem">First reported: ${esc(f.firstNote)}</p>` : ''}
    ${f.action ? `<p class="fix" style="margin-top:12px"><span class="fix-l">Corrective action</span>${esc(f.action)}</p>` : ''}
    ${f.beforePhotos.length ? `<div class="photos" style="margin-top:12px">${ph(f.beforePhotos, false)}</div>` : '<p class="muted" style="font-size:.875rem;margin:12px 0 0">No photos from the inspection.</p>'}
  </section>
  <section class="panel"><span class="eyebrow dash">After</span><h2>${ro ? 'What was done' : 'Fix it'}</h2>
    ${ro ? '' : '<p class="hint">Optional: describe what was done and add photos of how it looks now.</p>'}
    ${ro && !f.fixNote ? '' : `<textarea data-fxnote rows="3" placeholder="What was done? (optional)" aria-label="What was done" ${ro ? 'readonly' : ''}>${esc(f.fixNote || '')}</textarea>`}
    <div class="photos" style="margin-top:12px">${ph(f.afterPhotos, true)}${S.uploading.fx ? '<div class="ph up">Uploading…</div>' : ''}${ro || f.afterPhotos.length >= 12 ? '' : `<label class="ph add"><input class="vh" type="file" accept="image/*" multiple data-fxphoto aria-label="Add after photos"><span>+ Photo</span></label>`}</div>
    ${ro && !f.afterPhotos.length ? '<p class="muted" style="font-size:.875rem;margin:8px 0 0">No after photos.</p>' : ''}
  </section>`;
  main.innerHTML = html;
  let bar = document.querySelector('.cl-bar');
  if (!bar) { bar = document.createElement('div'); bar.className = 'cl-bar'; document.body.appendChild(bar); }
  bar.innerHTML = `<div class="cl-bar-in"><div class="bar-progress"><div class="bar-text">${esc(f.warehouseName)}: ${ro ? 'fixed' : 'open'}</div></div>${ro ? '<button class="btn primary" data-backfx>Done</button>' : '<button class="btn primary" data-dofix>Mark as fixed</button>'}</div>`;
}
function saveFix(d) {
  const f = S.fix;
  return queueSave('fx:' + f.id, () => api('PUT', '/api/issues/' + f.id, { fixNote: f.fixNote, afterPhotos: f.afterPhotos }), d);
}
async function addFixPhotos(files) {
  const f = S.fix; if (!files.length) return;
  S.uploading.fx = (S.uploading.fx || 0) + files.length; renderFix();
  for (const file of files) {
    try {
      const blob = await compress(file);
      if (!/^image\/(jpeg|png|webp)$/.test(blob.type)) throw new Error('Use a JPG, PNG or WebP photo.');
      const r = await api('POST', '/api/photos', blob);
      f.afterPhotos = (f.afterPhotos || []).concat(r.id);
      if (S.fix === f) saveFix(400);
    } catch (e) { toast('Photo didn’t upload. ' + e.message); }
    S.uploading.fx--;
  }
  delete S.uploading.fx;
  if (S.fix === f) renderFix();
}
async function doFix(btn) {
  btn.disabled = true; btn.textContent = 'Saving…';
  await flushAll();
  try {
    const r = await api('POST', `/api/issues/${S.fix.id}/fix`, { fixNote: S.fix.fixNote, afterPhotos: S.fix.afterPhotos });
    if (S.fx) S.fx.list = S.fx.list.filter(x => x.id !== r.issue.id);
    S.fix = null; closeFix(); toast('Marked as fixed'); renderFixes(); window.scrollTo(0, 0);
  } catch (e) { toast(e.message); btn.disabled = false; btn.textContent = 'Mark as fixed'; }
}
async function reopenFix() {
  try { const r = await api('POST', `/api/issues/${S.fix.id}/reopen`); S.fix = r.issue; if (S.fx) S.fx.list = S.fx.list.filter(x => x.id !== r.issue.id); renderFix(); toast('Reopened'); }
  catch (e) { toast(e.message); }
}
function fixedSectionHTML(whId) {
  const list = (S.fixed || []).filter(f => f.warehouseId === whId), open = (S.openByWh || {})[whId] || 0;
  return `<div class="fixed-box"><h4 style="margin-top:0">What was fixed this week (${list.length})</h4>
    ${list.length ? '<ul class="issues">' + list.map(f => `<li class="fx-li"><div class="issue-top"><span class="pill ok">Fixed</span><strong>${esc(f.pointText)}</strong><span class="issue-sec">${esc([f.sectionTitle, f.group].filter(Boolean).join(' / '))} | ${reportedText(f)} | fixed ${fmtDate(f.fixedAt)}${f.fixedByName ? ' by ' + esc(f.fixedByName) : ''}</span></div>
      ${f.fixNote ? `<p class="issue-note">${esc(f.fixNote)}</p>` : ''}
      ${f.beforePhotos.length || f.afterPhotos.length ? `<div class="ba-grid"><div><span class="ba-l">Before</span><div class="photos">${f.beforePhotos.map(p => `<div class="ph"><img src="/api/photos/${esc(p)}" alt="Before" loading="lazy" data-view="${esc(p)}"></div>`).join('') || '<span class="muted" style="font-size:.8125rem">No photo</span>'}</div></div>
        <div><span class="ba-l">After</span><div class="photos">${f.afterPhotos.map(p => `<div class="ph"><img src="/api/photos/${esc(p)}" alt="After" loading="lazy" data-view="${esc(p)}"></div>`).join('') || '<span class="muted" style="font-size:.8125rem">No photo</span>'}</div></div></div>` : ''}</li>`).join('') + '</ul>' : '<p class="muted" style="margin:0;font-size:.875rem">Nothing fixed this week.</p>'}
    <p class="muted" style="margin:10px 0 0;font-size:.875rem">${open ? `${open} work order${open === 1 ? '' : 's'} still open for this warehouse.` : 'No open work orders for this warehouse.'}</p></div>`;
}

/* ---------- Reports ---------- */
function emailStatusHTML(rows) {
  const r = S.report;
  const whs = activeWh();
  const done = whs.filter(w => S.inspections[w.id] && S.inspections[w.id].status === 'submitted').length;
  const left = whs.length - done;
  const rcpt = list => list && list.length ? `<ul class="rcpt">${list.map(x => `<li class="${x.ok ? '' : 'x'}">${x.ok ? 'Sent to' : 'Not sent to'} ${esc(x.name)} (${esc(x.email)})${x.ok ? '' : ': ' + esc(x.error || '')}</li>`).join('')}</ul>` : '';
  if (!S.mailConfigured) return `<div class="status-box bad"><strong>Email isn’t set up on the server.</strong><p>The report can’t be sent until RESEND_API_KEY or the SMTP settings are added on the server. See the README.</p></div>`;
  if (!r) {
    if (left > 0) return `<div class="status-box wait"><strong>Sends automatically when all ${whs.length} warehouses are submitted.</strong><p>${left} still to go.</p></div>`;
    return `<div class="status-box wait"><strong>Sending to managers now.</strong><p>Refresh in a moment to see the result.</p></div>`;
  }
  if (r.status === 'sending') return `<div class="status-box wait"><strong>Sending to managers now.</strong></div>`;
  if (r.status === 'sent') return `<div class="status-box ok"><strong>${r.trigger === 'auto' ? 'Sent automatically' : 'Sent'} on ${fmtDateTime(r.sentAt)}.</strong>${rcpt(r.recipients)}</div>`;
  return `<div class="status-box bad"><strong>${r.status === 'partial' ? 'Some emails didn’t go out.' : 'The report wasn’t sent.'}</strong><p>${esc(r.error || '')}</p>${rcpt(r.recipients)}</div>`;
}
function renderReports() {
  const rows = rowsForWeek();
  if (!rows.length) { main.innerHTML = weekHeader() + `<div class="empty"><h2>No warehouses yet</h2><p>Reports appear here once warehouses are set up and inspected.</p></div>`; return; }
  const submitted = rows.filter(r => r.i && r.i.status === 'submitted');
  let html = weekHeader(`${submitted.length} of ${rows.length} warehouses submitted`);
  html += `<div class="table-wrap"><table><thead><tr><th>Warehouse</th><th class="num">Score</th><th class="num">Passed</th><th class="num">Issues</th><th class="num">Critical</th><th>Inspected by</th></tr></thead><tbody>` +
    rows.map(({ w, i }) => {
      if (!i || i.status !== 'submitted') return `<tr><td><strong>${esc(w.name)}</strong></td><td colspan="5" class="muted">${i ? 'In progress' : 'Not started'}</td></tr>`;
      const st = stats(i);
      return `<tr><td><strong>${esc(w.name)}</strong></td><td class="num"><span class="score ${scoreClass(st.score)}" style="font-size:1.2rem">${st.score == null ? '–' : st.score + '%'}</span></td><td class="num">${st.pass}</td><td class="num">${st.fail}</td><td class="num">${st.critical ? `<span class="tag critical">${st.critical}</span>` : '0'}</td><td>${esc(i.submittedByName || '')}, ${fmtDate(i.submittedAt)}</td></tr>`;
    }).join('') + '</tbody></table></div>';

  const mgrs = S.config.managers || [];
  const r = S.report;
  html += `<section class="panel"><span class="eyebrow dash">Weekly report</span><h2>Email to managers</h2>
    <p class="hint">Sent automatically once, when the last warehouse of the week is submitted. Admins can also send it by hand at any time with Send now. Each manager gets the results for their warehouses, with photos and the full report attached.</p>
    ${emailStatusHTML(rows)}
    <div class="send-actions">
      ${submitted.length ? `<a class="btn" href="/api/reports/${S.week}/download">Download report</a>` : ''}
      ${S.canEdit && submitted.length && S.mailConfigured ? `<button class="btn ${r && r.status === 'sent' ? '' : 'primary'}" data-sendnow ${S.sending || (r && r.status === 'sending') ? 'disabled' : ''}>${S.sending ? 'Sending…' : r && (r.status === 'sent' || r.status === 'partial') ? 'Resend to managers' : 'Send now'}</button>` : ''}
    </div>
    ${mgrs.length ? '<ul class="mgr-list">' + mgrs.map(m => {
      const mr = managerRows(m, rows);
      const scope = m.scope === 'all' || !Array.isArray(m.scope) ? 'All warehouses' : mr.map(x => x.w.name).join(', ') || 'No warehouses assigned';
      return `<li><div class="mgr-who"><div class="n">${esc(m.name)}</div><div class="e">${esc(m.email)}</div><div class="s">${esc(scope)}</div></div></li>`;
    }).join('') + '</ul>' : `<p class="hint">No managers added yet.${S.canEdit ? ' Add them in Setup.' : ''}</p>`}
  </section>`;

  submitted.forEach(({ w, i }) => {
    const st = stats(i), iss = issuesOf(i), others = otherPhotos(i);
    html += `<article class="rep-wh"><header><h3>${esc(w.name)}</h3><span class="score ${scoreClass(st.score)}">${st.score == null ? '–' : st.score + '%'}</span></header>
      <p class="rep-meta">${st.pass} passed, ${st.fail} failed, ${st.na} not applicable. Inspected by ${esc(i.submittedByName || '')} on ${fmtDate(i.submittedAt)}.</p>
      <div class="sec-scores">${st.bySec.map(s => `<span>${esc(s.title)}</span><div class="bar"><span class="${scoreClass(s.score)}" style="width:${s.score == null ? 0 : s.score}%"></span></div><span>${s.score == null ? 'N/A' : s.score + '%'}</span>`).join('')}</div>
      <h4>Issues found (${iss.length})</h4>
      ${iss.length ? '<ul class="issues">' + iss.map(x => `<li><div class="issue-top"><span class="tag ${x.a.sev || 'major'}">${cap(x.a.sev || 'major')}</span><strong>${esc(x.it.text)}</strong><span class="issue-sec">${esc([x.sec.title, x.it.group].filter(Boolean).join(' / '))}${x.it.category ? ' | ' + esc(x.it.category) : ''}</span></div>
        ${x.a.note ? `<p class="issue-note">${esc(x.a.note)}</p>` : ''}
        ${x.it.action ? `<p class="issue-note muted" style="font-size:.875rem"><strong>Corrective action:</strong> ${esc(x.it.action)}</p>` : ''}
        ${x.a.photos && x.a.photos.length ? `<div class="photos" style="margin-top:8px">${x.a.photos.map(p => `<div class="ph"><img src="/api/photos/${esc(p)}" alt="Photo: ${esc(x.it.text)}" loading="lazy" data-view="${esc(p)}"></div>`).join('')}</div>` : ''}</li>`).join('') + '</ul>' : '<p class="ok-note">No issues found.</p>'}
      ${others.length ? `<h4>Other photos</h4><div class="gallery">${others.map(o => `<figure><img src="/api/photos/${esc(o.id)}" alt="Photo: ${esc(o.it.text)}" loading="lazy" data-view="${esc(o.id)}"><figcaption>${esc(o.it.text)}</figcaption></figure>`).join('')}</div>` : ''}
      ${fixedSectionHTML(w.id)}
    </article>`;
  });
  rows.filter(r => !(r.i && r.i.status === 'submitted') && (S.fixed || []).some(f => f.warehouseId === r.w.id)).forEach(({ w }) => {
    html += `<article class="rep-wh"><header><h3>${esc(w.name)}</h3></header><p class="rep-meta">Inspection not submitted this week.</p>${fixedSectionHTML(w.id)}</article>`;
  });
  main.innerHTML = html;
}
async function sendNow() {
  S.sending = true; renderReports();
  try { const r = await api('POST', `/api/reports/${S.week}/send`); S.report = r.report; toast(r.report.status === 'sent' ? 'Report sent to managers' : 'Some emails didn’t go out. See the details.'); }
  catch (e) { toast(e.message); }
  S.sending = false; if (S.tab === 'reports' && !S.draft) renderReports();
}

/* ---------- Account ---------- */
function renderAccount() {
  main.innerHTML = `<span class="eyebrow dash">Account</span><h1 class="page-title">${esc(S.user.name)}</h1>
  <section class="panel"><h2>Your details</h2><p class="hint" style="margin-bottom:0">${esc(S.user.email)}<br>Role: ${ROLE_LABEL[S.user.role] || S.user.role}</p></section>
  <section class="panel"><h2>Change password</h2><p class="hint">You’ll stay signed in on this device. Other devices are signed out.</p>
    <div class="grid2" style="max-width:560px"><input type="password" id="pwCur" placeholder="Current password" aria-label="Current password" autocomplete="current-password" style="min-height:40px;border:1px solid var(--line);border-radius:8px;padding:9px 12px;background:var(--surface)">
    <input type="password" id="pwNew" placeholder="New password (8+ characters)" aria-label="New password" autocomplete="new-password" style="min-height:40px;border:1px solid var(--line);border-radius:8px;padding:9px 12px;background:var(--surface)"></div>
    <p class="err-text" id="pwErr" hidden></p>
    <div style="margin-top:12px;display:flex;gap:10px;flex-wrap:wrap"><button class="btn primary" data-chpw>Change password</button><button class="btn" data-signout>Sign out</button></div></section>`;
}
async function changePassword() {
  const err = document.getElementById('pwErr');
  try { await api('PUT', '/api/me/password', { current: document.getElementById('pwCur').value, next: document.getElementById('pwNew').value }); toast('Password changed'); renderAccount(); }
  catch (e) { err.hidden = false; err.textContent = e.message; }
}

/* ---------- Setup (split into tabs) ---------- */
const SETUP_TABS = [['warehouses', 'Warehouses'], ['users', 'Users'], ['managers', 'Managers'], ['email', 'Email'], ['inspection', 'Inspection checklist'], ['cleaning', 'Cleaning']];
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const DAYS_LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const ROLE_LABEL = { admin: 'Admin', supervisor: 'Supervisor', cleaner: 'Cleaner' };
const secsOf = k => k === 'clean' ? ((S.config.cleaning || (S.config.cleaning = { sections: [] })).sections) : (S.config.sections || (S.config.sections = []));
function setSecs(k, arr) { if (k === 'clean') { S.config.cleaning = S.config.cleaning || {}; S.config.cleaning.sections = arr; } else S.config.sections = arr; }

function renderSetup() {
  const t = S.setupTab || 'warehouses';
  let html = `<span class="eyebrow dash">Admin</span><h1 class="page-title" style="margin-bottom:16px">Setup</h1>
    <nav class="subtabs" aria-label="Setup sections">${SETUP_TABS.map(([k, l]) => `<button class="subtab" data-setuptab="${k}" ${t === k ? 'aria-current="page"' : ''}>${l}</button>`).join('')}</nav>`;
  html += t === 'users' ? panelUsers() : t === 'managers' ? panelManagers() : t === 'email' ? panelEmail()
    : t === 'inspection' ? checklistEditor('insp') : t === 'cleaning' ? panelCleaning() : panelWarehouses();
  main.innerHTML = html;
}
function panelWarehouses() {
  const whs = S.config.warehouses || [];
  return `<section class="panel"><span class="eyebrow dash">Warehouses</span><h2>Warehouse locations</h2><p class="hint">Supervisors inspect their assigned warehouses each week; cleaners clean them on their scheduled days. The Location groups warehouses in cleaner schedules.</p>
    <div class="add-row"><input type="text" id="whName" placeholder="Warehouse name" aria-label="Warehouse name"><input type="text" id="whCode" placeholder="Code (optional)" aria-label="Code"><input type="text" id="whLoc" placeholder="Location, e.g. Al Quoz" aria-label="Location"><button class="btn primary" data-addwh>Add warehouse</button></div>
    ${whs.length ? '<ul class="rows">' + whs.map(w => S.editWh === w.id ? `<li><div class="add-row" style="margin:0"><input type="text" data-ew="name" value="${esc(w.name)}" aria-label="Name"><input type="text" data-ew="code" value="${esc(w.code || '')}" placeholder="Code" aria-label="Code"><input type="text" data-ew="location" value="${esc(w.location || '')}" placeholder="Location" aria-label="Location"><button class="btn primary" data-savewh="${esc(w.id)}">Save</button></div></li>` :
      `<li class="${w.active === false ? 'inactive' : ''}"><div class="row-main"><div class="grow"><div class="t">${esc(w.name)}</div><div class="m">${esc([w.code, w.location].filter(Boolean).join(', ')) || '&nbsp;'}${S.users ? (() => { const sv = supervisorsOf(w.id), cl = cleanersOf(w.id); return (sv.length ? ` | Supervisor: ${esc(sv.map(u => u.name).join(', '))}` : ' | <span class="warn-t">No supervisor</span>') + (cl.length ? ` | Cleaning: ${esc(cl.join(', '))}` : ''); })() : ''}</div></div>
      <label class="toggle"><input type="checkbox" data-activewh="${esc(w.id)}" ${w.active !== false ? 'checked' : ''}> Active</label>
      <button class="btn sm" data-editwh="${esc(w.id)}">Edit</button>
      <button class="btn sm danger ${S.armed === 'wh' + w.id ? 'armed' : ''}" data-delwh="${esc(w.id)}">${S.armed === 'wh' + w.id ? 'Confirm delete' : 'Delete'}</button></div></li>`).join('') + '</ul>' : '<p class="muted">No warehouses yet.</p>'}
  </section>`;
}
function panelManagers() {
  const whs = S.config.warehouses || [], mgrs = S.config.managers || [];
  return `<section class="panel"><span class="eyebrow dash">Managers</span><h2>Report recipients</h2><p class="hint">Managers receive the weekly inspection report by email for the warehouses assigned to them. They don’t need an account.</p>
    <div class="add-row mgr"><input type="text" id="mName" placeholder="Name" aria-label="Manager name"><input type="email" id="mEmail" placeholder="Email address" aria-label="Manager email"><button class="btn primary" data-addmgr>Add manager</button></div>
    <p class="err-text" id="mErr" hidden></p>
    ${mgrs.length ? '<ul class="rows">' + mgrs.map(m => {
      const all = m.scope === 'all' || !Array.isArray(m.scope);
      return `<li><div class="row-main"><div class="grow"><div class="t">${esc(m.name)}</div><div class="m">${esc(m.email)}</div></div>
        <button class="btn sm danger ${S.armed === 'm' + m.id ? 'armed' : ''}" data-delmgr="${esc(m.id)}">${S.armed === 'm' + m.id ? 'Confirm remove' : 'Remove'}</button></div>
        <div class="scope"><label><input type="checkbox" data-scopeall="${esc(m.id)}" ${all ? 'checked' : ''}> All warehouses</label>
        ${all ? '' : whs.map(w => `<label><input type="checkbox" data-scope="${esc(m.id)}" value="${esc(w.id)}" ${m.scope.includes(w.id) ? 'checked' : ''}> ${esc(w.name)}</label>`).join('')}</div></li>`;
    }).join('') + '</ul>' : '<p class="muted">No managers yet.</p>'}
  </section>`;
}
function panelEmail() {
  const snd = S.sender || {}, mail = S.mail || {};
  return `<section class="panel"><span class="eyebrow dash">Email</span><h2>Sender</h2>
    <p class="hint">The weekly inspection report is sent from this address. Your email provider must allow it: verify its domain in Resend, or use the mailbox your SMTP login belongs to.</p>
    ${mail.provider ? `<div class="status-box ok"><strong>Email provider: ${mail.provider === 'resend' ? 'Resend' : 'SMTP'}</strong>${mail.appUrl ? `<p>Links in emails point to ${esc(mail.appUrl)}</p>` : '<p>Set APP_URL on the server so email links point to this app.</p>'}</div>` : `<div class="status-box bad"><strong>No email provider is configured on the server.</strong><p>Add RESEND_API_KEY, or SMTP_HOST, SMTP_USER and SMTP_PASS, in your host’s environment settings, then redeploy.</p></div>`}
    <div class="grid2" style="margin-bottom:8px"><input type="text" id="sName" value="${esc(snd.name || '')}" placeholder="Sender name, e.g. storage.ae Operations" aria-label="Sender name"><input type="email" id="sEmail" value="${esc(snd.email || '')}" placeholder="Sender email, e.g. facilities@storage.ae" aria-label="Sender email"></div>
    <div class="grid2"><input type="email" id="sReply" value="${esc(snd.replyTo || '')}" placeholder="Reply-to email (optional)" aria-label="Reply-to email"><div><button class="btn primary" data-savesender>Save sender</button></div></div>
    <p class="err-text" id="sErr" hidden></p>
    <div class="grid2" style="margin-top:16px"><input type="email" id="tTo" value="${esc(S.user.email)}" aria-label="Send test email to"><div><button class="btn" data-testmail ${mail.provider ? '' : 'disabled'}>Send test email</button></div></div>
  </section>`;
}
function normSched(v) {
  // Same shape as the server: { mode, days: {1..7: [ids]}, weeks: {'YYYY-Www': {1..7: [ids]}} }
  if (!v || Array.isArray(v)) return { mode: 'recurring', days: {}, weeks: {} };
  return { mode: v.mode === 'weekly' ? 'weekly' : 'recurring', days: v.days || {}, weeks: v.weeks || {} };
}
function scheduleSummary(u) {
  const sc = normSched(u.schedule), whMap = {};
  (S.config.warehouses || []).forEach(w => { whMap[w.id] = w; });
  const line = days => DAYS.map((d, i) => { const l = (days[i + 1] || []).filter(id => whMap[id]).map(id => whMap[id].name); return l.length ? `${d}: ${l.join(', ')}` : ''; }).filter(Boolean).join(' | ');
  if (sc.mode === 'recurring') { const l = line(sc.days); return l ? 'Every week: ' + l : ''; }
  const now = FC.isoWeek(new Date()), next = shiftWeek(now, 1);
  const cnt = wk => Object.values(sc.weeks[wk] || {}).reduce((n, l) => n + l.length, 0);
  return `Week by week: this week ${cnt(now) ? cnt(now) + ' visit' + (cnt(now) === 1 ? '' : 's') : 'not planned'}, next week ${cnt(next) ? cnt(next) + ' visit' + (cnt(next) === 1 ? '' : 's') : 'not planned'}`;
}
function panelUsers() {
  const users = S.users, whs = S.config.warehouses || [];
  const opt = (v, cur) => `<option value="${v}" ${cur === v ? 'selected' : ''}>${ROLE_LABEL[v]}</option>`;
  return `<section class="panel"><span class="eyebrow dash">People</span><h2>Users</h2>
    <p class="hint"><strong>Admins</strong> see everything. <strong>Supervisors</strong> only see the Inspect page, for the warehouses ticked under their name. <strong>Cleaners</strong> only see their own daily cleaning jobs and schedule; set schedules in the Cleaning tab. Give each person a temporary password; they can change it under Account.</p>
    ${(() => { const un = activeWh().filter(w => S.users && !supervisorsOf(w.id).length); return S.users && un.length && S.users.some(u => u.role === 'supervisor') ? `<div class="status-box wait"><strong>${un.length} warehouse${un.length === 1 ? ' has' : 's have'} no supervisor:</strong><p>${esc(un.map(w => w.name).join(', '))}. Only admins can inspect ${un.length === 1 ? 'it' : 'them'} until you tick ${un.length === 1 ? 'it' : 'them'} under a supervisor.</p></div>` : ''; })()}
    <div class="add-row" style="grid-template-columns:1.1fr 1.4fr .9fr 1.1fr auto"><input type="text" id="uName" placeholder="Name" aria-label="User name"><input type="email" id="uEmail" placeholder="Email" aria-label="User email">
      <select id="uRole" aria-label="Role">${opt('supervisor', 'supervisor')}${opt('cleaner')}${opt('admin')}</select>
      <input type="text" id="uPw" placeholder="Temporary password" aria-label="Temporary password"><button class="btn primary" data-adduser>Add user</button></div>
    <p class="err-text" id="uErr" hidden></p>
    ${!users ? '<p class="muted">Loading users…</p>' : '<ul class="rows">' + users.map(u => `<li class="${u.active ? '' : 'inactive'}"><div class="row-main"><div class="grow"><div class="t">${esc(u.name)}${u.id === S.user.id ? ' (you)' : ''}</div><div class="m">${esc(u.email)}</div></div>
      <select data-urole="${u.id}" aria-label="Role for ${esc(u.name)}" ${u.id === S.user.id ? 'disabled' : ''}>${opt('supervisor', u.role)}${opt('cleaner', u.role)}${opt('admin', u.role)}</select>
      ${u.id === S.user.id ? '' : `<label class="toggle"><input type="checkbox" data-uactive="${u.id}" ${u.active ? 'checked' : ''}> Active</label>
      <button class="btn sm" data-upw="${u.id}">Reset password</button>
      <button class="btn sm danger ${S.armed === 'u' + u.id ? 'armed' : ''}" data-udel="${u.id}">${S.armed === 'u' + u.id ? 'Confirm delete' : 'Delete'}</button>`}</div>
      ${u.role === 'supervisor' ? `<div class="scope"><span class="muted" style="font-size:.8125rem">Warehouses:</span>${whs.length ? whs.map(w => `<label><input type="checkbox" data-uwh="${u.id}" value="${esc(w.id)}" ${(u.warehouses || []).includes(w.id) ? 'checked' : ''}> ${esc(w.name)}</label>`).join('') : '<span class="muted" style="font-size:.8125rem">Add warehouses first.</span>'}${whs.length && !(u.warehouses || []).length ? '<span class="warn-t" style="font-size:.8125rem">None assigned, so this supervisor sees nothing</span>' : ''}</div>` : ''}
      ${u.role === 'cleaner' ? `<div class="scope"><span class="muted" style="font-size:.8125rem">Schedule:</span>${scheduleSummary(u) ? `<span style="font-size:.8125rem">${esc(scheduleSummary(u))}</span>` : '<span class="warn-t" style="font-size:.8125rem">No schedule yet</span>'}<button class="link-btn" data-setuptab="cleaning" data-focuscleaner="${u.id}">Edit schedule</button></div>` : ''}
      ${S.resetFor === u.id ? `<div class="grid2" style="margin-top:10px;max-width:560px"><input type="text" id="rPw" placeholder="New temporary password" aria-label="New password"><div><button class="btn primary" data-upwsave="${u.id}">Set password</button></div></div>` : ''}</li>`).join('') + '</ul>'}
  </section>`;
}
function checklistEditor(k) {
  const clean = k === 'clean', secs = secsOf(k);
  const nPoints = secs.reduce((n, x) => n + x.items.length, 0);
  const imp = S.importPreview && S.importPreview.kind === k;
  let html = `<section class="panel" id="clPanel-${k}"><span class="eyebrow dash">${clean ? 'Cleaning' : 'Inspection'}</span><h2>${clean ? 'Cleaning checklist' : 'Inspection checklist'}</h2>
    <p class="hint">${clean
      ? 'The points a cleaner ticks off at every warehouse they clean. Write each as a task (“Mop floors”). Changes apply to work orders that haven’t been started yet.'
      : 'Add, edit, reorder or remove points, or import them from Excel. Write each point as what good looks like (“Floor free of dust”), so Pass means OK. Changes apply to inspections started after you make them; inspections already started keep their checklist.'}</p>
    <div class="send-actions"><label class="btn primary"><input class="vh" type="file" accept=".xlsx,.xls,.csv" data-import data-k="${k}" aria-label="Import checklist from Excel">Import from Excel</label>
      ${secs.length ? '' : `<button class="btn" data-std data-k="${k}">Use standard ${clean ? 'cleaning ' : ''}checklist</button>`}
      <span class="muted" style="align-self:center;font-size:.875rem">${nPoints} point${nPoints === 1 ? '' : 's'} in ${secs.length} section${secs.length === 1 ? '' : 's'}</span></div>
    ${imp ? importPreviewHTML() : ''}`;
  html += secs.map((sec, si) => {
    let lastG = null;
    return `<div class="ed-sec">
      <span class="eyebrow">Section ${String(si + 1).padStart(2, '0')} | ${sec.items.length} point${sec.items.length === 1 ? '' : 's'}</span>
      <div class="ed-sec-head"><input type="text" data-sectitle="${esc(sec.id)}" data-k="${k}" value="${esc(sec.title)}" aria-label="Section title">
      <button class="icon-btn" data-mvsec="${si}" data-k="${k}" data-dir="-1" aria-label="Move section up" ${si === 0 ? 'disabled' : ''}>↑</button>
      <button class="icon-btn" data-mvsec="${si}" data-k="${k}" data-dir="1" aria-label="Move section down" ${si === secs.length - 1 ? 'disabled' : ''}>↓</button>
      <button class="icon-btn ${S.armed === 's' + sec.id ? 'armed' : ''}" data-delsec="${esc(sec.id)}" data-k="${k}" aria-label="${S.armed === 's' + sec.id ? 'Click again to delete this section' : 'Delete section'}" title="${S.armed === 's' + sec.id ? 'Click again to delete' : 'Delete section'}">×</button></div>
      ${sec.items.map((it, ii) => {
        const g = it.group || '';
        const gh = g && g !== lastG ? `<div class="ed-grp">${esc(g)}</div>` : '';
        lastG = g;
        const open = S.edOpen[it.id];
        const meta = clean ? '' : [it.category, it.action].filter(Boolean).join(' | ');
        return gh + `<div class="ed-item"><input type="text" data-itemtext="${esc(it.id)}" data-of="${esc(sec.id)}" data-k="${k}" value="${esc(it.text)}" placeholder="${clean ? 'Task, e.g. Mop floors' : 'Point, e.g. Floor free of dust'}" aria-label="Checklist point">
          <button class="icon-btn" data-mvitem="${ii}" data-of="${esc(sec.id)}" data-k="${k}" data-dir="-1" aria-label="Move point up" ${ii === 0 ? 'disabled' : ''}>↑</button>
          <button class="icon-btn" data-mvitem="${ii}" data-of="${esc(sec.id)}" data-k="${k}" data-dir="1" aria-label="Move point down" ${ii === sec.items.length - 1 ? 'disabled' : ''}>↓</button>
          <button class="icon-btn ${open ? 'on' : ''}" data-itemmore="${esc(it.id)}" data-k="${k}" aria-expanded="${!!open}" aria-label="${clean ? 'Group' : 'Group, category and corrective action'}" title="${clean ? 'Group (sub-heading)' : 'Group, category and corrective action'}">⋯</button>
          <button class="icon-btn ${S.armed === 'i' + it.id ? 'armed' : ''}" data-delitem="${esc(it.id)}" data-of="${esc(sec.id)}" data-k="${k}" aria-label="${S.armed === 'i' + it.id ? 'Click again to remove this point' : 'Remove point'}" title="${S.armed === 'i' + it.id ? 'Click again to remove' : 'Remove point'}">×</button></div>
          ${open ? `<div class="ed-more ${clean ? 'one' : ''}">
            <input type="text" data-itemfield="group" data-id="${esc(it.id)}" data-of="${esc(sec.id)}" data-k="${k}" value="${esc(it.group || '')}" placeholder="Group (sub-heading), optional" aria-label="Group">
            ${clean ? '' : `<input type="text" data-itemfield="category" data-id="${esc(it.id)}" data-of="${esc(sec.id)}" data-k="${k}" value="${esc(it.category || '')}" placeholder="Category, optional" aria-label="Category">
            <input type="text" data-itemfield="action" data-id="${esc(it.id)}" data-of="${esc(sec.id)}" data-k="${k}" value="${esc(it.action || '')}" placeholder="Corrective action shown when it fails, optional" aria-label="Corrective action">`}</div>`
          : meta ? `<div class="ed-meta">${esc(meta)}</div>` : ''}`;
      }).join('')}
      <button class="link-btn" data-additem="${esc(sec.id)}" data-k="${k}">+ Add point</button></div>`;
  }).join('');
  html += `<div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:6px"><button class="btn" data-addsec data-k="${k}">+ Add section</button>
    ${secs.length ? `<button class="btn ghost ${S.armed === 'std' + k ? 'danger armed' : ''}" data-std data-k="${k}">${S.armed === 'std' + k ? 'Confirm: replace with standard' : 'Restore standard checklist'}</button>` : ''}</div></section>`;
  return html;
}
function panelCleaning() {
  const cleaners = (S.users || []).filter(u => u.role === 'cleaner');
  const whs = (S.config.warehouses || []).filter(w => w.active !== false);
  const byLoc = {};
  whs.forEach(w => { const l = w.location || 'No location'; (byLoc[l] = byLoc[l] || []).push(w); });
  const locs = Object.keys(byLoc).sort();
  const thisWeek = FC.isoWeek(new Date());
  S.schedWeek = S.schedWeek || {};
  let html = `<section class="panel"><span class="eyebrow dash">Cleaning</span><h2>Cleaner schedules</h2>
    <p class="hint">Tick the warehouses each cleaner cleans on each day. <strong>Recurring</strong> repeats the same plan every week. <strong>Week by week</strong> is planned one week at a time and ends with that week, so plan the next week before Monday. Every ticked warehouse becomes a work order on that day. Add cleaners in the Users tab with the role Cleaner.</p>`;
  if (!S.users) html += '<p class="muted">Loading…</p>';
  else if (!cleaners.length) html += `<div class="empty" style="margin:0"><h2>No cleaners yet</h2><p>Add a user with the role Cleaner, then plan their schedule here.</p><button class="btn primary" data-setuptab="users">Go to Users</button></div>`;
  else if (!whs.length) html += '<p class="muted">Add warehouses first.</p>';
  else html += cleaners.map(u => {
    const sc = normSched(u.schedule), weekly = sc.mode === 'weekly';
    const wk = S.schedWeek[u.id] || thisWeek;
    const plan = weekly ? (sc.weeks[wk] || {}) : sc.days;
    const has = (d, id) => (plan[d] || []).includes(id);
    const dayCount = d => (plan[d] || []).filter(id => whs.some(w => w.id === id)).length;
    const prevWk = shiftWeek(wk, -1), prevPlan = sc.weeks[prevWk] || {};
    const prevHas = Object.values(prevPlan).some(l => l.length);
    return `<div class="cl-card ${u.active ? '' : 'inactive'}" id="cleaner-${u.id}">
      <div class="row-main"><div class="grow"><div class="t">${esc(u.name)}${u.active ? '' : ' (inactive)'}</div><div class="m">${esc(scheduleSummary(u)) || '<span class="warn-t">No schedule yet</span>'}</div></div>
        <div class="seg" role="group" aria-label="Schedule type for ${esc(u.name)}">
          <button type="button" class="seg-b mode ${!weekly ? 'on' : ''}" data-schedmode="${u.id}" data-mode="recurring" aria-pressed="${!weekly}">Recurring</button>
          <button type="button" class="seg-b mode ${weekly ? 'on' : ''}" data-schedmode="${u.id}" data-mode="weekly" aria-pressed="${weekly}">Week by week</button></div></div>
      ${weekly ? `<div class="wk-bar">
          <button class="btn ghost sm" data-schedwk="${u.id}" data-dir="-1" ${wk <= thisWeek ? 'disabled' : ''} aria-label="Previous week">‹</button>
          <div class="wk-label"><strong>Week ${weekNo(wk)}</strong> <span class="muted">${weekRangeText(wk)}</span>${wk === thisWeek ? ' <span class="pill prog">This week</span>' : wk === shiftWeek(thisWeek, 1) ? ' <span class="pill">Next week</span>' : ''}</div>
          <button class="btn ghost sm" data-schedwk="${u.id}" data-dir="1" ${wk >= shiftWeek(thisWeek, 12) ? 'disabled' : ''} aria-label="Next week">›</button>
          <span class="grow"></span>
          ${prevHas ? `<button class="btn sm" data-schedcopy="${u.id}">Copy week ${weekNo(prevWk)}</button>` : ''}
          ${Object.values(plan).some(l => l.length) ? `<button class="btn sm danger ${S.armed === 'clr' + u.id + wk ? 'armed' : ''}" data-schedclear="${u.id}">${S.armed === 'clr' + u.id + wk ? 'Confirm clear' : 'Clear week'}</button>` : ''}
        </div>` : ''}
      <div class="grid-wrap"><table class="sched-grid">
        <thead><tr><th scope="col">Warehouse</th>${DAYS.map((d, i) => `<th scope="col">${d}${weekly ? `<span class="dnum">${dateOfWeekDay(wk, i + 1)}</span>` : ''}</th>`).join('')}</tr></thead>
        <tbody>${locs.map(l => `<tr class="loc-row"><th colspan="8" scope="colgroup">${esc(l)}</th></tr>` + byLoc[l].map(w => `<tr><th scope="row">${esc(w.name)}</th>${DAYS.map((d, i) => `<td><label class="cell"><input type="checkbox" data-schedcell="${u.id}" data-day="${i + 1}" value="${esc(w.id)}" ${has(i + 1, w.id) ? 'checked' : ''} aria-label="${esc(w.name)} on ${DAYS_LONG[i]}"><span aria-hidden="true"></span></label></td>`).join('')}</tr>`).join('')).join('')}</tbody>
        <tfoot><tr><th scope="row">Per day</th>${DAYS.map((d, i) => `<td>${dayCount(i + 1) || '<span class="muted">–</span>'}</td>`).join('')}</tr></tfoot>
      </table></div>
      ${weekly && !Object.values(plan).some(l => l.length) ? `<p class="warn-t" style="font-size:.8125rem;margin:8px 0 0">Week ${weekNo(wk)} isn’t planned yet: ${esc(u.name)} has no work orders that week.</p>` : ''}
    </div>`;
  }).join('');
  html += `</section>`;
  html += checklistEditor('clean');
  return html;
}
function dateOfWeekDay(wk, d) { const m = FC.weekStart(wk); m.setUTCDate(m.getUTCDate() + d - 1); return m.getUTCDate(); }
function cleanersOf(whId) {
  const thisWeek = FC.isoWeek(new Date());
  return (S.users || []).filter(u => {
    if (u.role !== 'cleaner' || !u.active) return false;
    const sc = normSched(u.schedule), plan = sc.mode === 'weekly' ? (sc.weeks[thisWeek] || {}) : sc.days;
    return Object.values(plan).some(l => (l || []).includes(whId));
  }).map(u => u.name);
}
function editSchedule(uid_, fn) {
  const u = (S.users || []).find(x => x.id === +uid_); if (!u) return;
  const sc = clone(normSched(u.schedule));
  fn(sc);
  u.schedule = sc;
  renderSetup();
  S.schedT = S.schedT || {};
  clearTimeout(S.schedT[uid_]);
  setSave('saving');
  S.schedT[uid_] = setTimeout(() => api('PUT', '/api/users/' + uid_, { schedule: u.schedule }).then(r => { u.schedule = r.user.schedule; setSave('saved'); }).catch(e => { setSave('error'); toast(e.message); }), 500);
}

/* ---------- Checklist import (Excel / CSV) ---------- */
function loadXLSX() {
  if (window.XLSX) return Promise.resolve();
  return new Promise((res, rej) => {
    const el = document.createElement('script');
    el.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
    el.onload = res; el.onerror = () => rej(new Error('Couldn’t load the Excel reader. Check your connection and try again.'));
    document.head.appendChild(el);
  });
}
const MARK = /^[\s\u2705\u2714\u2611\u2713\u25AA\u25CF\u2022*#>\-–]+/u;
function parseChecklist(rows) {
  const norm = v => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  let hi = -1, col = { point: 0 };
  for (let i = 0; i < Math.min(rows.length, 30); i++) {
    const r = rows[i] || [];
    const idx = r.findIndex(v => /^(checkpoints?|check ?points?|points?|items?|checks?|questions?)$/i.test(norm(v)));
    if (idx < 0) continue;
    hi = i; col = { point: idx };
    r.forEach((v, j) => {
      const t = norm(v).toLowerCase();
      if (/^(area|section|zone|location)$/.test(t)) col.area = j;
      else if (/^(group|sub ?section|sub ?heading|sub-?area)$/.test(t)) col.group = j;
      else if (/^(category|cause|root cause|type)$/.test(t)) col.category = j;
      else if (/^(solution|action|corrective action|recommended action|fix|remedy)$/.test(t)) col.action = j;
    });
    break;
  }
  const secs = [], byTitle = {}, seen = {}, problem = [], dupes = [];
  const getSec = t => { const k = (t || 'General').toLowerCase(); if (!byTitle[k]) { byTitle[k] = { id: uid(), title: t || 'General', items: [] }; secs.push(byTitle[k]); } return byTitle[k]; };
  let area = '', group = '';
  for (let i = hi + 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const raw = norm(r[col.point]);
    if (!raw) continue;
    const others = r.some((v, j) => j !== col.point && norm(v) !== '');
    if (/^(survey|score|total|overall)\b/i.test(raw) || (/\bscore\b/i.test(raw) && r.some(v => typeof v === 'number'))) continue;
    if (col.area == null && !others) {
      // A row with only a title: "✅ Something" is a group, plain text is an area
      if (MARK.test(raw)) group = raw.replace(MARK, '').trim(); else { area = raw.replace(MARK, '').trim(); group = ''; }
      continue;
    }
    if (col.area != null && norm(r[col.area])) { const na = norm(r[col.area]); if (na !== area) group = ''; area = na; }
    if (col.group != null && norm(r[col.group])) group = norm(r[col.group]);
    const text = raw.replace(MARK, '').trim().slice(0, 300);
    const it = { id: uid(), text };
    if (group) it.group = group.slice(0, 80);
    if (col.category != null && norm(r[col.category]) && typeof r[col.category] !== 'number' && typeof r[col.category] !== 'boolean') it.category = norm(r[col.category]).slice(0, 60);
    if (col.action != null && norm(r[col.action]) && typeof r[col.action] !== 'boolean') it.action = norm(r[col.action]).slice(0, 300);
    const sec = getSec(area);
    const key = sec.title.toLowerCase() + '|' + text.toLowerCase();
    if (seen[key]) { dupes.push(`${sec.title}: ${text}`); continue; }
    seen[key] = true;
    sec.items.push(it);
    if (!/^no\b|free of|\bclean\b|working|stocked|available|fresh|clear\b|closed|kept|tidy/i.test(text) && /(\bnot\b|\bhas\b|\bhave\b|shows?\b|dirty|dusty|missing|blocked|faulty|exposed|buildup|pooling|left behind|left out|stained|smudge|cluttered|unpleasant)/i.test(text)) problem.push(text);
  }
  const sections = secs.filter(x => x.items.length);
  return { sections, count: sections.reduce((n, x) => n + x.items.length, 0), problem, dupes };
}
async function importFile(file, k) {
  try {
    toast('Reading ' + file.name + '…');
    await loadXLSX();
    const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
    const name = wb.SheetNames.find(n => /checklist/i.test(n)) || wb.SheetNames[0];
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '', raw: true, blankrows: false });
    const r = parseChecklist(rows);
    if (!r.count) throw new Error('No checklist points found in that file. Put one point per row, with a “Checkpoint” column header.');
    S.importPreview = Object.assign(r, { fileName: file.name, kind: k || 'insp' });
    if (k === 'clean') S.importPreview.problem = [];
    renderSetup();
    const el = document.getElementById('impPreview'); el && el.scrollIntoView({ block: 'start', behavior: 'smooth' });
  } catch (e) { toast(e.message || 'Couldn’t read that file.'); }
}
function importPreviewHTML() {
  const p = S.importPreview, has = secsOf(p.kind).length;
  return `<div class="imp" id="impPreview"><span class="eyebrow dash">Import preview</span>
    <h3 style="font-size:1.25rem;margin:6px 0 4px">${esc(p.fileName)}: ${p.count} points in ${p.sections.length} section${p.sections.length === 1 ? '' : 's'}</h3>
    <ul class="imp-list">${p.sections.map(x => { const groups = new Set(x.items.map(i => i.group).filter(Boolean)).size; return `<li><strong>${esc(x.title)}</strong><span class="muted">${x.items.length} point${x.items.length === 1 ? '' : 's'}${groups ? `, ${groups} group${groups === 1 ? '' : 's'}` : ''}</span></li>`; }).join('')}</ul>
    ${p.problem.length ? `<div class="status-box wait"><strong>${p.problem.length} point${p.problem.length === 1 ? ' looks' : 's look'} like ${p.problem.length === 1 ? 'it describes' : 'they describe'} a problem.</strong><p>For example: “${esc(p.problem[0])}”. In the app, Pass means the point is OK, so these read the wrong way round. Write them as what good looks like (“Floor free of dust” instead of “Floor has dust”). You can import now and edit them below.</p></div>` : ''}
    ${p.dupes.length ? `<div class="status-box"><strong>${p.dupes.length} duplicate${p.dupes.length === 1 ? '' : 's'} skipped</strong><p>${p.dupes.slice(0, 4).map(esc).join('<br>')}${p.dupes.length > 4 ? '<br>…' : ''}</p></div>` : ''}
    <div class="send-actions" style="margin:12px 0 0">
      <button class="btn primary ${S.armed === 'impReplace' ? 'armed' : ''}" data-impreplace>${!has ? 'Import checklist' : S.armed === 'impReplace' ? 'Confirm: replace current checklist' : 'Replace current checklist'}</button>
      ${has ? '<button class="btn" data-impadd>Add to current checklist</button>' : ''}
      <button class="btn ghost" data-impcancel>Cancel</button></div></div>`;
}
function applyImport(mode) {
  const p = S.importPreview; if (!p) return;
  if (mode === 'replace') setSecs(p.kind, p.kind === 'clean' ? p.sections.map(x => ({ id: x.id, title: x.title, items: x.items.map(i => ({ id: i.id, text: i.text, group: i.group })) })) : p.sections);
  else {
    const cur = secsOf(p.kind);
    p.sections.forEach(ns => {
      const ex = cur.find(x => x.title.toLowerCase() === ns.title.toLowerCase());
      if (!ex) { cur.push(ns); return; }
      const have = new Set(ex.items.map(i => i.text.toLowerCase()));
      ns.items.forEach(i => { if (!have.has(i.text.toLowerCase())) ex.items.push(i); });
    });
  }
  S.importPreview = null; S.armed = null;
  saveConfig(0); renderSetup();
  toast(mode === 'replace' ? `Checklist replaced: ${p.count} points imported` : 'Points added to the checklist');
}
function arm(key) { S.armed = key; clearTimeout(S.armT); S.armT = setTimeout(() => { if (S.armed === key) { S.armed = null; if (S.tab === 'setup' && !S.draft) renderSetup(); } }, 4000); }
const isEmail = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
function addWarehouse() {
  const n = document.getElementById('whName').value.trim();
  if (!n) { document.getElementById('whName').focus(); return toast('Enter a warehouse name.'); }
  S.config.warehouses.push({ id: uid(), name: n, code: document.getElementById('whCode').value.trim(), location: document.getElementById('whLoc').value.trim(), active: true });
  saveConfig(0); renderSetup(); document.getElementById('whName').focus(); toast(`${n} added`);
}
function addManager() {
  const n = document.getElementById('mName').value.trim(), e = document.getElementById('mEmail').value.trim();
  const err = document.getElementById('mErr');
  if (!n || !isEmail(e)) { err.hidden = false; err.textContent = !n ? 'Enter the manager’s name.' : 'Enter a valid email address.'; return; }
  S.config.managers.push({ id: uid(), name: n, email: e, scope: 'all' });
  saveConfig(0); renderSetup(); document.getElementById('mName').focus(); toast(`${n} added`);
}
async function saveSender() {
  const err = document.getElementById('sErr');
  try {
    const r = await api('PUT', '/api/settings/sender', { name: document.getElementById('sName').value, email: document.getElementById('sEmail').value, replyTo: document.getElementById('sReply').value });
    S.sender = r.sender; err.hidden = true; toast('Sender saved');
  } catch (e) { err.hidden = false; err.textContent = e.message; }
}
async function testMail(btn) {
  btn.disabled = true; btn.textContent = 'Sending…';
  try { const r = await api('POST', '/api/settings/test-email', { to: document.getElementById('tTo').value }); toast(`Test email sent to ${r.to}`); }
  catch (e) { toast(e.message); }
  btn.disabled = false; btn.textContent = 'Send test email';
}
async function addUser() {
  const err = document.getElementById('uErr');
  try {
    await api('POST', '/api/users', { name: document.getElementById('uName').value, email: document.getElementById('uEmail').value, role: document.getElementById('uRole').value, password: document.getElementById('uPw').value });
    const rl = document.getElementById('uRole').value;
    toast(rl === 'supervisor' ? 'User added. Now tick their warehouses below, then share their email and temporary password.' : rl === 'cleaner' ? 'Cleaner added. Set their schedule in the Cleaning tab, then share their email and temporary password.' : 'User added. Share their email and temporary password with them.');
    await loadUsers(); renderSetup();
  } catch (e) { err.hidden = false; err.textContent = e.message; }
}
async function updateUser(id, body, msg) {
  try { await api('PUT', '/api/users/' + id, body); if (msg) toast(msg); } catch (e) { toast(e.message); }
  await loadUsers(); renderSetup();
}

/* ---------- Events ---------- */
main.addEventListener('click', e => {
  const t = e.target.closest('button, a, img[data-view]'); if (!t) return;
  const ds = t.dataset;
  if ('dologin' in ds) return doLogin();
  if (ds.fxstatus) { S.fxStatus = ds.fxstatus; renderFixes(); loadFixes().then(() => { if (S.tab === 'fixes' && !S.fix) renderFixes(); }); return; }
  if (ds.openfx) return openFix(ds.openfx);
  if ('backfx' in ds) { flushAll(); closeFix(); renderFixes(); loadFixes().then(() => { if (S.tab === 'fixes' && !S.fix) renderFixes(); }); window.scrollTo(0, 0); return; }
  if ('reopenfx' in ds) return reopenFix();
  if (ds.rmfxphoto && S.fix) { S.fix.afterPhotos = S.fix.afterPhotos.filter(p => p !== ds.rmfxphoto); saveFix(); renderFix(); return; }
  if (ds.tabGo) return goTab(ds.tabGo);
  if (ds.openjob) return openJob(ds.openjob);
  if ('backjob' in ds) { flushAll(); closeJob(); render(); window.scrollTo(0, 0); return; }
  if ('reopenjob' in ds) return reopenJob();
  if (ds.rmjobphoto && S.job) { S.job.photos = S.job.photos.filter(p => p !== ds.rmjobphoto); saveJob(); renderJob(); return; }
  if (ds.recq) { const [a, b] = ds.recq.split('|'); S.recF.from = a; S.recF.to = b; S.rec = null; renderCleaning(); loadRecords().then(renderCleaning); return; }
  if (ds.recopen) { S.recOpen = S.recOpen === +ds.recopen ? null : +ds.recopen; renderCleaning(); return; }
  if (ds.recreopen) { api('POST', `/api/cleaning/jobs/${ds.recreopen}/reopen`).then(() => loadRecords()).then(() => { renderCleaning(); toast('Work order reopened'); }).catch(e => toast(e.message)); return; }
  if ('dosetup' in ds) return doSetup();
  if ('signout' in ds) return signOut();
  if ('chpw' in ds) return changePassword();
  if (ds.view) return viewPhoto(ds.view);
  if (ds.go) return goTab(ds.go);
  if (ds.week != null) return changeWeek(+ds.week);
  if (ds.open) return openInspection(ds.open);
  if ('back' in ds) { closeDraft(); render(); window.scrollTo(0, 0); return; }
  if (ds.toggle) { const open = t.getAttribute('aria-expanded') === 'true'; t.setAttribute('aria-expanded', String(!open)); S.collapsed[ds.toggle] = open; return; }
  const itemEl = t.closest('[data-item]');
  if (ds.set && itemEl) return setAnswer(itemEl.dataset.item, ds.set);
  if (ds.sev && itemEl) { const a = S.draft.answers[itemEl.dataset.item]; a.sev = ds.sev; saveDraft(); rerenderItem(itemEl.dataset.item, `[data-sev="${ds.sev}"]`); return; }
  if ('expand' in ds && itemEl) { S.expanded[itemEl.dataset.item] = true; rerenderItem(itemEl.dataset.item, '[data-note]'); return; }
  if (ds.rmphoto && itemEl) { const a = S.draft.answers[itemEl.dataset.item]; a.photos = (a.photos || []).filter(p => p !== ds.rmphoto); saveDraft(); rerenderItem(itemEl.dataset.item); return; }
  if (ds.allpass) {
    const sec = S.draft.sections.find(s => s.id === ds.allpass); let n = 0;
    sec.items.forEach(it => { const a = S.draft.answers[it.id] || (S.draft.answers[it.id] = {}); if (!a.s) { a.s = 'pass'; n++; rerenderItem(it.id); } });
    if (n) { saveDraft(); updateProgress(); toast(`${n} point${n > 1 ? 's' : ''} marked Pass`); }
    return;
  }
  if ('reopen' in ds) return reopenDraft();
  if ('sendnow' in ds) return sendNow();
  // Setup
  if (ds.setuptab) {
    S.setupTab = ds.setuptab; S.armed = null; S.editWh = null; renderSetup(); window.scrollTo(0, 0);
    if (ds.focuscleaner) { const el = document.getElementById('cleaner-' + ds.focuscleaner); el && el.scrollIntoView({ block: 'start' }); }
    return;
  }
  if (ds.schedmode) return editSchedule(ds.schedmode, sc => { sc.mode = ds.mode; });
  if (ds.schedwk) { const cur = S.schedWeek[ds.schedwk] || FC.isoWeek(new Date()); S.schedWeek[ds.schedwk] = shiftWeek(cur, +ds.dir); S.armed = null; renderSetup(); const el = document.getElementById('cleaner-' + ds.schedwk); el && el.scrollIntoView({ block: 'nearest' }); return; }
  if (ds.schedcopy) { const wk = S.schedWeek[ds.schedcopy] || FC.isoWeek(new Date()); return editSchedule(ds.schedcopy, sc => { sc.weeks[wk] = clone(sc.weeks[shiftWeek(wk, -1)] || {}); toast('Copied week ' + weekNo(shiftWeek(wk, -1))); }); }
  if (ds.schedclear) {
    const wk = S.schedWeek[ds.schedclear] || FC.isoWeek(new Date());
    if (S.armed !== 'clr' + ds.schedclear + wk) { arm('clr' + ds.schedclear + wk); renderSetup(); return; }
    S.armed = null; return editSchedule(ds.schedclear, sc => { delete sc.weeks[wk]; });
  }
  if ('addwh' in ds) return addWarehouse();
  if (ds.editwh) { S.editWh = ds.editwh; renderSetup(); const f = main.querySelector('[data-ew="name"]'); f && f.focus(); return; }
  if (ds.savewh) {
    const w = S.config.warehouses.find(x => x.id === ds.savewh);
    const nm = main.querySelector('[data-ew="name"]').value.trim(); if (!nm) return toast('Enter a warehouse name.');
    w.name = nm; w.code = main.querySelector('[data-ew="code"]').value.trim(); w.location = main.querySelector('[data-ew="location"]').value.trim();
    S.editWh = null; saveConfig(0); renderSetup(); return;
  }
  if (ds.delwh) {
    if (S.armed !== 'wh' + ds.delwh) { arm('wh' + ds.delwh); renderSetup(); return; }
    S.config.warehouses = S.config.warehouses.filter(w => w.id !== ds.delwh);
    S.config.managers.forEach(m => { if (Array.isArray(m.scope)) m.scope = m.scope.filter(x => x !== ds.delwh); });
    S.armed = null; saveConfig(0); renderSetup(); toast('Warehouse deleted. Past reports keep its results.'); return;
  }
  if ('addmgr' in ds) return addManager();
  if (ds.delmgr) {
    if (S.armed !== 'm' + ds.delmgr) { arm('m' + ds.delmgr); renderSetup(); return; }
    S.config.managers = S.config.managers.filter(m => m.id !== ds.delmgr); S.armed = null; saveConfig(0); renderSetup(); return;
  }
  if ('savesender' in ds) return saveSender();
  if ('testmail' in ds) return testMail(t);
  if ('adduser' in ds) return addUser();
  if (ds.upw) { S.resetFor = S.resetFor === +ds.upw ? null : +ds.upw; renderSetup(); const f = document.getElementById('rPw'); f && f.focus(); return; }
  if (ds.upwsave) { const pw = document.getElementById('rPw').value; S.resetFor = null; return updateUser(ds.upwsave, { password: pw }, 'Password reset. Share it with the user.'); }
  if (ds.udel) {
    if (S.armed !== 'u' + ds.udel) { arm('u' + ds.udel); renderSetup(); return; }
    S.armed = null;
    api('DELETE', '/api/users/' + ds.udel).then(() => toast('User deleted')).catch(er => toast(er.message)).then(() => loadUsers());
    return;
  }
  if ('std' in ds) {
    const k = ds.k || 'insp';
    if (secsOf(k).length && S.armed !== 'std' + k) { arm('std' + k); renderSetup(); return; }
    setSecs(k, k === 'clean' ? FC.standardCleaning() : standardSections()); S.armed = null; S.importPreview = null; saveConfig(0); renderSetup(); toast('Standard checklist loaded'); return;
  }
  if ('addsec' in ds) { const s = { id: uid(), title: 'New section', items: [{ id: uid(), text: '' }] }; secsOf(ds.k).push(s); saveConfig(); renderSetup(); const f = main.querySelector(`[data-sectitle="${s.id}"]`); f && (f.focus(), f.select()); return; }
  if (ds.mvsec != null) { const i = +ds.mvsec, j = i + (+ds.dir), a = secsOf(ds.k); if (j < 0 || j >= a.length) return; [a[i], a[j]] = [a[j], a[i]]; saveConfig(); renderSetup(); return; }
  if (ds.delsec) {
    if (S.armed !== 's' + ds.delsec) { arm('s' + ds.delsec); renderSetup(); return; }
    setSecs(ds.k, secsOf(ds.k).filter(s => s.id !== ds.delsec)); S.armed = null; saveConfig(0); renderSetup(); return;
  }
  if ('impreplace' in ds) { if (S.importPreview && secsOf(S.importPreview.kind).length && S.armed !== 'impReplace') { arm('impReplace'); renderSetup(); return; } return applyImport('replace'); }
  if ('impadd' in ds) return applyImport('add');
  if ('impcancel' in ds) { S.importPreview = null; renderSetup(); return; }
  if (ds.itemmore) { S.edOpen[ds.itemmore] = !S.edOpen[ds.itemmore]; renderSetup(); const f = main.querySelector(`[data-itemfield="group"][data-id="${CSS.escape(ds.itemmore)}"]`); f && f.focus(); return; }
  if (ds.mvitem != null) { const sec = secsOf(ds.k).find(x => x.id === ds.of), i = +ds.mvitem, j = i + (+ds.dir); if (!sec || j < 0 || j >= sec.items.length) return; [sec.items[i], sec.items[j]] = [sec.items[j], sec.items[i]]; saveConfig(); renderSetup(); const f = main.querySelector(`[data-mvitem="${j}"][data-of="${CSS.escape(ds.of)}"][data-dir="${ds.dir}"]`); f && !f.disabled && f.focus(); return; }
  if (ds.additem) { const sec = secsOf(ds.k).find(s => s.id === ds.additem); const last = sec.items[sec.items.length - 1]; const it = { id: uid(), text: '' }; if (last && last.group) it.group = last.group; sec.items.push(it); saveConfig(); renderSetup(); const f = main.querySelector(`[data-itemtext="${it.id}"]`); f && f.focus(); return; }
  if (ds.delitem) {
    if (S.armed !== 'i' + ds.delitem) { arm('i' + ds.delitem); renderSetup(); return; }
    const sec = secsOf(ds.k).find(s => s.id === ds.of); sec.items = sec.items.filter(i => i.id !== ds.delitem); S.armed = null; saveConfig(); renderSetup(); toast('Point removed'); return;
  }
});
document.body.addEventListener('click', e => {
  const t = e.target.closest('.cl-bar button'); if (!t) return;
  if ('submit' in t.dataset) submitDraft(t);
  if ('completejob' in t.dataset) completeJob(t);
  if ('dofix' in t.dataset) doFix(t);
  if ('backfx' in t.dataset) { flushAll(); closeFix(); renderFixes(); window.scrollTo(0, 0); }
  if ('backjob' in t.dataset) { flushAll(); closeJob(); render(); window.scrollTo(0, 0); }
  if ('back' in t.dataset) { closeDraft(); render(); window.scrollTo(0, 0); }
});
main.addEventListener('input', e => {
  const t = e.target, ds = t.dataset;
  if ('jobnote' in ds && S.job) { S.job.note = t.value; saveJob(1200); return; }
  if ('fxnote' in ds && S.fix) { S.fix.fixNote = t.value; saveFix(1200); return; }
  if ('note' in ds && S.draft) {
    const id = t.closest('[data-item]').dataset.item;
    const a = S.draft.answers[id] || (S.draft.answers[id] = {});
    a.note = t.value; saveDraft(900); updateProgress(); return;
  }
  if (ds.sectitle) { const s = secsOf(ds.k).find(x => x.id === ds.sectitle); s.title = t.value; saveConfig(); return; }
  if (ds.itemtext) { const s = secsOf(ds.k).find(x => x.id === ds.of); const it = s.items.find(x => x.id === ds.itemtext); it.text = t.value; saveConfig(); return; }
  if (ds.itemfield) { const s = secsOf(ds.k).find(x => x.id === ds.of); const it = s && s.items.find(x => x.id === ds.id); if (!it) return; const v = t.value; if (v.trim()) it[ds.itemfield] = v; else delete it[ds.itemfield]; saveConfig(); return; }
});
main.addEventListener('change', e => {
  const t = e.target, ds = t.dataset;
  if ('photo' in ds) { const id = t.closest('[data-item]').dataset.item; addPhotos(id, [...t.files]); t.value = ''; return; }
  if ('jobphoto' in ds) { addJobPhotos([...t.files]); t.value = ''; return; }
  if ('fxphoto' in ds) { addFixPhotos([...t.files]); t.value = ''; return; }
  if (ds.tick && S.job) { if (t.checked) S.job.checks[ds.tick] = true; else delete S.job.checks[ds.tick]; t.closest('.tick').classList.toggle('on', t.checked); saveJob(800); updateJobProgress(); return; }
  if (ds.recf) {
    S.recF[ds.recf] = t.value;
    if (ds.recf === 'from' || ds.recf === 'to') { S.rec = null; renderCleaning(); loadRecords().then(renderCleaning); } else renderCleaning();
    return;
  }
  if ('import' in ds) { const f = t.files && t.files[0]; t.value = ''; if (f) importFile(f, ds.k); return; }
  if (ds.activewh) { const w = S.config.warehouses.find(x => x.id === ds.activewh); w.active = t.checked; saveConfig(0); renderSetup(); return; }
  if (ds.scopeall) { const m = S.config.managers.find(x => x.id === ds.scopeall); m.scope = t.checked ? 'all' : []; saveConfig(0); renderSetup(); return; }
  if (ds.scope) { const m = S.config.managers.find(x => x.id === ds.scope); const set = new Set(m.scope); t.checked ? set.add(t.value) : set.delete(t.value); m.scope = [...set]; saveConfig(0); return; }
  if (ds.urole) return updateUser(ds.urole, { role: t.value }, 'Role updated');
  if (ds.uwh) {
    const ids = [...main.querySelectorAll(`input[data-uwh="${ds.uwh}"]:checked`)].map(x => x.value);
    return updateUser(ds.uwh, { warehouses: ids }, 'Warehouses updated');
  }
  if (ds.schedcell) {
    const id = ds.schedcell, d = +ds.day, on = t.checked, wh = t.value;
    return editSchedule(id, sc => {
      const wk = S.schedWeek[id] || FC.isoWeek(new Date());
      const plan = sc.mode === 'weekly' ? (sc.weeks[wk] = sc.weeks[wk] || {}) : sc.days;
      const set = new Set(plan[d] || []); on ? set.add(wh) : set.delete(wh);
      if (set.size) plan[d] = [...set]; else delete plan[d];
    });
  }
  if (ds.uactive) return updateUser(ds.uactive, { active: t.checked }, t.checked ? 'User activated' : 'User deactivated and signed out');
});
main.addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  const id = e.target.id;
  const map = { whName: addWarehouse, whCode: addWarehouse, whLoc: addWarehouse, mName: addManager, mEmail: addManager, lEmail: doLogin, lPw: doLogin, aPw: doSetup, uPw: addUser, pwNew: changePassword };
  if (map[id]) { e.preventDefault(); map[id](); }
});

/* ---------- Weeks and refresh ---------- */
async function changeWeek(n) {
  const nw = n === 0 ? THIS_WEEK : shiftWeek(S.week, n);
  if (nw > THIS_WEEK) return;
  S.week = nw; S.inspections = {}; S.report = null; S.weekLoaded = false;
  if (S.tab === 'reports') history.replaceState(null, '', `#reports${nw !== THIS_WEEK ? '/' + nw : ''}`);
  render(); await loadWeek(); render();
}
setInterval(async () => {
  if (!S.user || S.draft || document.hidden) return;
  if (S.tab === 'setup' || S.tab === 'account' || S.job) return;
  if (isCleanerUser()) { await loadCleaner(); if (!S.job && (S.tab === 'today')) render(); return; }
  if (S.tab === 'cleaning') { await loadRecords(); if (S.tab === 'cleaning') renderCleaning(); return; }
  await loadWeek(); if (!S.draft && (S.tab === 'inspect' || S.tab === 'reports')) render();
}, 30000);
window.addEventListener('beforeunload', e => { if (Object.keys(writers).some(pending)) { e.preventDefault(); e.returnValue = ''; } });


/* ---------- Boot ---------- */
(async function boot() {
  const m = location.hash.match(/^#(reports|setup|account|cleaning|today|schedule|fixes)(?:\/(\d{4}-W\d{2}))?/);
  if (m) { S.tab = m[1]; if (m[2] && m[2] <= THIS_WEEK) S.week = m[2]; }
  try {
    const r = await api('GET', '/api/me');
    S.needsSetup = r.needsSetup; setThisWeek(r.thisWeek);
    if (!r.user) return renderAuth();
    await signedIn(r.user);
    if (S.tab === 'setup' && S.canEdit) loadUsers();
  } catch (e) {
    main.innerHTML = `<div class="empty"><h2>Can’t reach the server</h2><p>${esc(e.message)}</p><button class="btn primary" onclick="location.reload()">Try again</button></div>`;
  }
})();
})();
