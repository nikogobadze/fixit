/* ------------------------------------------------------------------
   server.js — FixIT API + static host.
   Run with:  npm install  then  npm start
------------------------------------------------------------------- */
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { db, CATEGORIES, CATEGORY_KEYS, labelFor } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'fixit-dev-secret-change-me';
const COOKIE = 'fixit_token';

app.use(express.json());
app.use(cookieParser());

/* ---------- uploads ---------- */
const UPLOAD_DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = (path.extname(file.originalname) || '.jpg').toLowerCase().slice(0, 8);
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 }, // 8 MB
  fileFilter: (req, file, cb) => cb(null, /^image\//.test(file.mimetype)),
});

/* ---------- prepared statements ---------- */
const Q = {
  userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
  userById:    db.prepare('SELECT * FROM users WHERE id = ?'),
  insUser: db.prepare(`INSERT INTO users
      (role,name,email,phone,password_hash,bio,experience,hourly_rate,work_mode)
      VALUES (?,?,?,?,?,?,?,?,?)`),
  insSkill:    db.prepare('INSERT OR IGNORE INTO fixer_skills (user_id,category) VALUES (?,?)'),
  skillsFor:   db.prepare('SELECT category FROM fixer_skills WHERE user_id = ?'),
  clearSkills: db.prepare('DELETE FROM fixer_skills WHERE user_id = ?'),

  insTask: db.prepare(`INSERT INTO tasks
      (client_id,category,custom_category,title,description,photo_path,urgency,proposed_price,status)
      VALUES (?,?,?,?,?,?,?,?, 'submitted')`),
  taskById:   db.prepare('SELECT * FROM tasks WHERE id = ?'),
  tasksByClient: db.prepare('SELECT * FROM tasks WHERE client_id = ? ORDER BY created_at DESC'),
  submittedQueue: db.prepare(`SELECT * FROM tasks WHERE status = 'submitted' ORDER BY created_at ASC`),
  allTasks:   db.prepare('SELECT * FROM tasks ORDER BY created_at DESC'),
  openForCategory: db.prepare(`SELECT * FROM tasks WHERE status = 'open' ORDER BY created_at ASC`),
  fixerTasks: db.prepare(`SELECT * FROM tasks WHERE assigned_fixer_id = ? ORDER BY updated_at DESC`),
  touchTask:  db.prepare(`UPDATE tasks SET updated_at = datetime('now') WHERE id = ?`),

  insEvent: db.prepare('INSERT INTO task_events (task_id,actor_id,text) VALUES (?,?,?)'),
  eventsFor: db.prepare('SELECT * FROM task_events WHERE task_id = ? ORDER BY created_at ASC'),

  allUsers: db.prepare('SELECT * FROM users ORDER BY created_at ASC'),
  setRole:  db.prepare('UPDATE users SET role = ? WHERE id = ?'),
  countAdmins: db.prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin'`),
};

/* ---------- helpers ---------- */
function publicUser(u) {
  if (!u) return null;
  const skills = u.role === 'fixer' ? Q.skillsFor.all(u.id).map(r => r.category) : undefined;
  return {
    id: u.id, role: u.role, name: u.name, email: u.email, phone: u.phone || null,
    bio: u.bio || null, experience: u.experience || null,
    hourly_rate: u.hourly_rate || null, work_mode: u.work_mode || null,
    is_primary: !!u.is_primary, skills,
  };
}

function event(taskId, actorId, text) { Q.insEvent.run(taskId, actorId, text); }

function taskView(t, viewer) {
  const client = Q.userById.get(t.client_id);
  const fixer  = t.assigned_fixer_id ? Q.userById.get(t.assigned_fixer_id) : null;
  return {
    id: t.id,
    category: t.category,
    categoryLabel: t.custom_category ? t.custom_category : labelFor(t.category),
    title: t.title, description: t.description,
    photos: t.photo_path ? t.photo_path.split(',').filter(Boolean).map(f => `/uploads/${path.basename(f)}`) : [],
    urgency: t.urgency,
    proposed_price: t.proposed_price,
    counter_price: t.counter_price,
    manager_note: t.manager_note,
    agreed_price: t.agreed_price,
    status: t.status,
    created_at: t.created_at, updated_at: t.updated_at,
    client: { id: client.id, name: client.name },
    fixer: fixer ? { id: fixer.id, name: fixer.name } : null,
    events: Q.eventsFor.all(t.id).map(e => ({
      text: e.text,
      who: e.actor_id ? (Q.userById.get(e.actor_id) || {}).name : 'System',
      at: e.created_at,
    })),
  };
}

/* ---------- auth middleware ---------- */
function setAuthCookie(res, user) {
  const token = jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
  res.cookie(COOKIE, token, {
    httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 3600 * 1000,
  });
}
function currentUser(req) {
  const token = req.cookies[COOKIE];
  if (!token) return null;
  try {
    const { id } = jwt.verify(token, JWT_SECRET);
    return Q.userById.get(id) || null;
  } catch { return null; }
}
function auth(req, res, next) {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: 'Please log in.' });
  req.user = u; next();
}
const requireRole = (...roles) => (req, res, next) =>
  roles.includes(req.user.role) ? next() : res.status(403).json({ error: 'Not allowed for your role.' });

/* ==================================================================
   AUTH ROUTES
================================================================== */
app.get('/api/categories', (req, res) => res.json(CATEGORIES));

app.post('/api/auth/register/client', (req, res) => {
  const { name, email, phone, password } = req.body || {};
  if (!name || !email || !password) return res.status(400).json({ error: 'Name, email and password are required.' });
  if (Q.userByEmail.get(email)) return res.status(409).json({ error: 'That email is already registered.' });
  const r = Q.insUser.run('client', name.trim(), email.toLowerCase().trim(), phone || null,
    bcrypt.hashSync(password, 10), null, null, null, null);
  const user = Q.userById.get(r.lastInsertRowid);
  setAuthCookie(res, user);
  res.json({ user: publicUser(user) });
});

app.post('/api/auth/register/fixer', (req, res) => {
  const { name, email, password, bio, experience, hourly_rate, work_mode, skills, custom_skills } = req.body || {};
  if (!name || !email || !password) return res.status(400).json({ error: 'Name, email and password are required.' });
  // Built-in qualifications (category keys) + any free-text specialities they typed.
  const keys = Array.isArray(skills) ? skills.filter(s => CATEGORY_KEYS.has(s)) : [];
  const customs = (Array.isArray(custom_skills) ? custom_skills : [])
    .map(s => String(s || '').trim().slice(0, 40)).filter(Boolean);
  if (keys.length === 0 && customs.length === 0)
    return res.status(400).json({ error: 'Pick or type at least one thing you can fix.' });
  if (Q.userByEmail.get(email)) return res.status(409).json({ error: 'That email is already registered.' });
  const finalSkills = new Set(keys);
  customs.forEach(c => finalSkills.add(c));
  // Custom specialities also join the "Something else" pool so they get matched custom problems.
  if (customs.length) finalSkills.add('other');
  const r = Q.insUser.run('fixer', name.trim(), email.toLowerCase().trim(), null,
    bcrypt.hashSync(password, 10), bio || null, experience || null,
    hourly_rate ? parseInt(hourly_rate, 10) : null, work_mode || null);
  [...finalSkills].forEach(s => Q.insSkill.run(r.lastInsertRowid, s));
  const user = Q.userById.get(r.lastInsertRowid);
  setAuthCookie(res, user);
  res.json({ user: publicUser(user) });
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  const u = Q.userByEmail.get((email || '').toLowerCase().trim());
  if (!u || !bcrypt.compareSync(password || '', u.password_hash))
    return res.status(401).json({ error: 'Wrong email or password.' });
  setAuthCookie(res, u);
  res.json({ user: publicUser(u) });
});

app.post('/api/auth/logout', (req, res) => { res.clearCookie(COOKIE); res.json({ ok: true }); });

app.get('/api/me', (req, res) => {
  const u = currentUser(req);
  res.json({ user: publicUser(u) });
});

// Update your own profile (editable for every role; fields vary by role).
app.post('/api/profile', auth, (req, res) => {
  const u = req.user;
  const b = req.body || {};
  const name = (b.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Name is required.' });

  // Email (optional change, must stay unique)
  let email = u.email;
  if (b.email) {
    const e = b.email.toLowerCase().trim();
    if (e && e !== u.email) {
      const ex = Q.userByEmail.get(e);
      if (ex && ex.id !== u.id) return res.status(409).json({ error: 'That email is already in use.' });
      email = e;
    }
  }

  // Password (only when changing)
  let password_hash = u.password_hash;
  if (b.newPassword) {
    if (String(b.newPassword).length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters.' });
    if (!bcrypt.compareSync(b.currentPassword || '', u.password_hash))
      return res.status(400).json({ error: 'Your current password is incorrect.' });
    password_hash = bcrypt.hashSync(b.newPassword, 10);
  }

  const phone = (b.phone != null) ? (String(b.phone).trim() || null) : u.phone;
  let bio = u.bio, experience = u.experience, work_mode = u.work_mode;
  if (u.role === 'fixer') {
    bio = (b.bio != null) ? (String(b.bio).trim() || null) : u.bio;
    experience = b.experience || u.experience;
    work_mode = b.work_mode || u.work_mode;
  }

  db.prepare(`UPDATE users SET name=?, email=?, phone=?, bio=?, experience=?, work_mode=?, password_hash=? WHERE id=?`)
    .run(name, email, phone, bio, experience, work_mode, password_hash, u.id);

  // Fixer skills: rebuild from what was submitted.
  if (u.role === 'fixer') {
    const keys = Array.isArray(b.skills) ? b.skills.filter(s => CATEGORY_KEYS.has(s)) : [];
    const customs = (Array.isArray(b.custom_skills) ? b.custom_skills : [])
      .map(s => String(s || '').trim().slice(0, 40)).filter(Boolean);
    if (keys.length === 0 && customs.length === 0)
      return res.status(400).json({ error: 'Pick or type at least one thing you can fix.' });
    Q.clearSkills.run(u.id);
    const fin = new Set(keys);
    customs.forEach(c => fin.add(c));
    if (customs.length) fin.add('other');
    [...fin].forEach(s => Q.insSkill.run(u.id, s));
  }

  res.json({ user: publicUser(Q.userById.get(u.id)) });
});

/* ==================================================================
   CLIENT ROUTES
================================================================== */
// Post a problem (multipart so up to 4 photos can come along).
app.post('/api/tasks', auth, requireRole('client'), upload.array('photos', 4), (req, res) => {
  const { category, title, description, urgency, proposed_price } = req.body || {};
  if (!category || !CATEGORY_KEYS.has(category)) return res.status(400).json({ error: 'Choose a valid problem type.' });
  if (!description || description.trim().length < 5) return res.status(400).json({ error: 'Please describe the problem.' });
  // Free-text problem type when the client picked "Something else".
  let customCategory = null;
  if (category === 'other') {
    customCategory = ((req.body || {}).custom_category || '').trim().slice(0, 60);
    if (!customCategory) return res.status(400).json({ error: 'Please type what kind of problem it is.' });
  }
  const r = Q.insTask.run(
    req.user.id, category, customCategory,
    (title && title.trim()) || customCategory || labelFor(category),
    description.trim(),
    (req.files && req.files.length) ? req.files.map(f => f.filename).join(',') : null,
    urgency || 'As soon as possible',
    proposed_price ? parseInt(proposed_price, 10) : null,
  );
  event(r.lastInsertRowid, req.user.id,
    `Problem posted${proposed_price ? ` with a suggested budget of $${parseInt(proposed_price,10)}` : ''}. Waiting for a manager to review.`);
  res.json({ task: taskView(Q.taskById.get(r.lastInsertRowid), req.user) });
});

app.get('/api/tasks/mine', auth, requireRole('client'), (req, res) => {
  res.json({ tasks: Q.tasksByClient.all(req.user.id).map(t => taskView(t, req.user)) });
});

// Client responds to a manager's counter-price.
app.post('/api/tasks/:id/respond', auth, requireRole('client'), (req, res) => {
  const t = Q.taskById.get(+req.params.id);
  if (!t || t.client_id !== req.user.id) return res.status(404).json({ error: 'Task not found.' });
  if (t.status !== 'price_countered') return res.status(400).json({ error: 'Nothing to respond to.' });
  const accept = (req.body || {}).action === 'accept';
  if (accept) {
    db.prepare(`UPDATE tasks SET status='open', agreed_price=?, updated_at=datetime('now') WHERE id=?`)
      .run(t.counter_price, t.id);
    event(t.id, req.user.id, `Client accepted the adjusted price of $${t.counter_price}. Now open to fixers.`);
  } else {
    db.prepare(`UPDATE tasks SET status='declined', updated_at=datetime('now') WHERE id=?`).run(t.id);
    event(t.id, req.user.id, 'Client declined the adjusted price. Task closed.');
  }
  res.json({ task: taskView(Q.taskById.get(t.id), req.user) });
});

// Client confirms the work is actually done.
app.post('/api/tasks/:id/confirm', auth, requireRole('client'), (req, res) => {
  const t = Q.taskById.get(+req.params.id);
  if (!t || t.client_id !== req.user.id) return res.status(404).json({ error: 'Task not found.' });
  if (t.status !== 'work_done') return res.status(400).json({ error: 'This task is not awaiting confirmation.' });
  db.prepare(`UPDATE tasks SET status='completed', updated_at=datetime('now') WHERE id=?`).run(t.id);
  event(t.id, req.user.id, 'Client confirmed the problem is fixed. ✅');
  res.json({ task: taskView(Q.taskById.get(t.id), req.user) });
});

// Client cancels their request (e.g. they fixed it themselves) before it's completed.
app.post('/api/tasks/:id/cancel', auth, requireRole('client'), (req, res) => {
  const t = Q.taskById.get(+req.params.id);
  if (!t || t.client_id !== req.user.id) return res.status(404).json({ error: 'Task not found.' });
  const cancellable = ['submitted', 'price_countered', 'open', 'assigned'];
  if (!cancellable.includes(t.status)) return res.status(400).json({ error: 'This task can no longer be cancelled.' });
  const hadFixer = !!t.assigned_fixer_id;
  db.prepare(`UPDATE tasks SET status='cancelled', updated_at=datetime('now') WHERE id=?`).run(t.id);
  event(t.id, req.user.id, hadFixer
    ? 'Client cancelled the request — they no longer need help. It has been removed from the fixer\'s jobs.'
    : 'Client cancelled the request — they no longer need help.');
  res.json({ task: taskView(Q.taskById.get(t.id), req.user) });
});

/* ==================================================================
   MANAGER ROUTES
================================================================== */
app.get('/api/manager/queue', auth, requireRole('manager', 'admin'), (req, res) => {
  res.json({ tasks: Q.submittedQueue.all().map(t => taskView(t, req.user)) });
});

app.get('/api/manager/all', auth, requireRole('manager', 'admin'), (req, res) => {
  res.json({ tasks: Q.allTasks.all().map(t => taskView(t, req.user)) });
});

// Manager reviews a submitted task: approve the price, or counter it.
app.post('/api/tasks/:id/review', auth, requireRole('manager', 'admin'), (req, res) => {
  const t = Q.taskById.get(+req.params.id);
  if (!t) return res.status(404).json({ error: 'Task not found.' });
  if (t.status !== 'submitted') return res.status(400).json({ error: 'This task is not awaiting review.' });
  const { action, counter_price, manager_note } = req.body || {};

  if (action === 'approve') {
    const price = t.proposed_price || (counter_price ? parseInt(counter_price, 10) : null);
    db.prepare(`UPDATE tasks SET status='open', agreed_price=?, manager_id=?, manager_note=?, updated_at=datetime('now') WHERE id=?`)
      .run(price, req.user.id, manager_note || null, t.id);
    event(t.id, req.user.id, `Manager approved${price ? ` the price of $${price}` : ''} and opened it to qualified fixers.`);
  } else if (action === 'counter') {
    const price = parseInt(counter_price, 10);
    if (!price) return res.status(400).json({ error: 'Enter the adjusted price.' });
    if (!manager_note) return res.status(400).json({ error: 'Explain the price to the client.' });
    db.prepare(`UPDATE tasks SET status='price_countered', counter_price=?, manager_id=?, manager_note=?, updated_at=datetime('now') WHERE id=?`)
      .run(price, req.user.id, manager_note, t.id);
    event(t.id, req.user.id, `Manager proposed $${price}: ${manager_note}`);
  } else {
    return res.status(400).json({ error: 'Unknown action.' });
  }
  res.json({ task: taskView(Q.taskById.get(t.id), req.user) });
});

/* ==================================================================
   FIXER ROUTES
================================================================== */
// Every open task is offered to every fixer; first to accept wins.
app.get('/api/fixer/open', auth, requireRole('fixer'), (req, res) => {
  const tasks = Q.openForCategory.all().map(t => taskView(t, req.user));
  res.json({ tasks });
});

app.get('/api/fixer/mine', auth, requireRole('fixer'), (req, res) => {
  res.json({ tasks: Q.fixerTasks.all(req.user.id).map(t => taskView(t, req.user)) });
});

// Claim an open task. First fixer to accept wins (guarded by status check).
app.post('/api/tasks/:id/accept', auth, requireRole('fixer'), (req, res) => {
  const t = Q.taskById.get(+req.params.id);
  if (!t) return res.status(404).json({ error: 'Task not found.' });
  // Atomic claim: only succeeds if it is still open and unassigned.
  const r = db.prepare(`UPDATE tasks SET status='assigned', assigned_fixer_id=?, updated_at=datetime('now')
                        WHERE id=? AND status='open' AND assigned_fixer_id IS NULL`)
              .run(req.user.id, t.id);
  if (r.changes === 0) return res.status(409).json({ error: 'Too late — another fixer already took this one.' });
  event(t.id, req.user.id, `${req.user.name} accepted the task and will start working on it.`);
  res.json({ task: taskView(Q.taskById.get(t.id), req.user) });
});

// Fixer marks the work as done (client still confirms).
app.post('/api/tasks/:id/done', auth, requireRole('fixer'), (req, res) => {
  const t = Q.taskById.get(+req.params.id);
  if (!t || t.assigned_fixer_id !== req.user.id) return res.status(404).json({ error: 'Task not found.' });
  if (t.status !== 'assigned') return res.status(400).json({ error: 'This task is not in progress.' });
  db.prepare(`UPDATE tasks SET status='work_done', updated_at=datetime('now') WHERE id=?`).run(t.id);
  event(t.id, req.user.id, `${req.user.name} marked the work as done. Waiting for the client to confirm.`);
  res.json({ task: taskView(Q.taskById.get(t.id), req.user) });
});

/* ==================================================================
   ADMIN ROUTES
================================================================== */
app.get('/api/admin/users', auth, requireRole('admin'), (req, res) => {
  res.json({ users: Q.allUsers.all().map(publicUser) });
});

// Promote / demote. Admin only.
app.post('/api/admin/users/:id/role', auth, requireRole('admin'), (req, res) => {
  const target = Q.userById.get(+req.params.id);
  const { role } = req.body || {};
  if (!target) return res.status(404).json({ error: 'User not found.' });
  if (!['fixer', 'manager', 'admin'].includes(role))
    return res.status(400).json({ error: 'Role must be fixer, manager or admin.' });
  if (target.role === 'client')
    return res.status(400).json({ error: 'Clients cannot be promoted into staff roles.' });
  if (target.is_primary)
    return res.status(400).json({ error: 'The primary admin cannot be changed.' });
  if (target.id === req.user.id)
    return res.status(400).json({ error: 'You cannot change your own role.' });
  // Don't allow removing the last admin.
  if (target.role === 'admin' && role !== 'admin' && Q.countAdmins.get().n <= 1)
    return res.status(400).json({ error: 'There must always be at least one admin.' });

  Q.setRole.run(role, target.id);
  res.json({ user: publicUser(Q.userById.get(target.id)) });
});

/* Turn upload errors (too many files / too large) into friendly JSON. */
app.use((err, req, res, next) => {
  if (!err) return next();
  const msg = err.code === 'LIMIT_UNEXPECTED_FILE' ? 'You can upload up to 4 photos.'
    : err.code === 'LIMIT_FILE_SIZE' ? 'Each photo must be under 8 MB.'
    : (err.message || 'Something went wrong.');
  res.status(400).json({ error: msg });
});

/* ==================================================================
   STATIC + uploads
================================================================== */
app.use('/uploads', express.static(UPLOAD_DIR));
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => {
  console.log(`\n  FixIT running →  http://localhost:${PORT}\n`);
});
