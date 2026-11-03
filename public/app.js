(function () {
'use strict';
const { esc, cap, uid, stats, issuesOf, otherPhotos, isoWeek, shiftWeek, weekNo, weekRangeText, fmtDate, fmtDateTime, weekRows, managerRows, standardSections, STANDARD } = window.FC;
const main = document.getElementById('main');
const LABEL = { pass: 'Pass', fail: 'Fail', na: 'N/A' };
const SEVS = ['minor', 'major', 'critical'];
const clone = o => JSON.parse(JSON.stringify(o));
const THIS_WEEK = isoWeek(new Date());

const S = {
  user: null, needsSetup: false, canEdit: false,
  config: null, sender: null, mail: null, users: null,
  week: THIS_WEEK, inspections: {}, weekLoaded: false, report: null, mailConfigured: true,
  tab: 'inspect', draft: null, itemMap: {}, collapsed: {}, expanded: {}, uploading: {},
  editWh: null, armed: null, readOnly: false, stale: false, sending: false
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

/* ---------- Tabs ---------- */
function renderTabs() {
  const el = document.getElementById('tabs');
  if (!S.user) { el.innerHTML = ''; return; }
  const tabs = [['inspect', 'Inspect'], ['reports', 'Reports']];
  if (S.canEdit) tabs.push(['setup', 'Setup']);
  tabs.push(['account', 'Account']);
  el.innerHTML = tabs.map(([k, l]) => `<button class="tab" data-tab="${k}" ${S.tab === k ? 'aria-current="page"' : ''}>${l}</button>`).join('');
}
document.getElementById('tabs').addEventListener('click', e => { const b = e.target.closest('[data-tab]'); if (b) goTab(b.dataset.tab); });
function goTab(t) {
  if (S.draft) closeDraft();
  S.tab = t; S.armed = null; S.editWh = null;
  history.replaceState(null, '', t === 'inspect' ? location.pathname : `#${t}${t === 'reports' && S.week !== THIS_WEEK ? '/' + S.week : ''}`);
  renderTabs(); render(); window.scrollTo(0, 0);
  if (t === 'setup' && S.canEdit) loadUsers();
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
  main.innerHTML = '<div class="loading">Loading…</div>';
  await loadConfig();
  renderTabs();
  await loadWeek();
  render();
}
async function signOut() {
  await flushAll();
  try { await api('POST', '/api/auth/logout'); } catch (e) {}
  S.user = null; S.draft = null; S.config = null; S.tab = 'inspect';
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
    S.inspections = m; S.report = r.report; S.mailConfigured = r.mailConfigured; S.weekLoaded = true;
  } catch (e) { S.weekLoaded = true; if (e.status !== 401) toast(e.message); }
}
async function loadUsers() {
  try { const r = await api('GET', '/api/users'); S.users = r.users; if (S.tab === 'setup' && !S.draft && !setupFocused()) renderSetup(); } catch (e) {}
}
const setupFocused = () => main.contains(document.activeElement) && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);

/* ---------- Main render ---------- */
function render() {
  if (!S.user) return renderAuth();
  if (!S.config) { main.innerHTML = '<div class="loading">Loading…</div>'; return; }
  if (S.draft) return;
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
  if (!whs.length) {
    main.innerHTML = weekHeader() + `<div class="empty"><h2>No warehouses yet</h2><p>${S.canEdit ? 'Add your warehouses, managers and supervisors in Setup to start the weekly checks.' : 'An admin needs to add warehouses before inspections can start.'}</p>${S.canEdit ? '<button class="btn primary" data-go="setup">Open Setup</button>' : ''}</div>`;
    return;
  }
  const done = whs.filter(w => S.inspections[w.id] && S.inspections[w.id].status === 'submitted').length;
  let html = weekHeader();
  html += S.weekLoaded ? `<p class="progress-line"><strong>${done} of ${whs.length}</strong> warehouses inspected this week</p>` : `<p class="progress-line">Loading this week’s inspections…</p>`;
  if (!(S.config.sections || []).length) html += `<div class="banner info"><div>The checklist is empty.${S.canEdit ? ' Add checklist points in Setup first.' : ' Ask an admin to set it up.'}</div>${S.canEdit ? '<button class="btn" data-go="setup">Open Setup</button>' : ''}</div>`;
  if (S.weekLoaded && done === whs.length) {
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
    return `<li><button class="wh ${cls}" data-open="${esc(w.id)}"><span class="wh-name">${esc(w.name)}</span><span class="wh-meta">${esc([w.code, w.location].filter(Boolean).join(', ')) || '&nbsp;'}</span><span class="wh-status">${status}</span></button></li>`;
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
    ${sec.items.map(it => itemHTML(it, ro)).join('')}</div></section>`;
}
function itemHTML(it, ro) {
  const a = S.draft.answers[it.id] || {};
  const s = a.s, photos = a.photos || [];
  const show = s === 'fail' || (a.note || '').trim() || photos.length || S.expanded[it.id] || S.uploading[it.id];
  let extra = '';
  if (show) {
    extra = `<div class="extra">
      ${s === 'fail' ? `<div class="sev" role="group" aria-label="Severity"><span class="sev-label">Severity</span>${SEVS.map(v => `<button type="button" class="chip ${v}" data-sev="${v}" aria-pressed="${(a.sev || 'major') === v}" ${ro ? 'disabled' : ''}>${cap(v)}</button>`).join('')}</div>` : ''}
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
    <p class="hint">When the last warehouse is submitted, each manager is emailed the results for their warehouses, with photos and the full report attached.</p>
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
      ${iss.length ? '<ul class="issues">' + iss.map(x => `<li><div class="issue-top"><span class="tag ${x.a.sev || 'major'}">${cap(x.a.sev || 'major')}</span><strong>${esc(x.it.text)}</strong><span class="issue-sec">${esc(x.sec.title)}</span></div>
        ${x.a.note ? `<p class="issue-note">${esc(x.a.note)}</p>` : ''}
        ${x.a.photos && x.a.photos.length ? `<div class="photos" style="margin-top:8px">${x.a.photos.map(p => `<div class="ph"><img src="/api/photos/${esc(p)}" alt="Photo: ${esc(x.it.text)}" loading="lazy" data-view="${esc(p)}"></div>`).join('')}</div>` : ''}</li>`).join('') + '</ul>' : '<p class="ok-note">No issues found.</p>'}
      ${others.length ? `<h4>Other photos</h4><div class="gallery">${others.map(o => `<figure><img src="/api/photos/${esc(o.id)}" alt="Photo: ${esc(o.it.text)}" loading="lazy" data-view="${esc(o.id)}"><figcaption>${esc(o.it.text)}</figcaption></figure>`).join('')}</div>` : ''}
    </article>`;
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
  <section class="panel"><h2>Your details</h2><p class="hint" style="margin-bottom:0">${esc(S.user.email)}<br>Role: ${S.user.role === 'admin' ? 'Admin' : 'Supervisor'}</p></section>
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

/* ---------- Setup ---------- */
function renderSetup() {
  const c = S.config, whs = c.warehouses || [], mgrs = c.managers || [], secs = c.sections || [];
  const snd = S.sender || {}, mail = S.mail || {};
  let html = `<span class="eyebrow dash">Admin</span><h1 class="page-title">Setup</h1>`;

  html += `<section class="panel"><span class="eyebrow dash">Warehouses</span><h2>Warehouse locations</h2><p class="hint">The supervisor inspects every active warehouse each week. The report emails once all active warehouses are submitted.</p>
    <div class="add-row"><input type="text" id="whName" placeholder="Warehouse name" aria-label="Warehouse name"><input type="text" id="whCode" placeholder="Code (optional)" aria-label="Code"><input type="text" id="whLoc" placeholder="Location (optional)" aria-label="Location"><button class="btn primary" data-addwh>Add warehouse</button></div>
    ${whs.length ? '<ul class="rows">' + whs.map(w => S.editWh === w.id ? `<li><div class="add-row" style="margin:0"><input type="text" data-ew="name" value="${esc(w.name)}" aria-label="Name"><input type="text" data-ew="code" value="${esc(w.code || '')}" placeholder="Code" aria-label="Code"><input type="text" data-ew="location" value="${esc(w.location || '')}" placeholder="Location" aria-label="Location"><button class="btn primary" data-savewh="${esc(w.id)}">Save</button></div></li>` :
      `<li class="${w.active === false ? 'inactive' : ''}"><div class="row-main"><div class="grow"><div class="t">${esc(w.name)}</div><div class="m">${esc([w.code, w.location].filter(Boolean).join(', ')) || '&nbsp;'}</div></div>
      <label class="toggle"><input type="checkbox" data-activewh="${esc(w.id)}" ${w.active !== false ? 'checked' : ''}> Active</label>
      <button class="btn sm" data-editwh="${esc(w.id)}">Edit</button>
      <button class="btn sm danger ${S.armed === 'wh' + w.id ? 'armed' : ''}" data-delwh="${esc(w.id)}">${S.armed === 'wh' + w.id ? 'Confirm delete' : 'Delete'}</button></div></li>`).join('') + '</ul>' : '<p class="muted">No warehouses yet.</p>'}
  </section>`;

  html += `<section class="panel"><span class="eyebrow dash">Managers</span><h2>Report recipients</h2><p class="hint">Managers receive the weekly report by email for the warehouses assigned to them. They don’t need an account.</p>
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

  html += `<section class="panel"><span class="eyebrow dash">Email</span><h2>Sender</h2>
    <p class="hint">Reports are sent from this address. Your email provider must allow it: verify its domain in Resend, or use the mailbox your SMTP login belongs to.</p>
    ${mail.provider ? `<div class="status-box ok"><strong>Email provider: ${mail.provider === 'resend' ? 'Resend' : 'SMTP'}</strong>${mail.appUrl ? `<p>Links in emails point to ${esc(mail.appUrl)}</p>` : '<p>Set APP_URL on the server so email links point to this app.</p>'}</div>` : `<div class="status-box bad"><strong>No email provider is configured on the server.</strong><p>Add RESEND_API_KEY, or SMTP_HOST, SMTP_USER and SMTP_PASS, in your host’s environment settings, then redeploy.</p></div>`}
    <div class="grid2" style="margin-bottom:8px"><input type="text" id="sName" value="${esc(snd.name || '')}" placeholder="Sender name, e.g. storage.ae Operations" aria-label="Sender name"><input type="email" id="sEmail" value="${esc(snd.email || '')}" placeholder="Sender email, e.g. facilities@storage.ae" aria-label="Sender email"></div>
    <div class="grid2"><input type="email" id="sReply" value="${esc(snd.replyTo || '')}" placeholder="Reply-to email (optional)" aria-label="Reply-to email"><div><button class="btn primary" data-savesender>Save sender</button></div></div>
    <p class="err-text" id="sErr" hidden></p>
    <div class="grid2" style="margin-top:16px"><input type="email" id="tTo" value="${esc(S.user.email)}" aria-label="Send test email to"><div><button class="btn" data-testmail ${mail.provider ? '' : 'disabled'}>Send test email</button></div></div>
  </section>`;

  const users = S.users;
  html += `<section class="panel"><span class="eyebrow dash">People</span><h2>Users</h2>
    <p class="hint">Supervisors sign in to fill in checklists. Admins also manage this Setup page. Give each person a temporary password; they can change it under Account.</p>
    <div class="add-row" style="grid-template-columns:1.1fr 1.4fr .9fr 1.1fr auto"><input type="text" id="uName" placeholder="Name" aria-label="User name"><input type="email" id="uEmail" placeholder="Email" aria-label="User email">
      <select id="uRole" aria-label="Role"><option value="supervisor">Supervisor</option><option value="admin">Admin</option></select>
      <input type="text" id="uPw" placeholder="Temporary password" aria-label="Temporary password"><button class="btn primary" data-adduser>Add user</button></div>
    <p class="err-text" id="uErr" hidden></p>
    ${!users ? '<p class="muted">Loading users…</p>' : '<ul class="rows">' + users.map(u => `<li class="${u.active ? '' : 'inactive'}"><div class="row-main"><div class="grow"><div class="t">${esc(u.name)}${u.id === S.user.id ? ' (you)' : ''}</div><div class="m">${esc(u.email)}</div></div>
      <select data-urole="${u.id}" aria-label="Role for ${esc(u.name)}" ${u.id === S.user.id ? 'disabled' : ''}><option value="supervisor" ${u.role === 'supervisor' ? 'selected' : ''}>Supervisor</option><option value="admin" ${u.role === 'admin' ? 'selected' : ''}>Admin</option></select>
      ${u.id === S.user.id ? '' : `<label class="toggle"><input type="checkbox" data-uactive="${u.id}" ${u.active ? 'checked' : ''}> Active</label>
      <button class="btn sm" data-upw="${u.id}">Reset password</button>
      <button class="btn sm danger ${S.armed === 'u' + u.id ? 'armed' : ''}" data-udel="${u.id}">${S.armed === 'u' + u.id ? 'Confirm delete' : 'Delete'}</button>`}</div>
      ${S.resetFor === u.id ? `<div class="grid2" style="margin-top:10px;max-width:560px"><input type="text" id="rPw" placeholder="New temporary password" aria-label="New password"><div><button class="btn primary" data-upwsave="${u.id}">Set password</button></div></div>` : ''}</li>`).join('') + '</ul>'}
  </section>`;

  html += `<section class="panel"><span class="eyebrow dash">Checklist</span><h2>Checklist points</h2><p class="hint">Edits apply to inspections started after you make them. Inspections already started keep the checklist they began with.</p>`;
  if (!secs.length) html += `<div class="empty" style="margin-bottom:12px"><h2>Start with the standard checklist</h2><p>${STANDARD.reduce((n, s) => n + s[1].length, 0)} points across security, fire safety, health and safety, racking, cleanliness, organisation, records and utilities. You can edit any of it.</p><button class="btn primary" data-std>Use standard checklist</button></div>`;
  html += secs.map((sec, si) => `<div class="ed-sec">
      <span class="eyebrow">Section ${String(si + 1).padStart(2, '0')}</span>
      <div class="ed-sec-head"><input type="text" data-sectitle="${esc(sec.id)}" value="${esc(sec.title)}" aria-label="Section title">
      <button class="icon-btn" data-mvsec="${si}" data-dir="-1" aria-label="Move section up" ${si === 0 ? 'disabled' : ''}>↑</button>
      <button class="icon-btn" data-mvsec="${si}" data-dir="1" aria-label="Move section down" ${si === secs.length - 1 ? 'disabled' : ''}>↓</button>
      <button class="icon-btn ${S.armed === 's' + sec.id ? 'armed' : ''}" data-delsec="${esc(sec.id)}" aria-label="Delete section" title="${S.armed === 's' + sec.id ? 'Click again to delete' : 'Delete section'}">×</button></div>
      ${sec.items.map(it => `<div class="ed-item"><input type="text" data-itemtext="${esc(it.id)}" data-of="${esc(sec.id)}" value="${esc(it.text)}" aria-label="Checklist point"><button class="icon-btn" data-delitem="${esc(it.id)}" data-of="${esc(sec.id)}" aria-label="Delete point">×</button></div>`).join('')}
      <button class="link-btn" data-additem="${esc(sec.id)}">+ Add point</button></div>`).join('');
  html += `<div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:6px"><button class="btn" data-addsec>+ Add section</button>
    ${secs.length ? `<button class="btn ghost ${S.armed === 'std' ? 'danger armed' : ''}" data-std>${S.armed === 'std' ? 'Confirm: replace with standard' : 'Restore standard checklist'}</button>` : ''}</div></section>`;
  main.innerHTML = html;
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
    toast('User added. Share their email and temporary password with them.');
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
    if ((S.config.sections || []).length && S.armed !== 'std') { arm('std'); renderSetup(); return; }
    S.config.sections = standardSections(); S.armed = null; saveConfig(0); renderSetup(); toast('Standard checklist loaded'); return;
  }
  if ('addsec' in ds) { const s = { id: uid(), title: 'New section', items: [{ id: uid(), text: '' }] }; S.config.sections.push(s); saveConfig(); renderSetup(); const f = main.querySelector(`[data-sectitle="${s.id}"]`); f && (f.focus(), f.select()); return; }
  if (ds.mvsec != null) { const i = +ds.mvsec, j = i + (+ds.dir), a = S.config.sections; if (j < 0 || j >= a.length) return; [a[i], a[j]] = [a[j], a[i]]; saveConfig(); renderSetup(); return; }
  if (ds.delsec) {
    if (S.armed !== 's' + ds.delsec) { arm('s' + ds.delsec); renderSetup(); return; }
    S.config.sections = S.config.sections.filter(s => s.id !== ds.delsec); S.armed = null; saveConfig(0); renderSetup(); return;
  }
  if (ds.additem) { const sec = S.config.sections.find(s => s.id === ds.additem); const it = { id: uid(), text: '' }; sec.items.push(it); saveConfig(); renderSetup(); const f = main.querySelector(`[data-itemtext="${it.id}"]`); f && f.focus(); return; }
  if (ds.delitem) { const sec = S.config.sections.find(s => s.id === ds.of); sec.items = sec.items.filter(i => i.id !== ds.delitem); saveConfig(); renderSetup(); return; }
});
document.body.addEventListener('click', e => {
  const t = e.target.closest('.cl-bar button'); if (!t) return;
  if ('submit' in t.dataset) submitDraft(t);
  if ('back' in t.dataset) { closeDraft(); render(); window.scrollTo(0, 0); }
});
main.addEventListener('input', e => {
  const t = e.target, ds = t.dataset;
  if ('note' in ds && S.draft) {
    const id = t.closest('[data-item]').dataset.item;
    const a = S.draft.answers[id] || (S.draft.answers[id] = {});
    a.note = t.value; saveDraft(900); updateProgress(); return;
  }
  if (ds.sectitle) { const s = S.config.sections.find(x => x.id === ds.sectitle); s.title = t.value; saveConfig(); return; }
  if (ds.itemtext) { const s = S.config.sections.find(x => x.id === ds.of); const it = s.items.find(x => x.id === ds.itemtext); it.text = t.value; saveConfig(); return; }
});
main.addEventListener('change', e => {
  const t = e.target, ds = t.dataset;
  if ('photo' in ds) { const id = t.closest('[data-item]').dataset.item; addPhotos(id, [...t.files]); t.value = ''; return; }
  if (ds.activewh) { const w = S.config.warehouses.find(x => x.id === ds.activewh); w.active = t.checked; saveConfig(0); renderSetup(); return; }
  if (ds.scopeall) { const m = S.config.managers.find(x => x.id === ds.scopeall); m.scope = t.checked ? 'all' : []; saveConfig(0); renderSetup(); return; }
  if (ds.scope) { const m = S.config.managers.find(x => x.id === ds.scope); const set = new Set(m.scope); t.checked ? set.add(t.value) : set.delete(t.value); m.scope = [...set]; saveConfig(0); return; }
  if (ds.urole) return updateUser(ds.urole, { role: t.value }, 'Role updated');
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
  if (S.tab === 'setup' || S.tab === 'account') return;
  await loadWeek(); if (!S.draft && (S.tab === 'inspect' || S.tab === 'reports')) render();
}, 30000);
window.addEventListener('beforeunload', e => { if (Object.keys(writers).some(pending)) { e.preventDefault(); e.returnValue = ''; } });


/* ---------- Boot ---------- */
(async function boot() {
  const m = location.hash.match(/^#(reports|setup|account)(?:\/(\d{4}-W\d{2}))?/);
  if (m) { S.tab = m[1]; if (m[2] && m[2] <= THIS_WEEK) S.week = m[2]; }
  try {
    const r = await api('GET', '/api/me');
    S.needsSetup = r.needsSetup;
    if (!r.user) return renderAuth();
    await signedIn(r.user);
    if (S.tab === 'setup' && S.canEdit) loadUsers();
  } catch (e) {
    main.innerHTML = `<div class="empty"><h2>Can’t reach the server</h2><p>${esc(e.message)}</p><button class="btn primary" onclick="location.reload()">Try again</button></div>`;
  }
})();
})();
