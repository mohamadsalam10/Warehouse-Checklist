const { Pool } = require('pg');

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set. Point it at a Postgres database.');
  process.exit(1);
}

// SSL: Render's internal hostnames (no dots, e.g. dpg-abc123-a) and localhost don't need it; external hosts do.
function sslFor(u) {
  if (process.env.DATABASE_SSL === 'false') return false;
  if (process.env.DATABASE_SSL === 'true') return { rejectUnauthorized: false };
  try {
    const host = new URL(u).hostname;
    if (host === 'localhost' || host === '127.0.0.1' || !host.includes('.')) return false;
  } catch (e) { return false; }
  return { rejectUnauthorized: false };
}

const pool = new Pool({ connectionString: url, ssl: sslFor(url), max: 10 });
const q = (text, params) => pool.query(text, params);

async function init() {
  await q(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin','supervisor')),
      password_hash TEXT NOT NULL,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS inspections (
      id SERIAL PRIMARY KEY,
      week TEXT NOT NULL,
      warehouse_id TEXT NOT NULL,
      warehouse_name TEXT NOT NULL,
      warehouse_code TEXT NOT NULL DEFAULT '',
      sections JSONB NOT NULL,
      answers JSONB NOT NULL DEFAULT '{}'::jsonb,
      status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted')),
      started_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      submitted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      submitted_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (week, warehouse_id)
    );
    CREATE INDEX IF NOT EXISTS inspections_week ON inspections (week);
    CREATE TABLE IF NOT EXISTS photos (
      id TEXT PRIMARY KEY,
      mime TEXT NOT NULL,
      data BYTEA NOT NULL,
      uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS reports (
      week TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      trigger TEXT,
      sent_at TIMESTAMPTZ,
      recipients JSONB NOT NULL DEFAULT '[]'::jsonb,
      error TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await q(`ALTER TABLE users ADD COLUMN IF NOT EXISTS warehouses JSONB NOT NULL DEFAULT '[]'::jsonb`);
  await q(`DELETE FROM sessions WHERE expires_at < now()`);
}

async function getSetting(key, fallback) {
  const r = await q('SELECT value FROM settings WHERE key = $1', [key]);
  return r.rowCount ? r.rows[0].value : fallback;
}
async function setSetting(key, value) {
  await q(`INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, now())
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [key, JSON.stringify(value)]);
}

module.exports = { pool, q, init, getSetting, setSetting };
