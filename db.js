/* ------------------------------------------------------------------
   db.js — database setup, schema, shared taxonomy, and seed data.

   Uses libSQL (@libsql/client) which speaks SQLite. Locally it runs
   against a file (fixit.db); in production set DATABASE_URL to a Turso
   database (libsql://...) + DATABASE_AUTH_TOKEN. Same SQL either way.
------------------------------------------------------------------- */
const { createClient } = require('@libsql/client');
const bcrypt = require('bcryptjs');

const url = process.env.DATABASE_URL || 'file:fixit.db';
const authToken = process.env.DATABASE_AUTH_TOKEN || undefined;
const db = createClient(authToken ? { url, authToken } : { url });

/* tiny async query helpers (positional ? args, same as before) */
async function run(sql, args = []) { return db.execute({ sql, args }); }
async function get(sql, args = []) { const r = await db.execute({ sql, args }); return r.rows[0] || null; }
async function all(sql, args = []) { const r = await db.execute({ sql, args }); return r.rows; }

/* ------------------------------------------------------------------
   Shared taxonomy — the SAME keys are used for the problems clients
   post and the skills fixers register, which makes matching trivial.
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

const SCHEMA = `
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
  avatar        TEXT,
  is_primary    INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS fixer_skills (
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  PRIMARY KEY (user_id, category)
);
CREATE TABLE IF NOT EXISTS tasks (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id        INTEGER NOT NULL REFERENCES users(id),
  category         TEXT NOT NULL,
  custom_category  TEXT,
  title            TEXT NOT NULL,
  description      TEXT NOT NULL,
  photo_path       TEXT,
  urgency          TEXT,
  proposed_price   INTEGER,
  counter_price    INTEGER,
  manager_note     TEXT,
  agreed_price     INTEGER,
  paid             INTEGER NOT NULL DEFAULT 0,
  paid_at          TEXT,
  card_last4       TEXT,
  rating           INTEGER,
  rating_comment   TEXT,
  rated_at         TEXT,
  status           TEXT NOT NULL DEFAULT 'submitted',
  manager_id       INTEGER REFERENCES users(id),
  assigned_fixer_id INTEGER REFERENCES users(id),
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS task_events (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id   INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  actor_id  INTEGER REFERENCES users(id),
  text      TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tasks_status     ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_client     ON tasks(client_id);
CREATE INDEX IF NOT EXISTS idx_tasks_fixer      ON tasks(assigned_fixer_id);
CREATE INDEX IF NOT EXISTS idx_tasks_manager    ON tasks(manager_id);
CREATE INDEX IF NOT EXISTS idx_tasks_created    ON tasks(created_at);
CREATE INDEX IF NOT EXISTS idx_tasks_rating     ON tasks(assigned_fixer_id, rating);
CREATE INDEX IF NOT EXISTS idx_events_task      ON task_events(task_id);
CREATE INDEX IF NOT EXISTS idx_fixer_skills_cat ON fixer_skills(category);
CREATE INDEX IF NOT EXISTS idx_users_role       ON users(role);
`;

async function columns(table) {
  const r = await db.execute(`PRAGMA table_info(${table})`);
  return r.rows.map(c => c.name);
}

async function seed() {
  const r = await db.execute(`SELECT COUNT(*) AS n FROM users`);
  if (Number(r.rows[0].n) > 0) return;
  const h = (pw) => bcrypt.hashSync(pw, 10);
  const insUser = async (role, name, email, phone, pw, bio, exp, rate, mode, primary) => {
    const res = await db.execute({
      sql: `INSERT INTO users (role,name,email,phone,password_hash,bio,experience,hourly_rate,work_mode,is_primary)
            VALUES (?,?,?,?,?,?,?,?,?,?) RETURNING id`,
      args: [role, name, email, phone, h(pw), bio, exp, rate, mode, primary],
    });
    return Number(res.rows[0].id);
  };
  const insSkill = (uid, cat) => db.execute({ sql: 'INSERT INTO fixer_skills (user_id,category) VALUES (?,?)', args: [uid, cat] });

  await insUser('admin', 'FixIT Admin', 'admin@fixit.app', null, 'admin123', null, null, null, null, 1);
  await insUser('manager', 'Morgan Lee', 'manager@fixit.app', null, 'manager123', 'Triages incoming problems and sets fair prices.', null, null, null, 0);
  const a = await insUser('fixer', 'Alex Rivera', 'alex@fixit.app', null, 'fixer123', '6 years in IT support. Fast with Windows crashes and Wi-Fi issues.', '6+ years', 35, 'Remote & in person', 0);
  for (const c of ['hardware', 'os', 'network', 'security']) await insSkill(a, c);
  const s = await insUser('fixer', 'Sam Patel', 'sam@fixit.app', null, 'fixer123', 'Full-stack developer. Websites, APIs, and mobile apps.', '3–6 years', 45, 'Remote only', 0);
  for (const c of ['web', 'backend', 'mobile', 'data']) await insSkill(s, c);
  await insUser('client', 'Jordan Smith', 'client@fixit.app', '+1 555 0100', 'client123', null, null, null, null, 0);
  console.log('[seed] Created demo accounts (see README for logins).');
}

let initPromise = null;
async function init() {
  await db.executeMultiple(SCHEMA);
  // Migrations for databases that predate newer columns.
  const t = await columns('tasks');
  const addsT = { custom_category: 'TEXT', paid: 'INTEGER NOT NULL DEFAULT 0', paid_at: 'TEXT',
    card_last4: 'TEXT', rating: 'INTEGER', rating_comment: 'TEXT', rated_at: 'TEXT' };
  for (const [c, def] of Object.entries(addsT)) if (!t.includes(c)) await db.execute(`ALTER TABLE tasks ADD COLUMN ${c} ${def}`);
  const u = await columns('users');
  if (!u.includes('avatar')) await db.execute(`ALTER TABLE users ADD COLUMN avatar TEXT`);
  await seed();
}
/* ready resolves once the schema/seed are in place (idempotent, cached). */
function ready() { return (initPromise = initPromise || init()); }

module.exports = { db, run, get, all, ready, CATEGORIES, CATEGORY_KEYS, labelFor };
