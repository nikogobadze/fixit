/* ==================================================================
   FixIT front-end — single-page app logic.
   Talks to the API in server.js; cookie holds the JWT session.
================================================================== */
const state = { user: null, cats: [], dashTab: null, peopleFilter: 'all' };

/* ---------- tiny helpers ---------- */
const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
const money = (n) => (n || n === 0) ? `$${n}` : '—';

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
const VIEWS = ['home','login','registerClient','registerFixer','post','dashboard','about','profile'];
/* Each view maps to a real URL so the browser's Back/Forward buttons work. */
const PATHS = { home:'/', login:'/login', registerClient:'/signup', registerFixer:'/join', post:'/post', dashboard:'/dashboard', about:'/about', profile:'/profile' };
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
  const url = (PATHS[view] || '/') + (hash ? '#' + hash : '');
  if (push) history.pushState({ view, hash: hash || null }, '', url);
  else history.replaceState({ view, hash: hash || null }, '', url);
  if (hash) setTimeout(() => $('#' + hash)?.scrollIntoView({ behavior: 'smooth' }), 60);
}

document.addEventListener('click', e => {
  const t = e.target.closest('[data-go]');
  if (t) { e.preventDefault(); go(t.getAttribute('data-go'), t.getAttribute('data-hash')); }
});

/* Back / Forward buttons: restore the view from history without re-pushing. */
window.addEventListener('popstate', e => {
  const view = (e.state && e.state.view) || VIEW_BY_PATH[location.pathname] || 'home';
  const hash = (e.state && e.state.hash) || (location.hash ? location.hash.slice(1) : null);
  go(view, hash, false);
});

/* ---------- nav bar (auth aware) ---------- */
function renderNav() {
  const el = $('#nav-cta'); const u = state.user;
  if (!u) {
    el.innerHTML = `
      <a class="btn btn-ghost" data-go="registerClient" style="padding:.54rem 1.1rem .66rem">Sign up</a>
      <button class="btn btn-primary" data-go="login" style="padding:.54rem 1.2rem .66rem">Log in</button>`;
    return;
  }
  const first = esc(u.name.split(' ')[0]);
  el.innerHTML = `
    <a class="who" data-go="profile" title="Your profile">${first} <span class="role-tag">${u.role}</span></a>
    <a class="btn btn-ghost btn-sm" data-go="dashboard">Dashboard</a>
    <button class="btn btn-soft btn-sm" id="logout-btn">Log out</button>`;
  $('#logout-btn').onclick = async () => {
    await api('/api/auth/logout', { method: 'POST' });
    state.user = null; renderNav(); toast('Logged out.'); go('home');
  };
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
    state.user = user; renderNav(); f.reset();
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
  if (f.password.value && f.password.value !== f.password2.value) { fieldErr(f.password2, 'The two passwords don\'t match.'); ok = false; }
  if (!ok) return;
  try {
    const { user } = await api('/api/auth/register/client', {
      body: { name: f.name.value, email: f.email.value, phone: f.phone.value, password: f.password.value },
    });
    state.user = user; renderNav(); f.reset();
    toast('Account created. Let\'s fix something.'); go('post');
  } catch (err) { fieldErr(f.email, err.message); }
});

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
  if (f.password.value !== f.password2.value) { fieldErr(f.password2, 'The two passwords don\'t match.'); return; }
  const skills = $$('#skill-chips .chip.on').map(c => c.getAttribute('data-skill'));
  const custom_skills = customSkillList();
  try {
    const { user } = await api('/api/auth/register/fixer', {
      body: {
        name: f.name.value, email: f.email.value, password: f.password.value,
        bio: f.bio.value, experience: f.experience.value,
        work_mode: f.work_mode.value, skills, custom_skills,
      },
    });
    state.user = user; renderNav(); f.reset();
    $$('#skill-chips .chip').forEach(c => c.classList.remove('on')); goFixerStep(1);
    toast('Welcome aboard, fixer!'); go('dashboard');
  } catch (err) {
    // server errors (e.g. email already registered) live on step 1
    goFixerStep(1); fieldErr(f.email, err.message);
  }
});

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
    if (action === 'accept-counter') { await api(`/api/tasks/${id}/respond`, { body:{ action:'accept' } }); toast('Price accepted — sent to fixers.'); }
    if (action === 'decline-counter') { await api(`/api/tasks/${id}/respond`, { body:{ action:'decline' } }); toast('Price declined.'); }
    if (action === 'confirm-done') { await api(`/api/tasks/${id}/confirm`, { method:'POST' }); toast('Marked as fixed. Thank you!'); }
    if (action === 'accept-task') { await api(`/api/tasks/${id}/accept`, { method:'POST' }); toast('Job is yours — good luck!'); }
    if (action === 'mark-done') { await api(`/api/tasks/${id}/done`, { method:'POST' }); toast('Marked done. Waiting for client to confirm.'); }
    if (action === 'cancel-task') { return confirmCancel(id); }
    if (action === 'review') { return openReview(id); }
    if (['accept-counter','decline-counter','confirm-done','accept-task','mark-done'].includes(action)) renderDashboard();
  } catch (err) { toast(err.message, true); renderDashboard(); }
});

async function renderDashboard(silent = false) {
  const u = state.user; if (!u) return go('login');
  const root = $('#dash-root');
  if (!silent) root.innerHTML = `<div class="empty">Loading…</div>`;
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
  renderDashboard(true);
}, 10000);

const emptyBox = (msg) => `<div class="empty">
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 12h6M9 16h6M9 8h6"/><rect x="4" y="3" width="16" height="18" rx="2"/></svg>
  <div>${msg}</div></div>`;

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
      <p>Your skills: ${(state.user.skills||[]).map(k => esc(labelOf(k))).join(', ') || '—'}</p></div></div>
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
  return cardShell(t, `${priceBlock(t)}
    <div class="meta"><span>Client: <b>${esc(t.client.name)}</b></span></div>
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
  return cardShell(t, `${priceBlock(t)}${note}
    <div class="meta"><span>Client: <b>${esc(t.client.name)}</b></span>${t.fixer?`<span>Fixer: <b>${esc(t.fixer.name)}</b></span>`:''}</div>`);
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
    else if (canChange) control = `<select class="input" data-uid="${u.id}" style="padding:.34rem 2rem .46rem .7rem;width:auto;font-size:.85rem">
        ${['fixer','manager','admin'].map(r => `<option value="${r}" ${u.role===r?'selected':''}>${r}</option>`).join('')}
      </select>`;
    return `<tr>
      <td>${esc(u.name)}</td><td>${esc(u.email)}</td>
      <td><span class="role-chip rc-${u.role}">${u.role}</span></td>
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
    <table class="users"><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Qualifications</th><th>Change role</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="5" style="text-align:center;color:var(--muted);padding:1.5rem">No one with that role.</td></tr>`}</tbody></table>`;
}
function wireRoleSelects() {
  $$('#dash-root select[data-uid]').forEach(sel => sel.onchange = async () => {
    try {
      await api(`/api/admin/users/${sel.getAttribute('data-uid')}/role`, { body: { role: sel.value } });
      toast('Role updated.'); renderDashboard();
    } catch (err) { toast(err.message, true); renderDashboard(); }
  });
  const pf = $('#people-filter');
  if (pf) pf.onchange = () => { state.peopleFilter = pf.value; renderDashboard(); };
}

/* ---------- shared ---------- */
function wireTabs(root) {
  $$('.tab', root).forEach(t => t.onclick = () => { state.dashTab = t.getAttribute('data-tab'); renderDashboard(); });
}
function labelOf(key) { return (state.cats.find(c => c.key === key) || {}).label || key; }

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
    <div style="margin-top:.7rem"></div>
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
      <button class="btn btn-primary btn-block" type="submit" style="margin-top:.4rem">Save changes</button>
    </form>`;
  const sk = $('#profile-skills');
  if (sk) sk.addEventListener('click', e => { const ch = e.target.closest('.chip'); if (ch) ch.classList.toggle('on'); });
  $('#profile-form').addEventListener('submit', saveProfile);
}

async function saveProfile(e) {
  e.preventDefault();
  const f = e.target; clearFieldErrs(f);
  let ok = true;
  if (!f.name.value.trim()) { fieldErr(f.name, 'Name is required.'); ok = false; }
  if (!f.email.value.trim()) { fieldErr(f.email, 'Email is required.'); ok = false; }
  if (f.newPassword.value) {
    if (!f.currentPassword.value) { fieldErr(f.currentPassword, 'Enter your current password to change it.'); ok = false; }
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
    state.user = user; renderNav(); renderProfile();
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
  await loadCategories();
  try { const { user } = await api('/api/me'); state.user = user; } catch {}
  renderNav();
  // Open the view that matches the current URL (deep link / refresh / first load).
  const initialView = VIEW_BY_PATH[location.pathname] || 'home';
  const initialHash = location.hash ? location.hash.slice(1) : null;
  go(initialView, initialHash, false);
})();
