/* ==================================================================
   FixIT front-end — single-page app logic.
   Talks to the API in server.js; cookie holds the JWT session.
================================================================== */
const state = { user: null, cats: [], dashTab: null, peopleFilter: 'all' };

/* Cache the logged-in user locally so a reload shows the right navbar instantly
   (no "logged out then in" flash). The JWT itself stays in the httpOnly cookie. */
function setAuth(user) {
  state.user = user;
  state.dashTab = null;   // reset dashboard tab so each role opens on its default (admin → People)
  try { user ? localStorage.setItem('fixit_user', JSON.stringify(user)) : localStorage.removeItem('fixit_user'); } catch {}
  renderNav();
}
function readAuthCache() {
  try { return JSON.parse(localStorage.getItem('fixit_user') || 'null'); } catch { return null; }
}

/* ---------- tiny helpers ---------- */
const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
const money = (n) => (n || n === 0) ? `$${n}` : '—';
/* read-only star row for a 1–5 value */
function starsRO(n) {
  n = Math.round(n || 0); let s = '';
  for (let i = 1; i <= 5; i++) s += `<span class="star-ro ${i <= n ? 'on' : ''}">★</span>`;
  return `<span class="stars-ro">${s}</span>`;
}
/* fixer's average rating as text, e.g. "★ 4.8 (12)" */
function ratingText(r) {
  if (!r || !r.count) return '<span style="color:var(--muted)">No ratings yet</span>';
  return `<span class="rating-avg">★ ${r.avg.toFixed(1)}</span> <span style="color:var(--muted);font-weight:500">(${r.count})</span>`;
}
/* avatar: an <img> if there's a picture, else an initials circle */
function avatarHTML(name, url, size = 32) {
  const s = `width:${size}px;height:${size}px`;
  if (url) return `<img class="avatar" src="${url}" style="${s}" alt="">`;
  const initials = (name || '?').trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
  return `<span class="avatar avatar-fallback" style="${s};font-size:${Math.round(size * 0.4)}px">${esc(initials)}</span>`;
}
/* wire a circular file picker (prefix-avatar-input / -preview / -ph) */
function wireAvatarPicker(prefix, onFile) {
  const input = $(`#${prefix}-avatar-input`); if (!input) return;
  input.addEventListener('change', () => {
    const f = input.files[0]; if (!f) return;
    const img = $(`#${prefix}-avatar-preview`), ph = $(`#${prefix}-avatar-ph`);
    img.src = URL.createObjectURL(f); img.style.display = ''; if (ph) ph.style.display = 'none';
    onFile(f);
  });
}
let regClientAvatar = null, regFixerAvatar = null;
/* Password policy: 8+ chars, ≥1 number, ≥1 capital letter. */
function passwordError(pw) {
  pw = pw || '';
  if (pw.length < 8) return 'Password must be at least 8 characters.';
  if (!/[0-9]/.test(pw)) return 'Password must include at least 1 number.';
  if (!/[A-Z]/.test(pw)) return 'Password must include at least 1 capital letter.';
  return null;
}

async function api(path, { method, body, form } = {}) {
  if (!method) method = (body || form) ? 'POST' : 'GET';
  const opts = { method, credentials: 'same-origin', headers: {} };
  if (form) opts.body = form;
  else if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const res = await fetch(path, opts);
  let data = {};
  try { data = await res.json(); } catch {}
  if (!res.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}

let toastTimer;
function toast(msg, bad = false) {
  const t = $('#toast');
  t.textContent = msg; t.classList.toggle('bad', bad); t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}

function modal(html) { $('#modal').innerHTML = html; $('#modal-bg').classList.add('show'); }
function closeModal() { $('#modal-bg').classList.remove('show'); }
$('#modal-bg').addEventListener('click', e => { if (e.target.id === 'modal-bg') closeModal(); });

/* ---------- navigation ---------- */
const VIEWS = ['home','login','registerClient','registerFixer','post','dashboard','about','profile','reviews'];
/* Each view maps to a real URL so the browser's Back/Forward buttons work. */
const PATHS = { home:'/', login:'/login', registerClient:'/signup', registerFixer:'/join', post:'/post', dashboard:'/dashboard', about:'/about', profile:'/profile', reviews:'/reviews' };
const VIEW_BY_PATH = Object.fromEntries(Object.entries(PATHS).map(([v, p]) => [p, v]));

function showView(view) {
  VIEWS.forEach(v => $('#view-' + v)?.classList.remove('active'));
  $('#view-' + (VIEWS.includes(view) ? view : 'home')).classList.add('active');
  window.scrollTo({ top: 0, behavior: 'auto' });
}

/* push=true adds a history entry (normal navigation); false is used when we are
   already responding to the browser (popstate / first load). */
function go(view, hash, push = true) {
  // Access rules
  if (view === 'post') {
    if (!state.user) { toast('Create a free account to post a problem.'); return go('registerClient', null, push); }
    if (state.user.role !== 'client') { toast('Posting is for client accounts.'); return go('dashboard', null, push); }
    resetPostFlow();
  }
  if (view === 'dashboard' && !state.user) return go('login', null, push);
  if (view === 'profile' && !state.user) return go('login', null, push);
  showView(view);
  if (view === 'dashboard') renderDashboard();
  if (view === 'profile') renderProfile();
  if (view === 'reviews') renderReviews();
  const url = (PATHS[view] || '/') + (hash ? '#' + hash : '');
  if (push) history.pushState({ view, hash: hash || null }, '', url);
  else history.replaceState({ view, hash: hash || null }, '', url);
  if (hash) setTimeout(() => $('#' + hash)?.scrollIntoView({ behavior: 'smooth' }), 60);
}

document.addEventListener('click', e => {
  const t = e.target.closest('[data-go]');
  if (t) { e.preventDefault(); $('#mobile-menu')?.classList.remove('open'); go(t.getAttribute('data-go'), t.getAttribute('data-hash')); }
});

/* mobile hamburger menu */
$('#nav-toggle')?.addEventListener('click', () => {
  const m = $('#mobile-menu'); const open = m.classList.toggle('open');
  $('#nav-toggle').setAttribute('aria-expanded', open ? 'true' : 'false');
});

/* Back / Forward buttons: restore the view from history without re-pushing. */
window.addEventListener('popstate', e => {
  const view = (e.state && e.state.view) || VIEW_BY_PATH[location.pathname] || 'home';
  const hash = (e.state && e.state.hash) || (location.hash ? location.hash.slice(1) : null);
  go(view, hash, false);
});

/* ---------- nav bar (auth aware) — fills both the desktop bar and the mobile menu ---------- */
function renderNav() {
  const u = state.user;
  let html;
  if (!u) {
    html = `
      <a class="btn btn-ghost" data-go="registerClient" style="padding:.54rem 1.1rem .66rem">Sign up</a>
      <button class="btn btn-primary" data-go="login" style="padding:.54rem 1.2rem .66rem">Log in</button>`;
  } else {
    const first = esc(u.name.split(' ')[0]);
    html = `
      <a class="who" data-go="profile" title="Your profile">${avatarHTML(u.name, u.avatar, 32)} ${first} <span class="role-tag">${u.role}</span></a>
      <a class="btn btn-ghost btn-sm" data-go="dashboard">Dashboard</a>
      <button class="btn btn-soft btn-sm js-logout">Log out</button>`;
  }
  $('#nav-cta').innerHTML = html;
  const ma = $('#mobile-auth'); if (ma) ma.innerHTML = html;
  $$('.js-logout').forEach(b => b.onclick = async () => {
    await api('/api/auth/logout', { method: 'POST' });
    setAuth(null); $('#mobile-menu')?.classList.remove('open'); toast('Logged out.'); go('home');
  });
}

/* ---------- bootstrap taxonomy + chips ---------- */
async function loadCategories() {
  state.cats = await api('/api/categories');
  // home category cards
  $('#home-cats').innerHTML = state.cats.map(c =>
    `<button class="cat" data-cat="${c.key}" data-pick><span class="cico">${c.emoji}</span>${esc(c.label)}</button>`).join('');
  // post form chips (single select)
  $('#cat-chips').innerHTML = state.cats.map(c =>
    `<span class="chip" data-cat="${c.key}">${c.emoji} ${esc(c.label)}</span>`).join('');
  // fixer skill chips (multi select)
  $('#skill-chips').innerHTML = state.cats.filter(c => c.key !== 'other').map(c =>
    `<span class="chip" data-skill="${c.key}">${c.emoji} ${esc(c.label)}</span>`).join('');
}

/* home category card → jump to post pre-filled */
document.addEventListener('click', e => {
  const card = e.target.closest('[data-pick]');
  if (!card) return;
  const key = card.getAttribute('data-cat');
  go('post');
  if (state.user && state.user.role === 'client') selectCat(key);
});
function selectCat(key) {
  $$('#cat-chips .chip').forEach(ch => ch.classList.toggle('on', ch.getAttribute('data-cat') === key));
  toggleCustomCat();
}
/* Home "describe it yourself" box → jump into the post flow as "Something else". */
function homeOther() {
  const v = $('#home-other-input').value.trim();
  go('post');
  if (state.user && state.user.role === 'client') {
    selectCat('other');
    $('#custom-cat').value = v;
    if (v) { $('#custom-cat-wrap').style.display = 'block'; $('#problem-text').focus(); }
    $('#home-other-input').value = '';
  }
}
$('#home-other-btn').addEventListener('click', homeOther);
$('#home-other-input').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); homeOther(); } });

/* Show the free-text "type your problem" field only when "Something else" is picked. */
function toggleCustomCat() {
  const on = $('#cat-chips .chip.on');
  const show = on && on.getAttribute('data-cat') === 'other';
  $('#custom-cat-wrap').style.display = show ? 'block' : 'none';
}
/* post chip single-select */
$('#cat-chips').addEventListener('click', e => {
  const ch = e.target.closest('.chip'); if (!ch) return;
  $$('#cat-chips .chip').forEach(x => x.classList.remove('on')); ch.classList.add('on');
  toggleCustomCat();
});
/* skill chip multi-select */
$('#skill-chips').addEventListener('click', e => {
  const ch = e.target.closest('.chip'); if (ch) ch.classList.toggle('on');
});

/* ==================================================================
   AUTH FORMS
================================================================== */
function showErr(id, msg) { const e = $('#' + id); e.textContent = msg; e.classList.add('show'); }
function clearErr(id) { $('#' + id)?.classList.remove('show'); }

/* ---- per-field inline errors (red line under the field) ---- */
function fieldErr(input, msg) {
  if (!input) return;
  const wrap = input.closest('.field'); if (!wrap) return;
  let e = wrap.querySelector('.field-err');
  if (!e) { e = document.createElement('div'); e.className = 'field-err'; wrap.appendChild(e); }
  e.textContent = msg; e.classList.add('show'); input.classList.add('invalid');
}
const fieldErrByName = (scope, name, msg) => fieldErr(scope.querySelector(`[name="${name}"]`), msg);
function clearFieldErrs(scope) {
  scope.querySelectorAll('.field-err').forEach(e => e.classList.remove('show'));
  scope.querySelectorAll('.invalid').forEach(i => i.classList.remove('invalid'));
}
/* Show an error on a non-input field (e.g. the skill chips block). */
function blockErr(innerSelector, msg) {
  const wrap = $(innerSelector)?.closest('.field'); if (!wrap) return;
  let e = wrap.querySelector('.field-err');
  if (!e) { e = document.createElement('div'); e.className = 'field-err'; wrap.appendChild(e); }
  e.textContent = msg; e.classList.add('show');
}
/* Clear a field's error as soon as the user edits it. */
document.addEventListener('input', e => {
  const i = e.target;
  if (i.classList && i.classList.contains('invalid')) {
    i.classList.remove('invalid');
    i.closest('.field')?.querySelector('.field-err')?.classList.remove('show');
  }
});

$('#login-form').addEventListener('submit', async e => {
  e.preventDefault(); const f = e.target; clearFieldErrs(f);
  let ok = true;
  if (!f.email.value.trim()) { fieldErr(f.email, 'Please enter your email.'); ok = false; }
  if (!f.password.value) { fieldErr(f.password, 'Please enter your password.'); ok = false; }
  if (!ok) return;
  try {
    const { user } = await api('/api/auth/login', { body: { email: f.email.value, password: f.password.value } });
    setAuth(user); f.reset();
    toast(`Welcome back, ${user.name.split(' ')[0]}.`); go('dashboard');
  } catch (err) { fieldErr(f.password, err.message); }
});

/* Contact form (front-end only for this demo). */
$('#contact-form').addEventListener('submit', e => {
  e.preventDefault(); const f = e.target; clearFieldErrs(f);
  let ok = true;
  if (!f.name.value.trim()) { fieldErr(f.name, 'Please add your name.'); ok = false; }
  if (!f.email.value.trim()) { fieldErr(f.email, 'Please add your email.'); ok = false; }
  if (!f.message.value.trim()) { fieldErr(f.message, 'Please write a message.'); ok = false; }
  if (!ok) return;
  f.reset(); toast('Thanks! We\'ll get back to you soon.');
});

$('#rc-form').addEventListener('submit', async e => {
  e.preventDefault(); const f = e.target; clearFieldErrs(f);
  let ok = true;
  if (!f.name.value.trim()) { fieldErr(f.name, 'Please add your name.'); ok = false; }
  if (!f.email.value.trim()) { fieldErr(f.email, 'Please add your email.'); ok = false; }
  if (!f.phone.value.trim()) { fieldErr(f.phone, 'Please add your phone number.'); ok = false; }
  if (!f.password.value) { fieldErr(f.password, 'Please choose a password.'); ok = false; }
  else { const pe = passwordError(f.password.value); if (pe) { fieldErr(f.password, pe); ok = false; } }
  if (f.password.value && f.password.value !== f.password2.value) { fieldErr(f.password2, 'The two passwords don\'t match.'); ok = false; }
  if (!ok) return;
  try {
    const fd = new FormData();
    fd.append('name', f.name.value); fd.append('email', f.email.value);
    fd.append('phone', f.phone.value); fd.append('password', f.password.value);
    if (regClientAvatar) fd.append('avatar', regClientAvatar);
    const { user } = await api('/api/auth/register/client', { form: fd });
    setAuth(user); f.reset(); regClientAvatar = null;
    toast('Account created. Let\'s fix something.'); go('post');
  } catch (err) { fieldErr(f.email, err.message); }
});
wireAvatarPicker('rc', f => regClientAvatar = f);

/* fixer registration (2 steps inside the form) */
function goFixerStep(n) {
  $$('#view-registerFixer .fstep').forEach(s => s.classList.remove('active'));
  $(`#view-registerFixer .fstep[data-pstep="${n}"]`).classList.add('active');
  $('#view-registerFixer .flow-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
/* Parse the free-text "Other speciality" box into a clean array. */
function customSkillList() {
  return ($('#custom-skills').value || '').split(',').map(s => s.trim()).filter(Boolean);
}
$$('#view-registerFixer [data-pnext]').forEach(b => b.onclick = () => {
  // validate step 1 essentials before moving on
  const f = $('#rf-form');
  const step1 = b.closest('.fstep'); clearFieldErrs(step1);
  let ok = true;
  if (!f.name.value.trim()) { fieldErr(f.name, 'Please add your name.'); ok = false; }
  if (!f.email.value.trim()) { fieldErr(f.email, 'Please add your email.'); ok = false; }
  if (!$$('#skill-chips .chip.on').length && !customSkillList().length) {
    blockErr('#skill-chips', 'Pick or type at least one thing you can fix.'); ok = false; }
  if (!ok) return;
  goFixerStep(+b.getAttribute('data-pnext'));
});
/* clear the skills error once they pick a chip or type a speciality */
$('#skill-chips').addEventListener('click', () => $('#skill-chips').closest('.field')?.querySelector('.field-err')?.classList.remove('show'));
$('#custom-skills').addEventListener('input', () => $('#skill-chips').closest('.field')?.querySelector('.field-err')?.classList.remove('show'));
$$('#view-registerFixer [data-pprev]').forEach(b => b.onclick = () => goFixerStep(+b.getAttribute('data-pprev')));

$('#rf-form').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target; const step2 = $('#view-registerFixer .fstep[data-pstep="2"]'); clearFieldErrs(step2);
  if (!f.password.value) { fieldErr(f.password, 'Please choose a password.'); return; }
  const pe = passwordError(f.password.value); if (pe) { fieldErr(f.password, pe); return; }
  if (f.password.value !== f.password2.value) { fieldErr(f.password2, 'The two passwords don\'t match.'); return; }
  const skills = $$('#skill-chips .chip.on').map(c => c.getAttribute('data-skill'));
  const custom_skills = customSkillList();
  try {
    const fd = new FormData();
    fd.append('name', f.name.value); fd.append('email', f.email.value); fd.append('password', f.password.value);
    fd.append('bio', f.bio.value); fd.append('experience', f.experience.value); fd.append('work_mode', f.work_mode.value);
    fd.append('skills', JSON.stringify(skills)); fd.append('custom_skills', JSON.stringify(custom_skills));
    if (regFixerAvatar) fd.append('avatar', regFixerAvatar);
    const { user } = await api('/api/auth/register/fixer', { form: fd });
    setAuth(user); f.reset(); regFixerAvatar = null;
    $$('#skill-chips .chip').forEach(c => c.classList.remove('on')); goFixerStep(1);
    toast('Welcome aboard, fixer!'); go('dashboard');
  } catch (err) {
    // server errors (e.g. email already registered) live on step 1
    goFixerStep(1); fieldErr(f.email, err.message);
  }
});
wireAvatarPicker('rf', f => regFixerAvatar = f);

/* ==================================================================
   POST A PROBLEM FLOW
================================================================== */
const fileInput = $('#file'), drop = $('#drop'), thumbs = $('#thumbs');
const MAX_PHOTOS = 4;
let postFiles = [];
/* The drop area is a <label> wrapping the input, so the OS picker opens
   natively on a single click — no JS trigger needed (avoids double-open). */
fileInput.addEventListener('change', () => {
  for (const f of fileInput.files) {
    if (postFiles.length >= MAX_PHOTOS) { toast(`You can add up to ${MAX_PHOTOS} photos.`); break; }
    postFiles.push(f);
  }
  fileInput.value = '';
  renderThumbs();
});
function renderThumbs() {
  thumbs.innerHTML = postFiles.map((f, i) =>
    `<div class="tb"><button type="button" class="rm" data-i="${i}" aria-label="Remove photo">×</button><img src="${URL.createObjectURL(f)}" alt="photo ${i + 1}"></div>`).join('');
  drop.style.display = postFiles.length >= MAX_PHOTOS ? 'none' : 'block';
}
thumbs.addEventListener('click', e => {
  const b = e.target.closest('.rm'); if (!b) return;
  postFiles.splice(+b.getAttribute('data-i'), 1); renderThumbs();
});

function resetPostFlow() {
  postStep(1);
  $('#problem-title').value = ''; $('#problem-text').value = ''; $('#c-price').value = '';
  $('#custom-cat').value = ''; $('#custom-cat-wrap').style.display = 'none';
  $$('#cat-chips .chip').forEach(c => c.classList.remove('on'));
  postFiles = []; renderThumbs(); fileInput.value = ''; drop.style.display = 'block'; clearErr('post-error');
}
function postStep(n) {
  $$('#view-post .fstep').forEach(s => s.classList.remove('active'));
  $(`#view-post .fstep[data-step="${n}"]`).classList.add('active');
  $$('#post-progress .pdot').forEach(d => {
    const i = +d.getAttribute('data-d');
    d.classList.toggle('active', i === n); d.classList.toggle('done', i < n);
  });
  $$('#post-progress .pseg').forEach(s => s.classList.toggle('fill', +s.getAttribute('data-s') < n));
  $('.flow-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
$$('#view-post [data-next]').forEach(b => b.onclick = async () => {
  const n = +b.getAttribute('data-next');
  if (n === 2) { // validate step 1
    const cat = $('#cat-chips .chip.on');
    if (!cat) { showErr('post-error', 'Pick the type of problem first.'); return; }
    if (cat.getAttribute('data-cat') === 'other' && !$('#custom-cat').value.trim()) {
      showErr('post-error', 'Type what kind of problem it is.'); return; }
    if ($('#problem-text').value.trim().length < 5) { showErr('post-error', 'Please describe the problem.'); return; }
    clearErr('post-error'); postStep(2);
  } else if (n === 3) { await submitTask(b); }
});
$$('#view-post [data-prev]').forEach(b => b.onclick = () => postStep(+b.getAttribute('data-prev')));

async function submitTask(btn) {
  const priceEl = $('#c-price');
  clearFieldErrs($('#view-post'));
  if (priceEl.value && +priceEl.value < 10) { fieldErr(priceEl, 'The lowest you can offer is $10.'); return; }
  const cat = $('#cat-chips .chip.on');
  const fd = new FormData();
  fd.append('category', cat.getAttribute('data-cat'));
  if (cat.getAttribute('data-cat') === 'other') fd.append('custom_category', $('#custom-cat').value.trim());
  fd.append('title', $('#problem-title').value);
  fd.append('description', $('#problem-text').value);
  fd.append('urgency', $('#c-when').value);
  if ($('#c-price').value) fd.append('proposed_price', $('#c-price').value);
  postFiles.forEach(f => fd.append('photos', f));
  btn.disabled = true;
  try {
    const { task } = await api('/api/tasks', { method: 'POST', form: fd });
    buildSummary(task); postStep(3);
  } catch (err) { toast(err.message, true); }
  finally { btn.disabled = false; }
}
function buildSummary(t) {
  $('#summary').innerHTML = `
    <div class="row"><b>Problem</b><span>${esc(t.categoryLabel)}</span></div>
    <div class="row"><b>Details</b><span>${esc(t.description.slice(0, 90))}${t.description.length > 90 ? '…' : ''}</span></div>
    <div class="row"><b>Your budget</b><span>${money(t.proposed_price)}</span></div>
    <div class="row"><b>Timing</b><span>${esc(t.urgency)}</span></div>`;
}

/* ==================================================================
   DASHBOARDS
================================================================== */
function badge(status) {
  const labels = { submitted:'In review', price_countered:'Price suggested', open:'Open to fixers',
    assigned:'In progress', work_done:'Done — confirm?', completed:'Completed',
    declined:'Declined', cancelled:'Cancelled' };
  return `<span class="badge b-${status}">${labels[status] || status}</span>`;
}
function eventsHtml(t) {
  return `<div class="toggle-ev" data-action="toggle-ev">Show activity (${t.events.length})</div>
    <div class="events">${t.events.map(e =>
      `<div class="ev"><span class="dot">•</span><span><b>${esc(e.who)}</b> — ${esc(e.text)}</span></div>`).join('')}</div>`;
}
function priceBlock(t) {
  if (t.status === 'price_countered')
    return `<div><span class="price strike">${money(t.proposed_price)}</span> <span class="price">${money(t.counter_price)}</span></div>`;
  if (t.agreed_price != null) return `<div class="price">${money(t.agreed_price)}</div>`;
  return `<div class="price">${money(t.proposed_price)}</div>`;
}
function cardShell(t, inner) {
  return `<div class="tcard" data-id="${t.id}">
    <div class="top">
      <span class="cat" title="${esc(t.categoryLabel)}">${esc(t.categoryLabel)}</span>
      ${badge(t.status)}
    </div>
    <h3>${esc(t.title)}</h3>
    <p class="desc">${esc(t.description)}</p>
    ${(t.photos && t.photos.length) ? `<div class="tphotos">${t.photos.map(p => `<img class="tphoto" src="${p}" alt="problem photo">`).join('')}</div>` : ''}
    ${inner || ''}
    ${eventsHtml(t)}
  </div>`;
}

/* event delegation for dashboard actions */
document.addEventListener('click', async e => {
  const a = e.target.closest('[data-action]'); if (!a) return;
  const card = a.closest('.tcard'); const id = card?.getAttribute('data-id');
  const action = a.getAttribute('data-action');
  try {
    if (action === 'toggle-ev') {
      const ev = card.querySelector('.events'); ev.classList.toggle('show');
      a.textContent = ev.classList.contains('show') ? 'Hide activity' : `Show activity (${ev.children.length})`;
      return;
    }
    if (action === 'set-star') { // highlight stars up to the clicked one (UI only)
      const stars = a.parentElement; const n = +a.getAttribute('data-n');
      stars.setAttribute('data-val', n);
      [...stars.children].forEach((s, i) => s.classList.toggle('on', i < n));
      return;
    }
    if (action === 'submit-rating') {
      const w = a.closest('.rate'); const val = +w.querySelector('.stars').getAttribute('data-val');
      if (!val) { toast('Pick a star rating first.'); return; }
      await api(`/api/tasks/${id}/rate`, { body: { rating: val, comment: w.querySelector('.rate-comment').value } });
      toast('Thanks for rating!'); renderDashboard(); return;
    }
    if (action === 'accept-counter') { await api(`/api/tasks/${id}/respond`, { body:{ action:'accept' } }); toast('Price accepted — sent to fixers.'); }
    if (action === 'decline-counter') { await api(`/api/tasks/${id}/respond`, { body:{ action:'decline' } }); toast('Price declined.'); }
    if (action === 'confirm-done') { await api(`/api/tasks/${id}/confirm`, { method:'POST' }); toast('Marked as fixed. Thank you!'); }
    if (action === 'accept-task') { return confirmAccept(id); }
    if (action === 'mark-done') { await api(`/api/tasks/${id}/done`, { method:'POST' }); toast('Marked done. Waiting for client to confirm.'); }
    if (action === 'cancel-task') { return confirmCancel(id); }
    if (action === 'pay') { return openPay(id, +a.getAttribute('data-amount')); }
    if (action === 'review') { return openReview(id); }
    if (['accept-counter','decline-counter','confirm-done','mark-done'].includes(action)) renderDashboard();
  } catch (err) { toast(err.message, true); renderDashboard(); }
});

async function renderDashboard(silent = false) {
  const u = state.user; if (!u) return go('login');
  const root = $('#dash-root');
  if (!silent) root.innerHTML = loadingBox();
  if (u.role === 'client') return renderClient(root);
  if (u.role === 'fixer') return renderFixer(root);
  if (u.role === 'manager') return renderManager(root);
  if (u.role === 'admin') return renderAdmin(root);
}

/* Auto-refresh: keeps each dashboard live so a manager's approval reaches
   fixers (and a fixer's accept disappears for others) without reloading. */
setInterval(() => {
  if (document.visibilityState !== 'visible') return;
  if (!state.user) return;
  if (!$('#view-dashboard').classList.contains('active')) return;
  if ($('#modal-bg').classList.contains('show')) return;   // don't interrupt a review
  const a = document.activeElement;                         // don't yank focus mid-interaction
  if (a && $('#dash-root').contains(a) && /^(SELECT|INPUT|TEXTAREA)$/.test(a.tagName)) return;
  if ($('#dash-root').querySelector('.events.show')) return; // don't collapse activity the user opened
  if ($('#dash-root').querySelector('.stars[data-val]:not([data-val="0"])')) return; // mid-rating
  renderDashboard(true);
}, 10000);

const emptyBox = (msg) => `<div class="empty">
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 12h6M9 16h6M9 8h6"/><rect x="4" y="3" width="16" height="18" rx="2"/></svg>
  <div>${msg}</div></div>`;
const loadingBox = (msg = 'Loading…') => `<div class="loading"><span class="spin"></span>${msg}</div>`;

/* ---------- CLIENT ---------- */
async function renderClient(root) {
  const tab = ['ongoing', 'completed'].includes(state.dashTab) ? state.dashTab : 'ongoing';
  const { tasks } = await api('/api/tasks/mine');
  const done = ['completed', 'declined', 'cancelled'];
  const ongoing   = tasks.filter(t => !done.includes(t.status));
  const completed = tasks.filter(t => done.includes(t.status));
  const list = tab === 'completed' ? completed : ongoing;
  const empty = tab === 'completed'
    ? 'No finished problems yet.'
    : (tasks.length ? 'No problems in progress right now.' : 'You haven\'t posted anything yet. Tap “Post a new problem”.');
  root.innerHTML = `
    <div class="dash-head">
      <div><h1>My problems</h1><p>Track every fix from review to done.</p></div>
      <button class="btn btn-primary" data-go="post">Post a new problem
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg></button>
    </div>
    <div class="tabs">
      <div class="tab ${tab==='ongoing'?'on':''}" data-tab="ongoing">Ongoing <span class="count">${ongoing.length}</span></div>
      <div class="tab ${tab==='completed'?'on':''}" data-tab="completed">Completed <span class="count">${completed.length}</span></div>
    </div>
    <div class="grid">${list.length ? list.map(clientCard).join('') : emptyBox(empty)}</div>`;
  wireTabs(root);
}
function clientCard(t) {
  let inner = priceBlock(t);
  if (t.status === 'price_countered') {
    inner += `<div class="note-box"><b>Manager's note:</b> ${esc(t.manager_note || '')}</div>
      <div class="card-actions">
        <button class="btn btn-ok btn-sm" data-action="accept-counter">Accept ${money(t.counter_price)}</button>
        <button class="btn btn-danger btn-sm" data-action="decline-counter">Decline</button></div>`;
  } else if (t.status === 'work_done') {
    inner += `<div class="card-actions"><button class="btn btn-ok btn-sm" data-action="confirm-done">Confirm it's fixed ✓</button></div>`;
  } else if (t.manager_note && t.status === 'open') {
    inner += `<div class="note-box"><b>Manager's note:</b> ${esc(t.manager_note)}</div>`;
  }
  if (t.fixer) inner += `<div class="meta"><span>Fixer: <b>${esc(t.fixer.name)}</b></span></div>`;
  // Payment: once the job is completed the client pays the agreed price.
  if (t.status === 'completed') {
    inner += t.paid
      ? `<div class="paid-tag">✓ Paid ${money(t.agreed_price)}${t.card_last4 ? ` · card ···· ${esc(t.card_last4)}` : ''}</div>`
      : `<div class="card-actions"><button class="btn btn-primary btn-sm" data-action="pay" data-amount="${t.agreed_price || 0}">Pay ${money(t.agreed_price)}</button></div>`;
    // Rating: client rates the fixer who did the job.
    if (t.fixer) {
      inner += t.rating
        ? `<div class="rated">You rated ${starsRO(t.rating)}${t.rating_comment ? ` — “${esc(t.rating_comment)}”` : ''}</div>`
        : `<div class="rate">
            <span class="rate-lab">Rate ${esc(t.fixer.name)}:</span>
            <div class="stars" data-val="0">${[1,2,3,4,5].map(n => `<button type="button" class="star" data-action="set-star" data-n="${n}">★</button>`).join('')}</div>
            <input class="input rate-comment" placeholder="Add a comment (optional)">
            <button class="btn btn-primary btn-sm" data-action="submit-rating">Submit rating</button>
          </div>`;
    }
  }
  // Let the client call it off (e.g. they fixed it themselves) while it's still in progress.
  if (['submitted', 'price_countered', 'open', 'assigned'].includes(t.status)) {
    inner += `<div class="card-actions"><button class="btn btn-ghost btn-sm" data-action="cancel-task">I fixed it myself — cancel</button></div>`;
  }
  return cardShell(t, inner);
}

/* ---------- FIXER ---------- */
async function renderFixer(root) {
  const tab = ['open', 'ongoing', 'unconfirmed', 'finished'].includes(state.dashTab) ? state.dashTab : 'open';
  const [open, mine] = await Promise.all([api('/api/fixer/open'), api('/api/fixer/mine')]);
  const ongoing     = mine.tasks.filter(t => t.status === 'assigned');
  const unconfirmed = mine.tasks.filter(t => t.status === 'work_done');
  const finished    = mine.tasks.filter(t => t.status === 'completed');
  let list, render, empty;
  if (tab === 'ongoing')          { list = ongoing;     render = fixerMineCard; empty = 'No jobs in progress right now.'; }
  else if (tab === 'unconfirmed') { list = unconfirmed; render = fixerMineCard; empty = 'Nothing waiting on a client to confirm.'; }
  else if (tab === 'finished')    { list = finished;    render = fixerMineCard; empty = 'No finished jobs yet.'; }
  else                            { list = open.tasks;  render = fixerOpenCard; empty = 'No available jobs right now. Check back soon.'; }
  root.innerHTML = `
    <div class="dash-head"><div><h1>Fixer dashboard</h1>
      <p>Your skills: ${(state.user.skills||[]).map(k => esc(labelOf(k))).join(', ') || '—'} &nbsp;·&nbsp; Rating: ${ratingText(state.user.rating)}</p></div></div>
    <div class="tabs">
      <div class="tab ${tab==='open'?'on':''}" data-tab="open">Available jobs <span class="count">${open.tasks.length}</span></div>
      <div class="tab ${tab==='ongoing'?'on':''}" data-tab="ongoing">Ongoing <span class="count">${ongoing.length}</span></div>
      <div class="tab ${tab==='unconfirmed'?'on':''}" data-tab="unconfirmed">Awaiting confirmation <span class="count">${unconfirmed.length}</span></div>
      <div class="tab ${tab==='finished'?'on':''}" data-tab="finished">Finished <span class="count">${finished.length}</span></div>
    </div>
    <div class="grid">${list.length ? list.map(render).join('') : emptyBox(empty)}</div>`;
  wireTabs(root);
}
function fixerOpenCard(t) {
  return cardShell(t, `${priceBlock(t)}
    <div class="meta"><span>Posted by <b>${esc(t.client.name)}</b></span><span>${esc(t.urgency||'')}</span></div>
    <div class="card-actions"><button class="btn btn-primary btn-sm" data-action="accept-task">Accept this job</button></div>`);
}
function fixerMineCard(t) {
  let actions = '';
  if (t.status === 'assigned') actions = `<button class="btn btn-ok btn-sm" data-action="mark-done">Mark as done</button>`;
  const payLine = t.status === 'completed'
    ? (t.paid ? `<div class="paid-tag">✓ Paid ${money(t.agreed_price)}</div>`
              : `<div class="meta"><span style="color:var(--warn)">Awaiting client payment</span></div>`) : '';
  const rateLine = (t.status === 'completed' && t.rating)
    ? `<div class="rated">Client rated you ${starsRO(t.rating)}${t.rating_comment ? ` — “${esc(t.rating_comment)}”` : ''}</div>` : '';
  return cardShell(t, `${priceBlock(t)}
    <div class="meta"><span>Client: <b>${esc(t.client.name)}</b></span></div>
    ${payLine}${rateLine}
    ${actions ? `<div class="card-actions">${actions}</div>` : ''}`);
}

/* ---------- MANAGER ---------- */
/* One window per task state, so the queue isn't a jumble of everything. */
const TASK_GROUPS = [
  { key: 'queue',     label: 'Review queue',    empty: 'Nothing to review. Inbox zero! 🎉', match: s => s === 'submitted' },
  { key: 'awaiting',  label: 'Awaiting client', empty: 'No tasks waiting on a client right now.', match: s => s === 'price_countered' },
  { key: 'open',      label: 'Open to fixers',  empty: 'No open tasks right now.', match: s => s === 'open' },
  { key: 'progress',  label: 'In progress',     empty: 'No tasks in progress right now.', match: s => s === 'assigned' },
  { key: 'unconfirmed', label: 'Awaiting confirmation', empty: 'Nothing waiting on a client to confirm.', match: s => s === 'work_done' },
  { key: 'completed', label: 'Completed',       empty: 'No completed tasks yet.', match: s => s === 'completed' },
  { key: 'closed',    label: 'Cancelled',       empty: 'No declined or cancelled tasks.', match: s => s === 'declined' || s === 'cancelled' },
];
function bucketize(tasks) {
  const g = {}; TASK_GROUPS.forEach(x => g[x.key] = tasks.filter(t => x.match(t.status))); return g;
}
function groupTabsHtml(groups, active) {
  return TASK_GROUPS.map(x =>
    `<div class="tab ${active===x.key?'on':''}" data-tab="${x.key}">${x.label} <span class="count">${groups[x.key].length}</span></div>`).join('');
}
function groupCards(groups, active) {
  const def = TASK_GROUPS.find(x => x.key === active) || TASK_GROUPS[0];
  const list = groups[active] || [];
  if (!list.length) return emptyBox(def.empty);
  const render = active === 'queue' ? managerQueueCard : managerAllCard;
  return list.map(render).join('');
}

async function renderManager(root) {
  const { tasks } = await api('/api/manager/all');
  const groups = bucketize(tasks);
  const keys = TASK_GROUPS.map(g => g.key);
  const tab = keys.includes(state.dashTab) ? state.dashTab : 'queue';
  root.innerHTML = `
    <div class="dash-head"><div><h1>Manager dashboard</h1><p>Review new problems, set fair prices, route to fixers.</p></div></div>
    <div class="tabs spread">${groupTabsHtml(groups, tab)}</div>
    <div class="grid">${groupCards(groups, tab)}</div>`;
  wireTabs(root);
}
function managerQueueCard(t) {
  return cardShell(t, `
    <div class="meta"><span>Client: <b>${esc(t.client.name)}</b></span><span>${esc(t.urgency||'')}</span></div>
    <div>Client's budget: ${priceBlock(t)}</div>
    <div class="card-actions"><button class="btn btn-primary btn-sm" data-action="review">Review &amp; set price</button></div>`);
}
function managerAllCard(t) {
  const note = (t.status === 'price_countered' && t.manager_note)
    ? `<div class="note-box"><b>Your note:</b> ${esc(t.manager_note)}</div>` : '';
  const payLine = t.status === 'completed'
    ? (t.paid ? `<div class="paid-tag">✓ Paid ${money(t.agreed_price)}</div>`
              : `<div class="meta"><span style="color:var(--warn)">Awaiting client payment</span></div>`) : '';
  const rateLine = (t.status === 'completed' && t.rating)
    ? `<div class="rated">Rated ${starsRO(t.rating)}${t.rating_comment ? ` — “${esc(t.rating_comment)}”` : ''}</div>` : '';
  return cardShell(t, `${priceBlock(t)}${note}
    <div class="meta"><span>Client: <b>${esc(t.client.name)}</b></span>${t.fixer?`<span>Fixer: <b>${esc(t.fixer.name)}</b></span>`:''}</div>
    ${payLine}${rateLine}`);
}

/* ---------- simulated payment ---------- */
function luhnOk(s) {
  if (!/^\d{13,19}$/.test(s)) return false;
  let sum = 0, alt = false;
  for (let i = s.length - 1; i >= 0; i--) { let n = +s[i]; if (alt) { n *= 2; if (n > 9) n -= 9; } sum += n; alt = !alt; }
  return sum % 10 === 0;
}
function expOk(v) {
  if (!/^\d{2}\/\d{2}$/.test(v)) return false;
  const [mm, yy] = v.split('/').map(Number);
  if (mm < 1 || mm > 12) return false;
  return new Date(2000 + yy, mm) > new Date(); // first of the following month
}
function openPay(id, amount) {
  modal(`
    <h3>Pay for your fix</h3>
    <p class="sub">Amount due: <b>${money(amount)}</b>. This is a <b>simulated</b> payment — no real card is charged.</p>
    <div class="form-error" id="pay-error"></div>
    <form id="pay-form" novalidate>
      <label class="field"><span class="lab">Name on card</span><input class="input" name="cardName" placeholder="Jordan Smith"></label>
      <label class="field"><span class="lab">Card number</span><input class="input" name="cardNumber" inputmode="numeric" autocomplete="off" placeholder="6767 6767 6767 6767" maxlength="23"></label>
      <div class="two">
        <label class="field"><span class="lab">Expiry</span><input class="input" name="cardExp" inputmode="numeric" placeholder="MM/YY" maxlength="5"></label>
        <label class="field"><span class="lab">CVC</span><input class="input" name="cardCvc" inputmode="numeric" placeholder="123" maxlength="4"></label>
      </div>
      <div class="flow-actions">
        <button class="btn btn-ghost" type="button" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" type="submit" id="pay-submit">Pay ${money(amount)}</button>
      </div>
    </form>
    <p style="text-align:center;color:var(--muted);font-size:.78rem;margin-top:.8rem">Test card: 6767 6767 6767 6767 · any future date · any CVC</p>`);
  const num = $('#pay-form [name=cardNumber]');
  num.addEventListener('input', () => {
    const v = num.value.replace(/\D/g, '').slice(0, 19);
    num.value = v.replace(/(.{4})/g, '$1 ').trim();
  });
  const exp = $('#pay-form [name=cardExp]');
  exp.addEventListener('input', () => {
    let v = exp.value.replace(/\D/g, '').slice(0, 4);
    if (v.length > 2) v = v.slice(0, 2) + '/' + v.slice(2);
    exp.value = v;
  });
  $('#pay-form').addEventListener('submit', e => doPay(e, id));
}
async function doPay(e, id) {
  e.preventDefault();
  const f = e.target; clearFieldErrs(f);
  const num = f.cardNumber.value.replace(/\s/g, '');
  let ok = true;
  if (!f.cardName.value.trim()) { fieldErr(f.cardName, 'Enter the name on the card.'); ok = false; }
  if (!luhnOk(num)) { fieldErr(f.cardNumber, 'Enter a valid card number.'); ok = false; }
  if (!expOk(f.cardExp.value)) { fieldErr(f.cardExp, 'Enter a valid future expiry.'); ok = false; }
  if (!/^\d{3,4}$/.test(f.cardCvc.value)) { fieldErr(f.cardCvc, 'Enter the security code.'); ok = false; }
  if (!ok) return;
  const btn = $('#pay-submit'); btn.disabled = true; btn.textContent = 'Processing…';
  try {
    await new Promise(r => setTimeout(r, 900)); // simulate the payment gateway
    await api(`/api/tasks/${id}/pay`, { body: { last4: num.slice(-4) } });
    closeModal(); toast('Payment successful — thank you! 🎉'); renderDashboard();
  } catch (err) {
    const box = $('#pay-error'); if (box) { box.textContent = err.message; box.classList.add('show'); } else toast(err.message, true);
    btn.disabled = false; btn.textContent = 'Try again';
  }
}

function confirmAccept(id) {
  modal(`
    <h3>Take this job?</h3>
    <p class="sub">Only accept if you're confident you can complete it. Once you accept, it's assigned to you and removed from other fixers.</p>
    <div class="flow-actions">
      <button class="btn btn-ghost" type="button" onclick="closeModal()">Not now</button>
      <button class="btn btn-primary" type="button" id="accept-yes">Yes, I'll take it</button>
    </div>`);
  $('#accept-yes').onclick = async () => {
    try { await api(`/api/tasks/${id}/accept`, { method: 'POST' }); closeModal(); toast('Job is yours — good luck!'); renderDashboard(); }
    catch (err) { closeModal(); toast(err.message, true); renderDashboard(); }
  };
}
function confirmCancel(id) {
  modal(`
    <h3>Cancel this request?</h3>
    <p class="sub">Only do this if you no longer need help (for example, you fixed it yourself). If a fixer already took the job, it will be removed from their list.</p>
    <div class="flow-actions">
      <button class="btn btn-ghost" type="button" onclick="closeModal()">Keep it</button>
      <button class="btn btn-danger" type="button" id="cancel-yes">Yes, cancel it</button>
    </div>`);
  $('#cancel-yes').onclick = async () => {
    try {
      await api(`/api/tasks/${id}/cancel`, { method: 'POST' });
      closeModal(); toast('Request cancelled.'); renderDashboard();
    } catch (err) { closeModal(); toast(err.message, true); renderDashboard(); }
  };
}

function openReview(id) {
  modal(`
    <h3>Review &amp; price this task</h3>
    <p class="sub">Approve the client's budget, or suggest a fair price with a friendly explanation.</p>
    <div class="form-error" id="rev-error"></div>
    <label class="field"><span class="lab">Adjusted price (USD)</span><input class="input" id="rev-price" type="number" min="0" placeholder="Leave blank to keep client's price"></label>
    <label class="field"><span class="lab">Note to the client</span><textarea class="input" id="rev-note" placeholder="e.g. This needs a part replacement plus about 2 hours of labour, which is why it's $80."></textarea></label>
    <div class="flow-actions">
      <button class="btn btn-ghost" type="button" onclick="closeModal()">Cancel</button>
      <button class="btn btn-soft" type="button" id="rev-approve">Approve price</button>
      <button class="btn btn-primary" type="button" id="rev-counter">Suggest new price</button>
    </div>`);
  $('#rev-approve').onclick = () => doReview(id, 'approve');
  $('#rev-counter').onclick = () => doReview(id, 'counter');
}
async function doReview(id, action) {
  const counter_price = $('#rev-price').value;
  const manager_note = $('#rev-note').value;
  try {
    await api(`/api/tasks/${id}/review`, { body: { action, counter_price, manager_note } });
    closeModal(); toast(action === 'approve' ? 'Approved and opened to fixers.' : 'Sent your suggested price to the client.');
    renderDashboard();
  } catch (err) { const e = $('#rev-error'); if (e) { e.textContent = err.message; e.classList.add('show'); } else toast(err.message, true); }
}

/* ---------- ADMIN ---------- */
async function renderAdmin(root) {
  const keys = ['people', ...TASK_GROUPS.map(g => g.key)];
  const tab = keys.includes(state.dashTab) ? state.dashTab : 'people';
  const { tasks } = await api('/api/manager/all');
  const groups = bucketize(tasks);
  const tabsHtml = `<div class="tab ${tab==='people'?'on':''}" data-tab="people">People</div>${groupTabsHtml(groups, tab)}`;
  let body;
  if (tab === 'people') {
    const { users } = await api('/api/admin/users');
    body = adminPeople(users);
  } else {
    body = `<div class="grid">${groupCards(groups, tab)}</div>`;
  }
  root.innerHTML = `
    <div class="dash-head"><div><h1>Admin dashboard</h1><p>Manage people and triage tasks by state.</p></div></div>
    <div class="tabs spread">${tabsHtml}</div>
    ${body}`;
  wireTabs(root);
  if (tab === 'people') wireRoleSelects();
}
// Fixed order: admins → managers → fixers → clients, A–Z within each group.
const ROLE_RANK = { admin: 0, manager: 1, fixer: 2, client: 3 };
function sortUsers(users) {
  return [...users].sort((a, b) => (ROLE_RANK[a.role] - ROLE_RANK[b.role]) || a.name.localeCompare(b.name));
}
function adminPeople(users) {
  const counts = users.reduce((m,u)=>(m[u.role]=(m[u.role]||0)+1,m),{});
  const filter = state.peopleFilter || 'all';
  const filtered = filter === 'all' ? users : users.filter(u => u.role === filter);
  const rows = sortUsers(filtered).map(u => {
    const canChange = !u.is_primary && u.id !== state.user.id && u.role !== 'client';
    let control = '<span style="color:var(--muted);font-size:.85rem">—</span>';
    if (u.is_primary) control = '<span style="color:var(--muted);font-size:.85rem">primary admin</span>';
    else if (u.id === state.user.id) control = '<span style="color:var(--muted);font-size:.85rem">(you)</span>';
    else if (canChange) control = `<select class="input" data-uid="${u.id}" data-current="${u.role}" data-name="${esc(u.name)}" style="padding:.34rem 2rem .46rem .7rem;width:auto;font-size:.85rem">
        ${['fixer','manager','admin'].map(r => `<option value="${r}" ${u.role===r?'selected':''}>${r}</option>`).join('')}
      </select>`;
    const rating = (u.role === 'fixer' && u.rating && u.rating.count)
      ? `<span class="rating-avg">★ ${u.rating.avg.toFixed(1)}</span> <span style="color:var(--muted)">(${u.rating.count})</span>` : '—';
    return `<tr>
      <td><span class="cell-user">${avatarHTML(u.name, u.avatar, 28)} ${esc(u.name)}</span></td><td>${esc(u.email)}</td>
      <td><span class="role-chip rc-${u.role}">${u.role}</span></td>
      <td>${rating}</td>
      <td>${u.role==='fixer' ? (u.skills||[]).map(k=>esc(labelOf(k))).join(', ')||'—' : '—'}</td>
      <td>${control}</td></tr>`;
  }).join('');
  return `
    <div class="stat-row">
      <div class="stat"><div class="n">${counts.client||0}</div><div class="l">Clients</div></div>
      <div class="stat"><div class="n">${counts.fixer||0}</div><div class="l">Fixers</div></div>
      <div class="stat"><div class="n">${counts.manager||0}</div><div class="l">Managers</div></div>
      <div class="stat"><div class="n">${counts.admin||0}</div><div class="l">Admins</div></div>
    </div>
    <div class="people-bar">
      <label class="people-filter">Show
        <select class="input" id="people-filter">
          ${[['all','Everyone'],['admin','Admins'],['manager','Managers'],['fixer','Fixers'],['client','Clients']]
            .map(([v, l]) => `<option value="${v}" ${filter === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
      </label>
    </div>
    <table class="users"><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Rating</th><th>Qualifications</th><th>Change role</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="6" style="text-align:center;color:var(--muted);padding:1.5rem">No one with that role.</td></tr>`}</tbody></table>`;
}
function wireRoleSelects() {
  $$('#dash-root select[data-uid]').forEach(sel => sel.onchange = () => {
    const id = sel.getAttribute('data-uid');
    const cur = sel.getAttribute('data-current');
    const next = sel.value;
    sel.value = cur;              // revert the dropdown — only apply after confirming
    if (next === cur) return;
    confirmRole(id, sel.getAttribute('data-name'), next);
  });
  const pf = $('#people-filter');
  if (pf) pf.onchange = () => { state.peopleFilter = pf.value; renderDashboard(); };
}
function confirmRole(id, name, newRole) {
  modal(`
    <h3>Change this person's role?</h3>
    <p class="sub">Make <b>${esc(name)}</b> a <b>${esc(newRole)}</b>? You can change it back anytime.</p>
    <div class="flow-actions">
      <button class="btn btn-ghost" type="button" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" type="button" id="role-yes">Yes, change it</button>
    </div>`);
  $('#role-yes').onclick = async () => {
    try { await api(`/api/admin/users/${id}/role`, { body: { role: newRole } }); closeModal(); toast('Role updated.'); renderDashboard(); }
    catch (err) { closeModal(); toast(err.message, true); renderDashboard(); }
  };
}

/* ---------- shared ---------- */
function wireTabs(root) {
  $$('.tab', root).forEach(t => t.onclick = () => { state.dashTab = t.getAttribute('data-tab'); renderDashboard(); });
}
function labelOf(key) { return (state.cats.find(c => c.key === key) || {}).label || key; }

/* ---------- PUBLIC REVIEWS PAGE ---------- */
function fmtDate(s) {
  if (!s) return '';
  const d = new Date(s.replace(' ', 'T') + 'Z');
  return isNaN(d) ? '' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
async function renderReviews() {
  const root = $('#reviews-root');
  root.innerHTML = loadingBox();
  let data;
  try { data = await api('/api/reviews'); } catch { root.innerHTML = emptyBox('Could not load reviews.'); return; }
  const { reviews, summary } = data;
  const head = `<div class="reviews-head">
    <h1 class="page-title">What clients are saying</h1>
    ${summary.count
      ? `<div class="reviews-summary">${starsRO(summary.avg)} <span class="rating-avg">${summary.avg.toFixed(1)}</span> <span class="muted">· ${summary.count} review${summary.count > 1 ? 's' : ''}</span></div>`
      : `<p class="page-lead" style="margin:.6rem auto 0">No reviews yet — get a fix and be the first to leave one!</p>`}
  </div>`;
  const grid = reviews.length
    ? `<div class="reviews-grid">${reviews.map(reviewCard).join('')}</div>` : '';
  root.innerHTML = head + grid;
}
function reviewCard(r) {
  return `<div class="review-card">
    <div class="review-top">
      ${avatarHTML(r.reviewer, r.reviewerAvatar, 40)}
      <div class="review-who"><b>${esc(r.reviewer)}</b><span class="review-sub">${fmtDate(r.at)}</span></div>
      ${starsRO(r.rating)}
    </div>
    ${r.comment ? `<p class="review-text">“${esc(r.comment)}”</p>` : `<p class="review-text muted">No comment left.</p>`}
    <div class="review-fixed"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg> Fixed by <b>${esc(r.fixer)}</b> · ${esc(r.categoryLabel)}</div>
  </div>`;
}

/* ---------- PROFILE (editable, role-aware) ---------- */
function renderProfile() {
  const u = state.user; if (!u) return go('login');
  const root = $('#profile-root');
  const isFixer = u.role === 'fixer';
  const skillSet = new Set(u.skills || []);
  const customSkills = (u.skills || []).filter(s => !state.cats.some(c => c.key === s));
  const chips = state.cats.filter(c => c.key !== 'other').map(c =>
    `<span class="chip ${skillSet.has(c.key) ? 'on' : ''}" data-skill="${c.key}">${c.emoji} ${esc(c.label)}</span>`).join('');
  const expOpts = ['Less than 1', '1–3 years', '3–6 years', '6+ years'];
  const modeOpts = ['Remote only', 'In person only', 'Remote & in person'];
  root.innerHTML = `
    <h2 class="flow-title">Your profile</h2>
    <p class="flow-sub">Update your details — you're signed in as a <b>${esc(u.role)}</b>.</p>
    ${isFixer ? `<p class="flow-sub" style="margin-top:.3rem">Your rating: ${ratingText(u.rating)}</p>` : ''}
    <div style="margin-top:1rem"></div>
    <div class="avatar-pick">
      <label class="avatar-drop">
        <img id="pf-avatar-preview" class="avatar avatar-lg" src="${u.avatar || ''}" style="${u.avatar ? '' : 'display:none'}" alt="">
        <span id="pf-avatar-ph" class="avatar avatar-lg avatar-fallback" style="${u.avatar ? 'display:none' : ''}">${esc((u.name || '?').trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase())}</span>
        <input type="file" id="pf-avatar-input" accept="image/*" hidden>
      </label>
      <div class="avatar-pick-text"><strong>Profile photo</strong><span>Click to change</span></div>
    </div>
    <form id="profile-form" novalidate>
      <div class="two">
        <label class="field"><span class="lab">Name</span><input class="input" name="name" value="${esc(u.name)}"></label>
        <label class="field"><span class="lab">Email</span><input class="input" name="email" type="email" value="${esc(u.email)}"></label>
      </div>
      <label class="field"><span class="lab">Phone</span><input class="input" name="phone" value="${esc(u.phone || '')}" placeholder="+1 555 0100"></label>
      ${isFixer ? `
        <label class="field"><span class="lab">Short bio</span><textarea class="input" name="bio" placeholder="Tell clients what you're great at.">${esc(u.bio || '')}</textarea></label>
        <div class="two">
          <label class="field"><span class="lab">Years of experience</span><select class="input" name="experience">${expOpts.map(o => `<option ${u.experience === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select></label>
          <label class="field"><span class="lab">How you work</span><select class="input" name="work_mode">${modeOpts.map(o => `<option ${u.work_mode === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select></label>
        </div>
        <label class="field"><span class="lab">What you can fix</span><div class="qchips" id="profile-skills">${chips}</div></label>
        <label class="field"><span class="lab">Other speciality <span class="opt">comma-separate for more</span></span><input class="input" id="profile-custom-skills" value="${esc(customSkills.join(', '))}"></label>
      ` : ''}
      <hr class="profile-sep">
      <div class="profile-sec-title">Change password</div>
      <label class="field"><span class="lab">Current password</span><input class="input" name="currentPassword" type="password" placeholder="••••••••"></label>
      <div class="two">
        <label class="field"><span class="lab">New password</span><input class="input" name="newPassword" type="password" placeholder="••••••••"></label>
        <label class="field"><span class="lab">Repeat new password</span><input class="input" name="newPassword2" type="password" placeholder="••••••••"></label>
      </div>
      <span class="field-hint" style="margin-top:-.35rem">At least 8 characters, 1 number, 1 capital letter</span>
      <button class="btn btn-primary btn-block" type="submit" style="margin-top:.8rem">Save changes</button>
    </form>`;
  const sk = $('#profile-skills');
  if (sk) sk.addEventListener('click', e => { const ch = e.target.closest('.chip'); if (ch) ch.classList.toggle('on'); });
  $('#profile-form').addEventListener('submit', saveProfile);
  wireAvatarPicker('pf', async file => {
    const fd = new FormData(); fd.append('avatar', file);
    try { const { user } = await api('/api/profile/avatar', { form: fd }); setAuth(user); toast('Photo updated.'); }
    catch (err) { toast(err.message, true); }
  });
}

async function saveProfile(e) {
  e.preventDefault();
  const f = e.target; clearFieldErrs(f);
  let ok = true;
  if (!f.name.value.trim()) { fieldErr(f.name, 'Name is required.'); ok = false; }
  if (!f.email.value.trim()) { fieldErr(f.email, 'Email is required.'); ok = false; }
  if (f.newPassword.value) {
    if (!f.currentPassword.value) { fieldErr(f.currentPassword, 'Enter your current password to change it.'); ok = false; }
    const pe = passwordError(f.newPassword.value); if (pe) { fieldErr(f.newPassword, pe); ok = false; }
    if (f.newPassword.value !== f.newPassword2.value) { fieldErr(f.newPassword2, 'The new passwords don\'t match.'); ok = false; }
  }
  const body = {
    name: f.name.value, email: f.email.value, phone: f.phone.value,
    currentPassword: f.currentPassword.value, newPassword: f.newPassword.value,
  };
  if (state.user.role === 'fixer') {
    body.bio = f.bio.value; body.experience = f.experience.value; body.work_mode = f.work_mode.value;
    body.skills = $$('#profile-skills .chip.on').map(c => c.getAttribute('data-skill'));
    body.custom_skills = ($('#profile-custom-skills').value || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!body.skills.length && !body.custom_skills.length) { blockErr('#profile-skills', 'Pick or type at least one thing you can fix.'); ok = false; }
  }
  if (!ok) return;
  try {
    const { user } = await api('/api/profile', { body });
    setAuth(user); renderProfile();
    toast('Profile updated.');
  } catch (err) {
    if (/email/i.test(err.message)) fieldErr(f.email, err.message);
    else if (/current password/i.test(err.message)) fieldErr(f.currentPassword, err.message);
    else toast(err.message, true);
  }
}

/* ==================================================================
   BOOT
================================================================== */
(async function init() {
  state.user = readAuthCache();      // instantly restore the last-known login (no flash)
  renderNav();
  // Confirm with the server + load categories in parallel.
  const cats = loadCategories();
  const me = api('/api/me').then(r => setAuth(r.user)).catch(() => {});
  await Promise.allSettled([cats, me]);
  // Open the view that matches the current URL (deep link / refresh / first load).
  const initialView = VIEW_BY_PATH[location.pathname] || 'home';
  const initialHash = location.hash ? location.hash.slice(1) : null;
  go(initialView, initialHash, false);
})();
