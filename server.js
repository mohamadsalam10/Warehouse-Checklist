const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { q, init, getSetting, setSetting } = require('./db');
const { sendMail, provider } = require('./mailer');
const { buildEmail, buildReportFile, subjectFor } = require('./report');
const FC = require('./public/shared.js');

const PORT = process.env.PORT || 3000;
const SECRET = process.env.SESSION_SECRET || (() => {
  console.warn('SESSION_SECRET is not set. Using a random one: sessions and email photo links reset on every restart.');
  return crypto.randomBytes(32).toString('hex');
})();
const APP_URL = (process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
const SESSION_DAYS = 30;
const MAX_ATTACH_BYTES = 15 * 1024 * 1024;

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY' });
  next();
});

/* ---------- Helpers ---------- */
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return salt.toString('hex') + ':' + crypto.scryptSync(pw, salt, 64).toString('hex');
}
function verifyPassword(pw, stored) {
  const [s, h] = String(stored).split(':');
  if (!s || !h) return false;
  const a = crypto.scryptSync(pw, Buffer.from(s, 'hex'), 64), b = Buffer.from(h, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const photoSig = id => crypto.createHmac('sha256', SECRET).update('photo:' + id).digest('hex').slice(0, 32);
const photoUrl = id => `${APP_URL}/p/${id}?s=${photoSig(id)}`;
const isEmail = e => typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim());
const str = (v, max = 300) => String(v == null ? '' : v).trim().slice(0, max);
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const fail = (status, message) => { throw new HttpError(status, message); };

function cookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
  return out;
}
function setSessionCookie(req, res, token, maxAgeSec) {
  const parts = [`fc_sid=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSec}`];
  if (req.secure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}
async function startSession(req, res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  await q(`INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, now() + interval '${SESSION_DAYS} days')`, [sha(token), userId]);
  setSessionCookie(req, res, token, SESSION_DAYS * 86400);
}
const publicUser = u => ({ id: u.id, name: u.name, email: u.email, role: u.role, active: u.active, warehouses: Array.isArray(u.warehouses) ? u.warehouses : [], schedule: cleanSchedule(u.schedule) });
// Supervisors only see and inspect the warehouses assigned to them; admins see all.
const canInspect = (u, whId) => u.role === 'admin' || (u.role === 'supervisor' && Array.isArray(u.warehouses) && u.warehouses.includes(whId));
const ROLES = ['admin', 'supervisor', 'cleaner'];
const cleanWhList = v => Array.isArray(v) ? [...new Set(v.filter(x => typeof x === 'string' && /^[a-z0-9]{4,40}$/i.test(x)))].slice(0, 200) : [];

/* ---------- Session + CSRF ---------- */
app.use('/api', express.json({ limit: '4mb' }));
app.use('/api', wrap(async (req, res, next) => {
  // Mutating API calls must carry the X-FC header (blocks cross-site form posts).
  if (req.method !== 'GET' && req.headers['x-fc'] !== '1') fail(403, 'Request blocked.');
  const token = cookies(req).fc_sid;
  if (token) {
    const r = await q(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = $1 AND s.expires_at > now() AND u.active`, [sha(token)]);
    if (r.rowCount) req.user = r.rows[0];
  }
  next();
}));
const auth = (req, res, next) => req.user ? next() : next(new HttpError(401, 'Sign in to continue.'));
const admin = (req, res, next) => req.user && req.user.role === 'admin' ? next() : next(new HttpError(403, 'Only admins can do this.'));

/* ---------- Auth ---------- */
const attempts = new Map();
function rateLimit(key) {
  const now = Date.now(), a = attempts.get(key) || { n: 0, t: now };
  if (now - a.t > 15 * 60 * 1000) { a.n = 0; a.t = now; }
  a.n++; attempts.set(key, a);
  if (a.n > 10) fail(429, 'Too many sign-in attempts. Try again in 15 minutes.');
}

app.get('/api/me', wrap(async (req, res) => {
  const n = await q('SELECT count(*)::int AS n FROM users');
  res.json({ user: req.user ? publicUser(req.user) : null, needsSetup: n.rows[0].n === 0 });
}));

app.post('/api/auth/setup', wrap(async (req, res) => {
  const n = await q('SELECT count(*)::int AS n FROM users');
  if (n.rows[0].n > 0) fail(409, 'Setup is already complete. Sign in instead.');
  const name = str(req.body.name, 120), email = str(req.body.email, 200).toLowerCase(), pw = String(req.body.password || '');
  if (!name) fail(400, 'Enter your name.');
  if (!isEmail(email)) fail(400, 'Enter a valid email address.');
  if (pw.length < 8) fail(400, 'Use a password of at least 8 characters.');
  const r = await q(`INSERT INTO users (email, name, role, password_hash) VALUES ($1, $2, 'admin', $3) RETURNING *`, [email, name, hashPassword(pw)]);
  const cfg = await getSetting('config', null);
  if (!cfg) await setSetting('config', { warehouses: [], managers: [], sections: FC.standardSections() });
  await startSession(req, res, r.rows[0].id);
  res.json({ user: publicUser(r.rows[0]) });
}));

app.post('/api/auth/login', wrap(async (req, res) => {
  rateLimit(req.ip);
  const email = str(req.body.email, 200).toLowerCase(), pw = String(req.body.password || '');
  const r = await q('SELECT * FROM users WHERE email = $1 AND active', [email]);
  if (!r.rowCount || !verifyPassword(pw, r.rows[0].password_hash)) fail(401, 'That email and password don’t match.');
  attempts.delete(req.ip);
  await startSession(req, res, r.rows[0].id);
  res.json({ user: publicUser(r.rows[0]) });
}));

app.post('/api/auth/logout', wrap(async (req, res) => {
  const token = cookies(req).fc_sid;
  if (token) await q('DELETE FROM sessions WHERE token = $1', [sha(token)]);
  setSessionCookie(req, res, '', 0);
  res.json({ ok: true });
}));

app.put('/api/me/password', auth, wrap(async (req, res) => {
  const cur = String(req.body.current || ''), next = String(req.body.next || '');
  if (!verifyPassword(cur, req.user.password_hash)) fail(400, 'Your current password is incorrect.');
  if (next.length < 8) fail(400, 'Use a new password of at least 8 characters.');
  await q('UPDATE users SET password_hash = $1 WHERE id = $2', [hashPassword(next), req.user.id]);
  await q('DELETE FROM sessions WHERE user_id = $1', [req.user.id]);
  await startSession(req, res, req.user.id);
  res.json({ ok: true });
}));

/* ---------- Users (admin) ---------- */
app.get('/api/users', admin, wrap(async (req, res) => {
  const r = await q('SELECT * FROM users ORDER BY role, name');
  res.json({ users: r.rows.map(publicUser) });
}));
app.post('/api/users', admin, wrap(async (req, res) => {
  const name = str(req.body.name, 120), email = str(req.body.email, 200).toLowerCase(), pw = String(req.body.password || '');
  const role = ROLES.includes(req.body.role) ? req.body.role : 'supervisor';
  if (!name) fail(400, 'Enter a name.');
  if (!isEmail(email)) fail(400, 'Enter a valid email address.');
  if (pw.length < 8) fail(400, 'Use a password of at least 8 characters.');
  const ex = await q('SELECT 1 FROM users WHERE email = $1', [email]);
  if (ex.rowCount) fail(409, 'A user with that email already exists.');
  const r = await q('INSERT INTO users (email, name, role, password_hash, warehouses, schedule) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *', [email, name, role, hashPassword(pw), JSON.stringify(cleanWhList(req.body.warehouses)), JSON.stringify(cleanSchedule(req.body.schedule))]);
  if (role === 'cleaner') await syncDay(localDate(), { prune: true });
  res.json({ user: publicUser(r.rows[0]) });
}));
async function assertAdminRemains(exceptId) {
  const r = await q(`SELECT count(*)::int AS n FROM users WHERE role = 'admin' AND active AND id <> $1`, [exceptId]);
  if (r.rows[0].n === 0) fail(400, 'Keep at least one active admin.');
}
app.put('/api/users/:id', admin, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const r = await q('SELECT * FROM users WHERE id = $1', [id]);
  if (!r.rowCount) fail(404, 'User not found.');
  const u = r.rows[0], b = req.body;
  const name = b.name != null ? str(b.name, 120) || u.name : u.name;
  const role = ROLES.includes(b.role) ? b.role : u.role;
  const active = typeof b.active === 'boolean' ? b.active : u.active;
  if (u.role === 'admin' && u.active && (role !== 'admin' || !active)) await assertAdminRemains(id);
  let hash = u.password_hash;
  if (b.password) { if (String(b.password).length < 8) fail(400, 'Use a password of at least 8 characters.'); hash = hashPassword(String(b.password)); }
  const whs = b.warehouses !== undefined ? cleanWhList(b.warehouses) : (Array.isArray(u.warehouses) ? u.warehouses : []);
  const sched = b.schedule !== undefined ? cleanSchedule(b.schedule) : cleanSchedule(u.schedule);
  const out = await q('UPDATE users SET name = $1, role = $2, active = $3, password_hash = $4, warehouses = $5, schedule = $6 WHERE id = $7 RETURNING *', [name, role, active, hash, JSON.stringify(whs), JSON.stringify(sched), id]);
  if (b.schedule !== undefined || b.role !== undefined || typeof b.active === 'boolean') await syncDay(localDate(), { prune: true });
  if (!active || b.password) await q('DELETE FROM sessions WHERE user_id = $1', [id]);
  res.json({ user: publicUser(out.rows[0]) });
}));
app.delete('/api/users/:id', admin, wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) fail(400, 'You can’t delete your own account.');
  const r = await q('SELECT * FROM users WHERE id = $1', [id]);
  if (!r.rowCount) fail(404, 'User not found.');
  if (r.rows[0].role === 'admin') await assertAdminRemains(id);
  await q('DELETE FROM users WHERE id = $1', [id]);
  res.json({ ok: true });
}));

/* ---------- Config: warehouses, managers, checklist ---------- */
const EMPTY_CONFIG = { warehouses: [], managers: [], sections: [], cleaning: { sections: [] } };
const idOk = v => typeof v === 'string' && /^[a-z0-9]{4,40}$/i.test(v);
function cleanConfig(c) {
  const warehouses = (Array.isArray(c.warehouses) ? c.warehouses : []).filter(w => idOk(w.id) && str(w.name)).slice(0, 200)
    .map(w => ({ id: w.id, name: str(w.name, 120), code: str(w.code, 40), location: str(w.location, 200), active: w.active !== false }));
  const whIds = new Set(warehouses.map(w => w.id));
  const managers = (Array.isArray(c.managers) ? c.managers : []).filter(m => idOk(m.id) && str(m.name) && isEmail(m.email)).slice(0, 200)
    .map(m => ({ id: m.id, name: str(m.name, 120), email: str(m.email, 200), scope: Array.isArray(m.scope) ? m.scope.filter(x => whIds.has(x)) : 'all' }));
  const sections = (Array.isArray(c.sections) ? c.sections : []).filter(s => idOk(s.id)).slice(0, 60)
    .map(s => ({ id: s.id, title: str(s.title, 120) || 'Untitled section', items: (Array.isArray(s.items) ? s.items : []).filter(i => idOk(i.id)).slice(0, 200).map(i => { const o = { id: i.id, text: str(i.text, 300) }; const g = str(i.group, 80), c = str(i.category, 60), a = str(i.action, 300); if (g) o.group = g; if (c) o.category = c; if (a) o.action = a; return o; }) }));
  const cleaning = { sections: cleanSections(c.cleaning && c.cleaning.sections, false) };
  return { warehouses, managers, sections, cleaning };
}
function cleanSections(list, full) {
  return (Array.isArray(list) ? list : []).filter(s => idOk(s.id)).slice(0, 60)
    .map(s => ({ id: s.id, title: str(s.title, 120) || 'Untitled section', items: (Array.isArray(s.items) ? s.items : []).filter(i => idOk(i.id)).slice(0, 200).map(i => { const o = { id: i.id, text: str(i.text, 300) }; const g = str(i.group, 80); if (g) o.group = g; if (full) { const c = str(i.category, 60), a = str(i.action, 300); if (c) o.category = c; if (a) o.action = a; } return o; }) }));
}
const getConfig = async () => Object.assign({}, EMPTY_CONFIG, await getSetting('config', EMPTY_CONFIG));
const getSender = async () => Object.assign({ name: 'Facility Check', email: process.env.MAIL_FROM || '', replyTo: '' }, await getSetting('sender', {}));

app.get('/api/config', auth, wrap(async (req, res) => {
  let config = await getConfig();
  if (req.user.role === 'supervisor') config = { warehouses: config.warehouses.filter(w => canInspect(req.user, w.id)), sections: config.sections, managers: [], cleaning: { sections: [] } };
  else if (req.user.role === 'cleaner') config = { warehouses: [], sections: [], managers: [], cleaning: { sections: [] } };
  const out = { config };
  if (req.user.role === 'admin') out.sender = await getSender(), out.mail = { provider: provider(), appUrl: APP_URL };
  res.json(out);
}));
app.put('/api/config', admin, wrap(async (req, res) => {
  const config = cleanConfig(req.body || {});
  await setSetting('config', config);
  await syncDay(localDate(), { prune: true });
  res.json({ config });
}));

/* ---------- Sender (admin) ---------- */
app.put('/api/settings/sender', admin, wrap(async (req, res) => {
  const s = { name: str(req.body.name, 120), email: str(req.body.email, 200), replyTo: str(req.body.replyTo, 200) };
  if (s.email && !isEmail(s.email)) fail(400, 'Enter a valid sender email.');
  if (s.replyTo && !isEmail(s.replyTo)) fail(400, 'Enter a valid reply-to email.');
  await setSetting('sender', s);
  res.json({ sender: s });
}));
app.post('/api/settings/test-email', admin, wrap(async (req, res) => {
  const to = str(req.body.to, 200) || req.user.email;
  if (!isEmail(to)) fail(400, 'Enter a valid email address.');
  const s = await getSender();
  try {
    await sendMail({
      fromName: s.name, fromEmail: s.email, replyTo: s.replyTo, to,
      subject: 'Facility Check test email',
      text: 'This is a test from Facility Check. Weekly reports will be sent from this address.',
      html: '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px">This is a test from Facility Check. Weekly reports will be sent from this address.</div>'
    });
  } catch (e) { fail(502, e.message); }
  res.json({ ok: true, to });
}));

/* ---------- Inspections ---------- */
const SEVS = ['minor', 'major', 'critical'];
const photoIdOk = v => typeof v === 'string' && /^[a-f0-9]{32}$/.test(v);
function cleanAnswers(a) {
  const out = {};
  if (!a || typeof a !== 'object') return out;
  Object.keys(a).slice(0, 2000).forEach(k => {
    if (!idOk(k)) return;
    const v = a[k] || {};
    const o = {};
    if (['pass', 'fail', 'na'].includes(v.s)) o.s = v.s;
    if (SEVS.includes(v.sev)) o.sev = v.sev;
    if (v.note) o.note = String(v.note).slice(0, 2000);
    if (Array.isArray(v.photos)) o.photos = v.photos.filter(photoIdOk).slice(0, 12);
    out[k] = o;
  });
  return out;
}
const rowToInsp = r => ({
  id: r.id, week: r.week, warehouseId: r.warehouse_id, warehouseName: r.warehouse_name, warehouseCode: r.warehouse_code,
  sections: r.sections, answers: r.answers, status: r.status, startedBy: r.started_by, submittedBy: r.submitted_by,
  submittedByName: r.submitted_by_name || null, submittedAt: r.submitted_at ? +r.submitted_at : null, updatedAt: +r.updated_at
});
async function weekInspections(week) {
  const r = await q(`SELECT i.*, u.name AS submitted_by_name FROM inspections i LEFT JOIN users u ON u.id = i.submitted_by WHERE i.week = $1`, [week]);
  return r.rows.map(rowToInsp);
}
const rowToReport = r => r ? ({ status: r.status, trigger: r.trigger, sentAt: r.sent_at ? +r.sent_at : null, recipients: r.recipients, error: r.error, attempts: r.attempts, updatedAt: +r.updated_at }) : null;
function checkWeek(week) { if (!FC.isWeekKey(week)) fail(400, 'That week isn’t valid.'); }

app.get('/api/weeks/:week', auth, wrap(async (req, res) => {
  checkWeek(req.params.week);
  if (req.user.role === 'cleaner') return res.json({ inspections: [], report: null, mailConfigured: true });
  const [all, rep] = await Promise.all([weekInspections(req.params.week), q('SELECT * FROM reports WHERE week = $1', [req.params.week])]);
  const admin = req.user.role === 'admin';
  const inspections = admin ? all : all.filter(i => canInspect(req.user, i.warehouseId));
  res.json({ inspections, report: admin ? rowToReport(rep.rows[0]) : null, mailConfigured: !!provider() });
}));

async function upsertDraft(req) {
  const { week, wh } = req.params;
  checkWeek(week);
  if (week > FC.isoWeek(new Date())) fail(400, 'You can’t inspect a future week.');
  if (!canInspect(req.user, wh)) fail(403, 'This warehouse isn’t assigned to you. Ask an admin.');
  const answers = cleanAnswers(req.body.answers);
  const ex = await q('SELECT * FROM inspections WHERE week = $1 AND warehouse_id = $2', [week, wh]);
  if (ex.rowCount) {
    if (ex.rows[0].status === 'submitted') fail(409, 'This inspection is submitted. Reopen it to make changes.');
    const r = await q('UPDATE inspections SET answers = $1, updated_at = now() WHERE id = $2 RETURNING *', [JSON.stringify(answers), ex.rows[0].id]);
    return r.rows[0];
  }
  const cfg = await getConfig();
  const w = cfg.warehouses.find(x => x.id === wh && x.active !== false);
  if (!w) fail(404, 'That warehouse isn’t active.');
  if (!cfg.sections.length) fail(400, 'The checklist is empty. An admin needs to add points in Setup.');
  const r = await q(`INSERT INTO inspections (week, warehouse_id, warehouse_name, warehouse_code, sections, answers, started_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (week, warehouse_id) DO UPDATE SET answers = EXCLUDED.answers, updated_at = now() WHERE inspections.status = 'draft'
    RETURNING *`, [week, wh, w.name, w.code || '', JSON.stringify(cfg.sections), JSON.stringify(answers), req.user.id]);
  if (!r.rowCount) fail(409, 'This inspection is submitted. Reopen it to make changes.');
  return r.rows[0];
}

app.put('/api/inspections/:week/:wh', auth, wrap(async (req, res) => {
  const row = await upsertDraft(req);
  res.json({ inspection: rowToInsp(row) });
}));

app.post('/api/inspections/:week/:wh/submit', auth, wrap(async (req, res) => {
  const row = await upsertDraft(req);
  const st = FC.stats(row);
  const left = st.total - st.answered;
  if (left) fail(400, `${left} point${left === 1 ? '' : 's'} still ${left === 1 ? 'needs' : 'need'} checking.`);
  if (st.noteMissing) fail(400, `${st.noteMissing} failed point${st.noteMissing === 1 ? ' needs' : 's need'} a note.`);
  const r = await q(`UPDATE inspections SET status = 'submitted', submitted_by = $1, submitted_at = now(), updated_at = now() WHERE id = $2 RETURNING *`, [req.user.id, row.id]);
  const week = req.params.week;
  const done = await weekComplete(week);
  res.json({ inspection: rowToInsp(Object.assign(r.rows[0], { submitted_by_name: req.user.name })), weekComplete: done });
  if (done) setImmediate(() => sendWeek(week, { trigger: 'auto' }).catch(e => console.error('Auto-send failed:', e)));
}));

app.post('/api/inspections/:week/:wh/reopen', auth, wrap(async (req, res) => {
  checkWeek(req.params.week);
  if (!canInspect(req.user, req.params.wh)) fail(403, 'This warehouse isn’t assigned to you. Ask an admin.');
  const r = await q(`UPDATE inspections SET status = 'draft', submitted_by = NULL, submitted_at = NULL, updated_at = now()
    WHERE week = $1 AND warehouse_id = $2 RETURNING *`, [req.params.week, req.params.wh]);
  if (!r.rowCount) fail(404, 'Inspection not found.');
  res.json({ inspection: rowToInsp(r.rows[0]) });
}));

/* ---------- Photos ---------- */
app.post('/api/photos', auth, express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: '10mb' }), wrap(async (req, res) => {
  if (!Buffer.isBuffer(req.body) || !req.body.length) fail(400, 'Send a JPG, PNG or WebP photo.');
  const id = crypto.randomBytes(16).toString('hex');
  await q('INSERT INTO photos (id, mime, data, uploaded_by) VALUES ($1, $2, $3, $4)', [id, req.headers['content-type'].split(';')[0], req.body, req.user.id]);
  res.json({ id });
}));
async function sendPhoto(id, res) {
  if (!photoIdOk(id)) return res.status(404).end();
  const r = await q('SELECT mime, data FROM photos WHERE id = $1', [id]);
  if (!r.rowCount) return res.status(404).end();
  res.set({ 'Content-Type': r.rows[0].mime, 'Cache-Control': 'private, max-age=604800, immutable' });
  res.send(r.rows[0].data);
}
app.get('/api/photos/:id', auth, wrap(async (req, res) => sendPhoto(req.params.id, res)));
// Signed link used in emails, so managers can see photos without signing in.
app.get('/p/:id', wrap(async (req, res) => {
  const s = String(req.query.s || '');
  const good = photoSig(req.params.id);
  if (s.length !== good.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(good))) return res.status(404).end();
  return sendPhoto(req.params.id, res);
}));

/* ---------- Reports ---------- */
async function weekComplete(week) {
  const cfg = await getConfig();
  const active = cfg.warehouses.filter(w => w.active !== false);
  if (!active.length) return false;
  const r = await q(`SELECT warehouse_id FROM inspections WHERE week = $1 AND status = 'submitted'`, [week]);
  const done = new Set(r.rows.map(x => x.warehouse_id));
  return active.every(w => done.has(w.id));
}
async function photoDataFor(rows) {
  const ids = [];
  rows.forEach(({ i }) => { if (i && i.status === 'submitted') i.sections.forEach(sec => sec.items.forEach(it => { const a = i.answers[it.id]; if (a && a.photos) ids.push(...a.photos); })); });
  if (!ids.length) return { map: {}, bytes: 0 };
  const r = await q('SELECT id, mime, data FROM photos WHERE id = ANY($1)', [ids]);
  const map = {}; let bytes = 0;
  r.rows.forEach(p => { map[p.id] = `data:${p.mime};base64,${p.data.toString('base64')}`; bytes += p.data.length; });
  return { map, bytes };
}

/*
 * Sends the week's report to every manager. trigger 'auto' runs once per week (on the final submit);
 * trigger 'manual' is the admin's Send now / Resend.
 */
async function sendWeek(week, { trigger }) {
  // Claim the send so two requests can't both send.
  const claim = trigger === 'auto'
    ? await q(`INSERT INTO reports (week, status, trigger, updated_at) VALUES ($1, 'sending', 'auto', now()) ON CONFLICT (week) DO NOTHING RETURNING *`, [week])
    : await q(`INSERT INTO reports (week, status, trigger, updated_at) VALUES ($1, 'sending', 'manual', now())
               ON CONFLICT (week) DO UPDATE SET status = 'sending', trigger = 'manual', updated_at = now()
               WHERE reports.status <> 'sending' OR reports.updated_at < now() - interval '3 minutes' RETURNING *`, [week]);
  if (!claim.rowCount) return { skipped: true };

  const recipients = [];
  let error = null;
  try {
    const [cfg, sender, inspections] = await Promise.all([getConfig(), getSender(), weekInspections(week)]);
    const rows = FC.weekRows(cfg, inspections);
    if (!cfg.managers.length) throw new Error('No managers are set up. Add them in Setup.');
    if (!provider()) throw new Error('No email provider is configured on the server. Set RESEND_API_KEY or SMTP_HOST.');
    if (!sender.email) throw new Error('No sender email is set. Add one in Setup.');
    for (const m of cfg.managers) {
      const mine = FC.managerRows(m, rows);
      if (!mine.length) { recipients.push({ name: m.name, email: m.email, ok: false, error: 'No warehouses assigned' }); continue; }
      const { map, bytes } = await photoDataFor(mine);
      const attach = bytes <= MAX_ATTACH_BYTES;
      const mail = buildEmail({ week, rows, manager: m, appUrl: APP_URL, photoUrl, attachmentNote: attach });
      const attachments = attach ? [{ filename: `Facility-inspection-${week}.html`, content: Buffer.from(buildReportFile({ week, rows: mine, photoData: map })), contentType: 'text/html' }] : [];
      try {
        await sendMail({ fromName: sender.name, fromEmail: sender.email, replyTo: sender.replyTo, to: m.email, subject: mail.subject, html: mail.html, text: mail.text, attachments });
        recipients.push({ name: m.name, email: m.email, ok: true });
      } catch (e) {
        recipients.push({ name: m.name, email: m.email, ok: false, error: String(e.message || e).slice(0, 300) });
      }
    }
    const sentOk = recipients.filter(r => r.ok).length;
    if (!sentOk) error = recipients.map(r => r.error).filter(Boolean)[0] || 'No emails were sent.';
    else if (sentOk < recipients.length) error = `${recipients.length - sentOk} of ${recipients.length} emails failed.`;
  } catch (e) { error = String(e.message || e).slice(0, 500); }

  const ok = recipients.some(r => r.ok);
  await q(`UPDATE reports SET status = $2, sent_at = CASE WHEN $3 THEN now() ELSE sent_at END, recipients = $4, error = $5, attempts = attempts + 1, updated_at = now() WHERE week = $1`,
    [week, ok ? (error ? 'partial' : 'sent') : 'failed', ok, JSON.stringify(recipients), error]);
  if (error) console.error(`Report for ${week}: ${error}`);
  return { ok, error, recipients };
}

app.post('/api/reports/:week/send', admin, wrap(async (req, res) => {
  checkWeek(req.params.week);
  const r = await sendWeek(req.params.week, { trigger: 'manual' });
  if (r.skipped) fail(409, 'This report is already being sent. Check again in a minute.');
  const rep = await q('SELECT * FROM reports WHERE week = $1', [req.params.week]);
  res.json({ report: rowToReport(rep.rows[0]) });
}));

app.get('/api/reports/:week/download', admin, wrap(async (req, res) => {
  checkWeek(req.params.week);
  const week = req.params.week;
  const rows = FC.weekRows(await getConfig(), await weekInspections(week));
  const { map } = await photoDataFor(rows);
  res.set({ 'Content-Type': 'text/html; charset=utf-8', 'Content-Disposition': `attachment; filename="Facility-inspection-${week}.html"` });
  res.send(buildReportFile({ week, rows, photoData: map }));
}));


/* ---------- Cleaning: schedules, daily work orders, records ---------- */
const TZ = process.env.APP_TIMEZONE || 'Asia/Dubai';
const localDate = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const isDateKey = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(Date.parse(v + 'T00:00:00Z'));
const weekdayOf = date => new Date(date + 'T00:00:00Z').getUTCDay() || 7; // 1 = Monday ... 7 = Sunday
const addDays = (date, n) => { const d = new Date(date + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
/*
 * A cleaner's schedule:
 *   { mode: 'recurring' | 'weekly',
 *     days:  { 1: [warehouse ids], ... 7: [...] }          // recurring: the same every week (1 = Monday)
 *     weeks: { '2026-W47': { 1: [...], ... } } }          // weekly: one plan per ISO week; ends with the week
 * Old schedules (a list of {days, warehouses} lines) are converted to recurring.
 */
function cleanDays(o) {
  const out = {};
  for (let d = 1; d <= 7; d++) { const l = cleanWhList(o && (o[d] || o[String(d)])); if (l.length) out[d] = l; }
  return out;
}
function cleanSchedule(v) {
  if (Array.isArray(v)) {
    const days = {};
    v.forEach(r => (r && Array.isArray(r.days) ? r.days : []).forEach(d => { days[d] = [...new Set([...(days[d] || []), ...((r && r.warehouses) || [])])]; }));
    return { mode: 'recurring', days: cleanDays(days), weeks: {} };
  }
  const weeks = {};
  Object.keys((v && v.weeks) || {}).filter(FC.isWeekKey).sort().slice(-60).forEach(k => { const d = cleanDays(v.weeks[k]); if (Object.keys(d).length) weeks[k] = d; });
  return { mode: v && v.mode === 'weekly' ? 'weekly' : 'recurring', days: cleanDays(v && v.days), weeks };
}
const isoWeekOf = date => { const [y, m, d] = date.split('-').map(Number); return FC.isoWeek(new Date(y, m - 1, d)); };
function warehousesFor(schedule, date) {
  const s = cleanSchedule(schedule), wd = weekdayOf(date);
  return s.mode === 'weekly' ? ((s.weeks[isoWeekOf(date)] || {})[wd] || []) : (s.days[wd] || []);
}
const isCleaner = (req, res, next) => req.user && req.user.role === 'cleaner' ? next() : next(new HttpError(403, 'Only cleaners can do this.'));

/* Creates the day's work orders from each cleaner's schedule. prune (today only) also removes
   untouched orders that are no longer scheduled and refreshes their checklist. */
async function syncDay(date, { prune }) {
  const cfg = await getConfig();
  const whMap = {}; cfg.warehouses.filter(w => w.active !== false).forEach(w => { whMap[w.id] = w; });
  const sections = JSON.stringify((cfg.cleaning && cfg.cleaning.sections) || []);
  const wd = weekdayOf(date);
  const cleaners = (await q(`SELECT id, schedule FROM users WHERE role = 'cleaner' AND active`)).rows;
  const keep = new Set();
  for (const c of cleaners) {
    const want = new Set(warehousesFor(c.schedule, date).filter(id => whMap[id]));
    for (const id of want) {
      keep.add(c.id + ':' + id);
      const w = whMap[id];
      await q(`INSERT INTO cleaning_jobs (job_date, cleaner_id, warehouse_id, warehouse_name, warehouse_location, sections)
               VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (job_date, cleaner_id, warehouse_id) DO NOTHING`,
        [date, c.id, id, w.name, w.location || '', sections]);
    }
  }
  if (!prune) return;
  const untouched = `status = 'open' AND checks = '{}'::jsonb AND photos = '[]'::jsonb AND note = '' AND started_at IS NULL`;
  const rows = (await q(`SELECT id, cleaner_id, warehouse_id FROM cleaning_jobs WHERE job_date = $1 AND ${untouched}`, [date])).rows;
  const drop = rows.filter(r => !keep.has(r.cleaner_id + ':' + r.warehouse_id)).map(r => r.id);
  if (drop.length) await q('DELETE FROM cleaning_jobs WHERE id = ANY($1)', [drop]);
  await q(`UPDATE cleaning_jobs SET sections = $2 WHERE job_date = $1 AND ${untouched}`, [date, sections]);
}
let lastEnsure = 0, ensuring = null;
/* Called whenever someone opens cleaning screens: fills in any days since the last run (max 14). */
async function ensureCleaningJobs(force) {
  if (!force && Date.now() - lastEnsure < 60000) return ensuring;
  lastEnsure = Date.now();
  ensuring = (async () => {
    const today = localDate();
    const through = await getSetting('cleaningThrough', null);
    let d = through ? addDays(through, 1) : today;
    if (d < addDays(today, -14)) d = addDays(today, -14);
    for (; d < today; d = addDays(d, 1)) await syncDay(d, { prune: false });
    await syncDay(today, { prune: true });
    await setSetting('cleaningThrough', today);
  })();
  return ensuring;
}
const rowToJob = r => ({
  id: r.id, date: r.job_date instanceof Date ? r.job_date.toISOString().slice(0, 10) : String(r.job_date).slice(0, 10),
  cleanerId: r.cleaner_id, cleanerName: r.cleaner_name || '', warehouseId: r.warehouse_id, warehouseName: r.warehouse_name, location: r.warehouse_location,
  sections: r.sections, checks: r.checks, photos: r.photos, note: r.note, status: r.status,
  startedAt: r.started_at ? +r.started_at : null, completedAt: r.completed_at ? +r.completed_at : null, updatedAt: +r.updated_at
});
function cleanChecks(v, sections) {
  const ids = new Set(); (sections || []).forEach(s => s.items.forEach(i => ids.add(i.id)));
  const out = {}; if (v && typeof v === 'object') Object.keys(v).forEach(k => { if (ids.has(k) && v[k] === true) out[k] = true; });
  return out;
}
const cleanPhotos = v => (Array.isArray(v) ? v : []).filter(p => /^[a-f0-9]{32}$/.test(p)).slice(0, 20);
async function ownJob(req) {
  const r = await q(`SELECT j.*, u.name AS cleaner_name FROM cleaning_jobs j JOIN users u ON u.id = j.cleaner_id WHERE j.id = $1`, [Number(req.params.id)]);
  if (!r.rowCount) fail(404, 'Work order not found.');
  const j = r.rows[0];
  if (req.user.role !== 'admin' && j.cleaner_id !== req.user.id) fail(403, 'This work order isn’t yours.');
  return j;
}
const jobDate = j => rowToJob(j).date;

// Cleaner: today's work orders and the weekly schedule
app.get('/api/cleaner/today', isCleaner, wrap(async (req, res) => {
  await ensureCleaningJobs();
  const today = localDate();
  const jobs = (await q(`SELECT j.*, $3::text AS cleaner_name FROM cleaning_jobs j WHERE job_date = $1 AND cleaner_id = $2 ORDER BY warehouse_location, warehouse_name`, [today, req.user.id, req.user.name])).rows.map(rowToJob);
  const cfg = await getConfig();
  const whMap = {}; cfg.warehouses.forEach(w => { whMap[w.id] = w; });
  const sched = cleanSchedule(req.user.schedule);
  // Next 7 days from the schedule (today included), so cleaners can plan ahead
  const upcoming = [];
  for (let i = 0; i < 7; i++) {
    const d = addDays(today, i), wd = weekdayOf(d);
    const list = warehousesFor(sched, d).filter(id => whMap[id] && whMap[id].active !== false).map(id => ({ id, name: whMap[id].name, location: whMap[id].location || '' }));
    list.sort((a, b) => (a.location || '').localeCompare(b.location || '') || a.name.localeCompare(b.name));
    upcoming.push({ date: d, weekday: wd, warehouses: list });
  }
  res.json({ date: today, weekday: weekdayOf(today), jobs, mode: sched.mode, upcoming, checklist: (cfg.cleaning && cfg.cleaning.sections) || [] });
}));
async function saveJob(req, complete) {
  const j = await ownJob(req);
  if (req.user.role === 'cleaner' && jobDate(j) !== localDate()) fail(400, 'You can only update today’s work orders.');
  if (j.status === 'done') fail(409, 'This work order is already done. Reopen it to make changes.');
  const checks = cleanChecks(req.body.checks, j.sections), photos = cleanPhotos(req.body.photos), note = str(req.body.note, 1000);
  let status = 'open', completedAt = null;
  if (complete) {
    const total = (j.sections || []).reduce((n, s) => n + s.items.length, 0), left = total - Object.keys(checks).length;
    if (left && !note) fail(400, `${left} point${left === 1 ? ' isn’t' : 's aren’t'} ticked. Tick ${left === 1 ? 'it' : 'them'}, or add a note explaining why.`);
    status = 'done'; completedAt = new Date();
  }
  const r = await q(`UPDATE cleaning_jobs SET checks = $2, photos = $3, note = $4, status = $5, completed_at = $6,
      started_at = COALESCE(started_at, now()), updated_at = now() WHERE id = $1 RETURNING *`,
    [j.id, JSON.stringify(checks), JSON.stringify(photos), note, status, completedAt]);
  return rowToJob(Object.assign(r.rows[0], { cleaner_name: j.cleaner_name }));
}
app.put('/api/cleaning/jobs/:id', auth, wrap(async (req, res) => res.json({ job: await saveJob(req, false) })));
app.post('/api/cleaning/jobs/:id/complete', auth, wrap(async (req, res) => res.json({ job: await saveJob(req, true) })));
app.post('/api/cleaning/jobs/:id/reopen', auth, wrap(async (req, res) => {
  const j = await ownJob(req);
  if (req.user.role === 'cleaner' && jobDate(j) !== localDate()) fail(400, 'You can only reopen today’s work orders.');
  const r = await q(`UPDATE cleaning_jobs SET status = 'open', completed_at = NULL, updated_at = now() WHERE id = $1 RETURNING *`, [j.id]);
  res.json({ job: rowToJob(Object.assign(r.rows[0], { cleaner_name: j.cleaner_name })) });
}));

// Admin: cleaning records for review
app.get('/api/cleaning/records', admin, wrap(async (req, res) => {
  await ensureCleaningJobs();
  const today = localDate();
  const to = isDateKey(req.query.to) ? req.query.to : today;
  let from = isDateKey(req.query.from) ? req.query.from : to;
  if (from > to) from = to;
  if (from < addDays(to, -92)) from = addDays(to, -92);
  const r = await q(`SELECT j.*, u.name AS cleaner_name FROM cleaning_jobs j JOIN users u ON u.id = j.cleaner_id
                     WHERE job_date BETWEEN $1 AND $2 ORDER BY job_date DESC, u.name, warehouse_location, warehouse_name`, [from, to]);
  res.json({ today, from, to, jobs: r.rows.map(rowToJob) });
}));

/* ---------- Static app ---------- */
app.get('/healthz', (req, res) => res.json({ ok: true }));
// no-cache: browsers check for a newer version on every load, so updates show up straight after a deploy
app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html', etag: true, lastModified: true, setHeaders: res => res.setHeader('Cache-Control', 'no-cache') }));
app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

/* ---------- Errors ---------- */
app.use((err, req, res, next) => {
  const status = err.status || (err.type === 'entity.too.large' ? 413 : 500);
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status === 413 ? 'That file is too large.' : status >= 500 && !(err instanceof HttpError) ? 'Something went wrong on the server.' : err.message });
});

init().then(() => {
  app.listen(PORT, () => console.log(`Facility Check running on port ${PORT}`));
}).catch(e => { console.error('Database setup failed:', e); process.exit(1); });
