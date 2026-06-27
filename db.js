/* ------------------------------------------------------------------
   db.js — database setup, schema, shared taxonomy, and seed data.
   Uses Node's built-in SQLite (node:sqlite) so there is no native
   build step: a plain `npm install` is enough to run the project.
------------------------------------------------------------------- */
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const bcrypt = require('bcryptjs');

const db = new DatabaseSync(path.join(__dirname, 'fixit.db'));
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

/* ------------------------------------------------------------------
   Shared taxonomy.
   The SAME category keys are used for (a) the problems clients post
   and (b) the skills fixers register. That shared list is what makes
   the matching between a task and qualified fixers trivial.
------------------------------------------------------------------- */
const CATEGORIES = [
  { key: 'hardware', label: 'Hardware & crashes', emoji: '🖥️' },
  { key: 'os',       label: 'Operating system',   emoji: '🐌' },
  { key: 'network',  label: 'Wi-Fi & networking', emoji: '📶' },
  { key: 'security', label: 'Virus & security',   emoji: '🛡️' },
  { key: 'web',      label: 'Website development', emoji: '🌐' },
  { key: 'backend',  label: 'Backend & APIs',     emoji: '⚙️' },
  { key: 'mobile',   label: 'Phone & apps',       emoji: '📱' },
  { key: 'data',     label: 'Data recovery',      emoji: '💾' },
  { key: 'other',    label: 'Something else',     emoji: '✨' },
];
const CATEGORY_KEYS = new Set(CATEGORIES.map(c => c.key));
const labelFor = (key) => (CATEGORIES.find(c => c.key === key) || {}).label || key;

/* ------------------------------------------------------------------
   Schema
------------------------------------------------------------------- */
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  role          TEXT NOT NULL CHECK (role IN ('client','fixer','manager','admin')),
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  phone         TEXT,
  password_hash TEXT NOT NULL,
  bio           TEXT,
  experience    TEXT,
  hourly_rate   INTEGER,
  work_mode     TEXT,
  is_primary    INTEGER NOT NULL DEFAULT 0,   -- the one un-demotable seed admin
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A fixer's qualifications (category keys). Many rows per fixer.
CREATE TABLE IF NOT EXISTS fixer_skills (
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  PRIMARY KEY (user_id, category)
);

CREATE TABLE IF NOT EXISTS tasks (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id        INTEGER NOT NULL REFERENCES users(id),
  category         TEXT NOT NULL,
  custom_category  TEXT,                  -- free-text problem type (when category = 'other')
  title            TEXT NOT NULL,
  description      TEXT NOT NULL,
  photo_path       TEXT,
  urgency          TEXT,
  proposed_price   INTEGER,            -- price the client named
  counter_price    INTEGER,            -- manager's adjusted price (if any)
  manager_note     TEXT,               -- manager's explanation of the price
  agreed_price     INTEGER,            -- the price both sides settled on
  status           TEXT NOT NULL DEFAULT 'submitted',
  manager_id       INTEGER REFERENCES users(id),
  assigned_fixer_id INTEGER REFERENCES users(id),
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Lightweight audit trail so every screen can show "what happened".
CREATE TABLE IF NOT EXISTS task_events (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id   INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  actor_id  INTEGER REFERENCES users(id),
  text      TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

/*
  Task status lifecycle
  ---------------------
  submitted        -> client posted it; waiting for a manager
  price_countered  -> manager proposed a different price; waiting for client
  declined         -> client rejected the countered price (dead end)
  open             -> price agreed; broadcast to qualified fixers
  assigned         -> a fixer claimed it (first to accept wins)
  work_done        -> fixer marked it solved; waiting for client confirmation
  completed        -> client confirmed it is fixed
  cancelled        -> manager/admin cancelled it
*/

/* Migration: add custom_category to older databases that predate it. */
{
  const cols = db.prepare(`PRAGMA table_info(tasks)`).all().map(c => c.name);
  if (!cols.includes('custom_category')) db.exec(`ALTER TABLE tasks ADD COLUMN custom_category TEXT`);
}

/* ------------------------------------------------------------------
   Seed data (only on first run / empty DB)
------------------------------------------------------------------- */
function seed() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (count > 0) return;

  const hash = (pw) => bcrypt.hashSync(pw, 10);
  const insUser = db.prepare(`
    INSERT INTO users (role,name,email,phone,password_hash,bio,experience,hourly_rate,work_mode,is_primary)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `);
  const insSkill = db.prepare('INSERT INTO fixer_skills (user_id,category) VALUES (?,?)');

  // The single primary admin.
  insUser.run('admin', 'FixIT Admin', 'admin@fixit.app', null, hash('admin123'),
              null, null, null, null, 1);

  // A manager.
  insUser.run('manager', 'Morgan Lee', 'manager@fixit.app', null, hash('manager123'),
              'Triages incoming problems and sets fair prices.', null, null, null, 0);

  // A couple of fixers with skills.
  const fixerA = insUser.run('fixer', 'Alex Rivera', 'alex@fixit.app', null, hash('fixer123'),
    '6 years in IT support. Fast with Windows crashes and Wi-Fi issues.', '6+ years', 35, 'Remote & in person', 0).lastInsertRowid;
  ['hardware','os','network','security'].forEach(c => insSkill.run(fixerA, c));

  const fixerB = insUser.run('fixer', 'Sam Patel', 'sam@fixit.app', null, hash('fixer123'),
    'Full-stack developer. Websites, APIs, and mobile apps.', '3–6 years', 45, 'Remote only', 0).lastInsertRowid;
  ['web','backend','mobile','data'].forEach(c => insSkill.run(fixerB, c));

  // A demo client.
  insUser.run('client', 'Jordan Smith', 'client@fixit.app', '+1 555 0100', hash('client123'),
              null, null, null, null, 0);

  console.log('[seed] Created demo accounts (see README for logins).');
}
seed();

module.exports = { db, CATEGORIES, CATEGORY_KEYS, labelFor };
