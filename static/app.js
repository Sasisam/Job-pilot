'use strict';
/* JobPilot Pro — unique multi-portal auto-apply dashboard */
const $ = s => document.querySelector(s);

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(c));
  return el;
}

async function api(path, opt = {}) {
  if (opt.json !== undefined) { opt.method = opt.method || 'POST'; opt.headers = { ...(opt.headers||{}), 'Content-Type': 'application/json' }; opt.body = JSON.stringify(opt.json); }
  const r = await fetch(path, { credentials: 'same-origin', ...opt });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401) {
    showAuth();
    throw new Error(j.detail || 'Please log in');
  }
  if (!r.ok) {
    const detail = j.detail;
    const msg = typeof detail === 'string' ? detail : (Array.isArray(detail) ? detail.map(d => d.msg || d).join(', ') : (r.statusText || 'Something went wrong'));
    throw new Error(msg || 'Something went wrong');
  }
  return j;
}
let toastT;
function toast(m) { const t = $('#toast'); t.textContent = m; t.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), 3400); }
const guard = fn => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message || 'Something went wrong'); } };

/* ---------------- auth ---------------- */
let CURRENT_USER = null;
let authMode = 'login'; // or 'register'

function showAuth() {
  const gate = document.getElementById('auth-gate');
  const shell = document.getElementById('app-shell');
  if (gate) gate.hidden = false;
  if (shell) shell.hidden = true;
  CURRENT_USER = null;
}

function hideAuth() {
  const gate = document.getElementById('auth-gate');
  const shell = document.getElementById('app-shell');
  if (gate) gate.hidden = true;
  if (shell) shell.hidden = false;
}

function setAuthError(msg) {
  const el = document.getElementById('auth-error');
  if (!el) return;
  if (!msg) { el.hidden = true; el.textContent = ''; return; }
  el.hidden = false;
  el.textContent = msg;
}

function updateAuthFormMode() {
  const sub = document.getElementById('auth-sub');
  const btn = document.getElementById('auth-submit');
  const switchText = document.getElementById('auth-switch-text');
  const toggle = document.getElementById('auth-toggle');
  if (authMode === 'register') {
    if (sub) sub.textContent = 'Create your private job portal account';
    if (btn) btn.textContent = 'Create account';
    if (switchText) switchText.textContent = 'Already have an account?';
    if (toggle) toggle.textContent = 'Log in';
  } else {
    if (sub) sub.textContent = 'Sign in to your private job portal';
    if (btn) btn.textContent = 'Log in';
    if (switchText) switchText.textContent = 'No account?';
    if (toggle) toggle.textContent = 'Create one';
  }
  setAuthError('');
}

async function checkAuth() {
  try {
    const st = await api('/api/auth/status');
    if (st.authenticated && st.user) {
      CURRENT_USER = st.user;
      hideAuth();
      return true;
    }
    if (st.needs_setup) {
      authMode = 'register';
      updateAuthFormMode();
      const sub = document.getElementById('auth-sub');
      if (sub) sub.textContent = 'Create the first (admin) account for your team';
    }
    showAuth();
    return false;
  } catch (e) {
    showAuth();
    return false;
  }
}

async function doLogin(username, password) {
  setAuthError('');
  try {
    const res = await api('/api/auth/login', { method: 'POST', json: { username, password } });
    CURRENT_USER = res.user;
    hideAuth();
    toast('Welcome, ' + (res.user.display_name || res.user.username));
    await bootApp();
  } catch (e) {
    setAuthError(e.message || 'Username or password incorrect');
  }
}

async function doRegister(username, password) {
  setAuthError('');
  try {
    const res = await api('/api/auth/register', { method: 'POST', json: { username, password, display_name: username } });
    CURRENT_USER = res.user;
    hideAuth();
    toast(res.is_first_admin ? 'Admin account created — you can manage the team' : 'Account created');
    await bootApp();
  } catch (e) {
    setAuthError(e.message || 'Could not create account');
  }
}

async function doSocial(provider) {
  setAuthError('');
  // Lightweight client-side identity for team demos (real OAuth needs provider keys)
  const email = prompt(`Enter the email linked to your ${provider} account:`) || '';
  const name = prompt('Display name (optional):') || email.split('@')[0] || provider + '_user';
  if (!email && !name) {
    setAuthError('Email or name required for social sign-in');
    return;
  }
  try {
    const res = await api('/api/auth/social', {
      method: 'POST',
      json: { provider, email, name, sub: email || name }
    });
    CURRENT_USER = res.user;
    hideAuth();
    toast('Signed in with ' + provider);
    await bootApp();
  } catch (e) {
    setAuthError(e.message || 'Social sign-in failed');
  }
}

async function doLogout() {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch (_) {}
  CURRENT_USER = null;
  S = null;
  showAuth();
  authMode = 'login';
  updateAuthFormMode();
}

function wireAuth() {
  const form = document.getElementById('auth-form');
  const toggle = document.getElementById('auth-toggle');
  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const u = (document.getElementById('auth-user').value || '').trim();
      const p = document.getElementById('auth-pass').value || '';
      if (authMode === 'register') await doRegister(u, p);
      else await doLogin(u, p);
    });
  }
  if (toggle) {
    toggle.addEventListener('click', () => {
      authMode = authMode === 'login' ? 'register' : 'login';
      updateAuthFormMode();
    });
  }
  document.querySelectorAll('.auth-social [data-provider]').forEach(btn => {
    btn.addEventListener('click', () => doSocial(btn.dataset.provider));
  });
}



/* ---------------- state ---------------- */
let S = null, jobs = [], jobsKey = '';
let view = (location.hash || '#jobs').slice(1);
let roles = [], cities = [], portalPick = [], modes = [], tiers = [], types = [];
let filter = 'all';
const sel = new Set();
let searching = false, filtersOpen = false;
const MODES = [['remote', 'Remote'], ['hybrid', 'Hybrid'], ['wfo', 'On-site']];
const TIERS = [
  ['tier1', 'Tier 1 — Top / large'],
  ['tier2', 'Tier 2 — Mid-size'],
  ['tier3', 'Tier 3 — Startup / small'],
];
const TYPES = [['mnc', 'MNC'], ['product', 'Product'], ['startup', 'Startup'], ['service', 'IT services']];

const STATUS = {
  new: ['Ready to apply', ''], applying: ['Applying…', ''], ready: ['Form ready', 'Approve & submit'],
  needs_human: ['Needs you', ''], applied: ['Applied', ''], failed: ['Failed', ''], skipped: ['Skipped', ''], manual: ['You apply', ''],
};
const FILTERS = [['all', 'All'], ['new', 'To apply'], ['wait', 'Waiting'], ['applied', 'Applied'], ['skipped', 'Skipped']];
const inFilter = (j, f) => f === 'all' || (f === 'new' && ['new', 'applying'].includes(j.status)) ||
  (f === 'wait' && ['ready', 'needs_human', 'failed', 'manual'].includes(j.status)) || (f === 'applied' && j.status === 'applied') || (f === 'skipped' && j.status === 'skipped');

/* ---------------- theme ---------------- */
function setTheme(t) {
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem('jp-theme', t); } catch (e) {}
  $('#theme').setAttribute('aria-checked', String(t === 'dark'));
  const mt = document.getElementById('meta-theme'); if (mt) mt.content = t === 'dark' ? '#0b0f1a' : '#f4f6fb';
}
const toggleTheme = () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
$('#theme').onclick = toggleTheme;
$('#m-theme').onclick = toggleTheme;
setTheme(document.documentElement.dataset.theme);

/* ---------------- header + nav ---------------- */
const TABS = [
  // admin tab injected when user is admin

  ['jobs', 'Jobs', 'Search · match · auto-apply'],
  ['resume', 'Resume', 'Upload once — profile auto-fills'],
  ['portals', 'Portals', 'Connect logins for auto-apply'],
  ['settings', 'Settings', 'Limits · notifications · behaviour'],
];
const ICONS = {
  jobs: '<rect x="3" y="7" width="18" height="13" rx="2.5"/><path d="M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7"/><path d="M3 12.5h18"/>',
  resume: '<path d="M14 3H7.5A2.5 2.5 0 0 0 5 5.5v13A2.5 2.5 0 0 0 7.5 21h9a2.5 2.5 0 0 0 2.5-2.5V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>',
  portals: '<path d="M10 13a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 11a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  settings: '<path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2.2"/><circle cx="8" cy="17" r="2.2"/>',
};
function icon(id) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', '1.8'); s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round');
  s.setAttribute('aria-hidden', 'true'); s.innerHTML = ICONS[id]; return s;
}
function renderNav() {
  const mk = ([id, label]) => h('button', { type: 'button', 'aria-current': view === id ? 'page' : null, onclick: () => go(id) }, icon(id), h('span', {}, label));
  $('#nav').replaceChildren(...TABS.map(mk));
  $('#tabbar').replaceChildren(...TABS.map(mk));
  document.querySelectorAll('.view').forEach(v => v.hidden = v.id !== 'v-' + view);
  const tab = TABS.find(t => t[0] === view) || TABS[0];
  const title = $('#page-title'); const sub = $('#page-sub');
  if (title) title.textContent = tab[1];
  if (sub) sub.textContent = tab[2];
}
function go(v) { view = v; location.hash = v; renderNav(); renderView(); updateDock(); closeCfg(); }
window.addEventListener('hashchange', () => { const v = location.hash.slice(1); if (v && v !== view && TABS.some(t => t[0] === v)) go(v); });

(function livePill() {
  const el = $('#live-pill'); if (!el) return;
  const hn = location.hostname;
  el.textContent = (hn === 'localhost' || hn === '127.0.0.1' || hn === '') ? 'Local · ' + (hn || 'file') : 'Online';
})();

function renderLeds() {
  const led = (on, label, key) => h('button', {
    class: 'led' + (on ? ' on' : ''),
    type: 'button',
    title: 'Configure ' + label,
    onclick: () => openCfg(key),
  }, h('i', { class: 'dot' + (on ? ' on' : '') }), label);
  $('#leds').replaceChildren(
    led(S.ai_enabled, 'AI', 'ai'),
    led(S.email_enabled, 'Email', 'email'),
    led(S.push_enabled, 'Alert', 'alert'),
  );
}
const toggleLog = () => { closeCfg(); const p = $('#logpane'); p.hidden = !p.hidden; renderLog(); };
$('#log-btn').onclick = toggleLog;
$('#m-log').onclick = toggleLog;
$('#m-leds').onclick = () => openCfg('menu');
$('#log-close').onclick = () => $('#logpane').hidden = true;

/* scrim behind slide panes + Esc to close */
const syncScrim = () => { $('#scrim').hidden = $('#cfgpane').hidden && $('#logpane').hidden; };
new MutationObserver(syncScrim).observe($('#cfgpane'), { attributes: true, attributeFilter: ['hidden'] });
new MutationObserver(syncScrim).observe($('#logpane'), { attributes: true, attributeFilter: ['hidden'] });
$('#scrim').onclick = () => { $('#cfgpane').hidden = true; $('#logpane').hidden = true; };
document.addEventListener('keydown', e => { if (e.key === 'Escape') $('#scrim').click(); });
function renderLog() {
  if ($('#logpane').hidden) return;
  const pre = $('#logtext'), atEnd = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 30;
  pre.textContent = S.log.join('\n') || 'No activity yet. Start a search to see steps here.';
  if (atEnd) pre.scrollTop = pre.scrollHeight;
}

/* ---------------- config pane (AI / Email / Alert) ---------------- */
function closeCfg() { $('#cfgpane').hidden = true; }
$('#cfg-close').onclick = closeCfg;

function openCfg(which) {
  $('#logpane').hidden = true;
  const pane = $('#cfgpane');
  pane.hidden = false;
  const title = { menu: 'AI · Email · Alerts', ai: 'AI scoring', email: 'Email notifications', alert: 'Phone / push alerts' }[which] || 'Configure';
  $('#cfg-title').textContent = title;
  const body = $('#cfg-body');
  const n = S.notify || {};

  if (which === 'menu') {
    const row = (on, label, sub, key) => h('button', { class: 'btn menu-row', type: 'button', onclick: () => openCfg(key) },
      h('i', { class: 'dot' + (on ? ' on' : '') }), h('span', {}, h('b', {}, label), h('small', {}, sub)), h('span', { class: 'go-arrow' }, '›'));
    body.replaceChildren(
      h('p', { class: 'hint' }, 'Tap one to configure. A green dot means it is switched on.'),
      row(S.ai_enabled, 'AI scoring', S.ai_enabled ? 'On' : 'Off — keyword match only', 'ai'),
      row(S.email_enabled, 'Email notifications', S.email_enabled ? 'On' : 'Off', 'email'),
      row(S.push_enabled, 'Phone push alerts', S.push_enabled ? 'On' : 'Off', 'alert'));
    return;
  }

  if (which === 'ai') {
    body.replaceChildren(
      h('p', { class: 'hint' }, S.ai_enabled
        ? 'AI is on. JobPilot blends keyword match with Claude scoring and can write short cover notes on company forms.'
        : 'AI is off. Add an Anthropic API key in your .env file (ANTHROPIC_API_KEY=…) and restart JobPilot for smarter match scores + cover notes.'),
      h('div', { class: 'field' },
        h('label', {}, 'Status'),
        h('input', { value: S.ai_enabled ? 'Enabled' : 'Keyword-only (no API key)', disabled: true })),
      h('p', { class: 'hint', style: 'margin-top:12px' }, 'Edit the .env next to the app, then restart. Model can be set with LLM_MODEL.'),
    );
    return;
  }

  if (which === 'alert') {
    body.replaceChildren(
      h('p', { class: 'hint' }, 'Free push alerts via ntfy.sh — install the ntfy app on your phone, create a private topic, paste it below. No phone number needed.'),
      h('div', { class: 'field' },
        h('label', {}, 'ntfy topic'),
        h('input', { id: 'cfg-ntfy', value: n.ntfy_topic || '', placeholder: 'e.g. my-jobpilot-secret' })),
      h('div', { class: 'cfg-actions' },
        h('button', { class: 'go', onclick: guard(saveAlertCfg) }, 'Save'),
        h('button', { class: 'btn', onclick: guard(testNotify) }, 'Send test')),
      h('p', { class: 'hint', style: 'margin-top:14px' }, 'When a job is auto-applied or needs your help, you get a push on that topic.'),
    );
    return;
  }

  // email
  body.replaceChildren(
    h('p', { class: 'hint' }, 'Configure your email once. Every successful auto-apply (and batch finish / needs-you events) is mailed to you.'),
    h('div', { class: 'field' },
      h('label', {}, 'SMTP host'),
      h('input', { id: 'cfg-host', value: n.smtp_host || 'smtp.gmail.com', placeholder: 'smtp.gmail.com' })),
    h('div', { class: 'field' },
      h('label', {}, 'SMTP port'),
      h('input', { id: 'cfg-port', type: 'number', value: n.smtp_port || 587 })),
    h('div', { class: 'field' },
      h('label', {}, 'SMTP user (login email)'),
      h('input', { id: 'cfg-user', value: n.smtp_user || '', placeholder: 'you@gmail.com', autocomplete: 'username' })),
    h('div', { class: 'field' },
      h('label', {}, 'SMTP password / app password'),
      h('input', { id: 'cfg-pass', type: 'password', value: '', placeholder: n.has_pass ? '•••••••• (leave blank to keep)' : 'App password', autocomplete: 'new-password' })),
    h('div', { class: 'field' },
      h('label', {}, 'Send notifications to'),
      h('input', { id: 'cfg-to', value: n.notify_email || '', placeholder: 'same as login or another inbox' })),
    h('div', { class: 'cfg-actions' },
      h('button', { class: 'go', onclick: guard(saveEmailCfg) }, 'Save email'),
      h('button', { class: 'btn', onclick: guard(testNotify) }, 'Send test')),
    h('p', { class: 'hint', style: 'margin-top:14px' }, 'Gmail: enable 2FA → create an App Password → paste it here. Settings are stored only on your PC (data/notify.json).'),
  );
}

async function saveEmailCfg() {
  const data = {
    smtp_host: $('#cfg-host').value.trim(),
    smtp_port: +$('#cfg-port').value || 587,
    smtp_user: $('#cfg-user').value.trim(),
    notify_email: $('#cfg-to').value.trim(),
  };
  const pass = $('#cfg-pass').value;
  if (pass) data.smtp_pass = pass;
  await api('/api/notify', { method: 'PUT', json: { data } });
  toast('Email settings saved');
  await refresh();
  openCfg('email');
}

async function saveAlertCfg() {
  await api('/api/notify', { method: 'PUT', json: { data: { ntfy_topic: $('#cfg-ntfy').value.trim() } } });
  toast('Alert topic saved');
  await refresh();
  openCfg('alert');
}

async function testNotify() {
  const r = await api('/api/test-notify', { method: 'POST' });
  toast(r.sent ? 'Test sent — check your inbox / ntfy app' : 'Could not send. Check email / topic settings.');
}

/* ---------------- autopilot (progress + STOP) ---------------- */
function renderAutopilot() {
  const box = $('#auto'), r = S.run;
  if (!r.running) { box.hidden = true; box.replaceChildren(); return; }
  box.hidden = false;
  const pct = r.total ? Math.min(100, Math.round(100 * r.done / r.total)) : 0;
  const title = r.stopping ? 'Stopping…' : r.label || 'Working…';
  const isLogin = (r.phase === 'login') || /log in/i.test(r.label || '') || /log in/i.test(r.current || '');
  const kids = [
    h('div', {}, h('b', {}, title), h('small', {}, r.current || (isLogin ? 'Complete login in the browser window (OTP / captcha ok)' : ''))),
    h('div', { class: 'ap-actions' },
      isLogin && h('button', { class: 'go', onclick: guard(confirmLoggedIn) }, "I'm logged in"),
      h('button', { class: 'stop', disabled: r.stopping, onclick: guard(stopAll) }, h('i'), 'Stop')),
    h('div', { class: 'track' }, h('div', { class: 'fill', style: `width:${pct}%` })),
  ];
  if (isLogin) {
    kids.push(h('div', { class: 'login-hint' },
      '1) Browser window opens → 2) Log in on Naukri / foundit / etc. → 3) Come back here and press ',
      h('b', {}, "I'm logged in")));
  }
  box.replaceChildren(h('div', { class: 'ap' }, ...kids));
}
async function stopAll() { await api('/api/stop', { method: 'POST' }); toast('Stopping…'); await refresh(); }

/* ---------------- Jobs view ---------------- */
function chipToggle(list, key, label, onchange) {
  const pressed = list.includes(key);
  return h('button', { class: 'chip', 'aria-pressed': pressed ? 'true' : 'false', onclick: e => {
    const i = list.indexOf(key); i < 0 ? list.push(key) : list.splice(i, 1);
    e.currentTarget.setAttribute('aria-pressed', list.includes(key) ? 'true' : 'false');
    onchange && onchange();
  } }, label);
}

function buildJobsView() {
  const v = $('#v-jobs');

  const cityRow = h('div', { class: 'chips', id: 'city-row' });
  const portalRow = h('div', { class: 'chips', id: 'portal-row' });
  const panel = h('div', { class: 'panel' },
    h('div', { class: 'card' },
      h('div', { class: 'grp' }, h('h3', {}, 'Cities'), cityRow),
      h('div', { class: 'grp' }, h('h3', {}, 'Work style'), h('div', { class: 'chips' }, ...MODES.map(([k, l]) => chipToggle(modes, k, l)))),
      h('div', { class: 'grp' },
        h('h3', {}, 'Company tier'),
        h('div', { class: 'chips' }, ...TIERS.map(([k, l]) => chipToggle(tiers, k, l))),
        h('p', { class: 'tier-hint' }, 'Tier 1 = FAANG / large product & MNC · Tier 2 = mid-size · Tier 3 = startups & small firms. Leave all on to search everything.')),
      h('div', { class: 'grp' }, h('h3', {}, 'Company type'), h('div', { class: 'chips' }, ...TYPES.map(([k, l]) => chipToggle(types, k, l)))),
      h('div', { class: 'grp' }, h('h3', {}, 'Search on'), portalRow),
    ));

  const input = h('input', { id: 'role-in', placeholder: roles.length ? 'Add another role…' : 'e.g. Backend Engineer, DevOps', 'aria-label': 'Job role', onkeydown: e => {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addRole(input.value); input.value = ''; }
    if (e.key === 'Backspace' && !input.value && roles.length) { roles.pop(); renderRoleChips(); }
  } });
  const chips = h('div', { class: 'chips', id: 'role-chips' });
  const sugg = h('div', { class: 'suggest', id: 'sugg' });

  const hero = h('div', { class: 'hero' },
    h('h2', {}, 'Multi-location job search'),
    h('p', {}, 'Search once across cities · match to your resume · auto-apply on portals & company career pages.'),
    h('div', { class: 'role-row', style: 'margin-bottom:10px' },
      h('span', { style: 'font-size:12px;font-weight:700;color:var(--mute)' }, 'Roles'),
      chips, input),
    h('div', { class: 'role-row' },
      h('span', { style: 'font-size:12px;font-weight:700;color:var(--mute)' }, 'Locations'),
      h('span', { id: 'loc-label', style: 'font-size:12px;color:var(--mute)' }, cities.length ? cities.join(', ') : 'Pick cities in Filters (multi-location)'),
      h('button', { class: 'go', id: 'go', onclick: guard(doSearch) }, 'Search jobs')),
    sugg);

  panel.classList.toggle('open', filtersOpen);
  const summ = () => cities.length ? cities.length + (cities.length > 1 ? ' cities' : ' city') : 'All cities';
  const fcount = h('span', { class: 'fcount' }, summ());
  const toggle = h('button', { class: 'filter-toggle', type: 'button', 'aria-expanded': String(filtersOpen), onclick: () => {
    filtersOpen = !filtersOpen; panel.classList.toggle('open', filtersOpen); toggle.setAttribute('aria-expanded', String(filtersOpen));
    fcount.textContent = summ();
  } },
    h('span', { class: 'ft-label' }, 'Filters'), h('span', { class: 'ft-sub' }, 'cities · work style · company'), fcount,
    (() => { const s = icon('jobs'); s.innerHTML = '<path d="M6 9l6 6 6-6"/>'; s.classList.add('chev'); s.setAttribute('width', 18); s.setAttribute('height', 18); return s; })());

  const right = h('div', { style: 'min-width:0' }, hero, h('div', { class: 'bar', id: 'bar' }), h('div', { id: 'list' }));
  v.replaceChildren(h('div', { class: 'jobs-layout' }, h('div', { class: 'filters-col' }, toggle, panel), right));
  renderRoleChips(); renderCities(); renderPortalPick(); renderJobs();
}

function renderRoleChips() {
  const el = $('#role-chips');
  if (!el) return;
  el.replaceChildren(...roles.map(r => h('span', { class: 'chip role' }, r,
    h('button', { 'aria-label': 'Remove ' + r, onclick: () => { roles = roles.filter(x => x !== r); renderRoleChips(); } }, '×'))));
  const have = new Set(roles.map(r => r.toLowerCase()));
  const ideas = (S.profile.target_roles || []).filter(r => !have.has(r.toLowerCase()));
  const s = $('#sugg'); if (!s) return;
  s.replaceChildren();
  if (ideas.length) s.append('From your resume: ', ...ideas.slice(0, 6).map(r => h('button', { onclick: () => addRole(r) }, '+ ' + r)));
  else if (!S.resume) s.append(h('span', {}, 'Upload your resume first for role suggestions. '), h('a', { href: '#resume' }, 'Go to Resume'));
}
function addRole(r) { r = r.trim().replace(/,$/, ''); if (r && !roles.some(x => x.toLowerCase() === r.toLowerCase())) roles.push(r); renderRoleChips(); }

function updateLocLabel() {
  const fc = document.querySelector('.filter-toggle .fcount');
  if (fc) fc.textContent = cities.length ? cities.length + (cities.length > 1 ? ' cities' : ' city') : 'All cities';
  const el = $('#loc-label');
  if (el) el.textContent = cities.length ? cities.join(', ') : 'Pick cities in Filters (multi-location)';
}

function renderCities() {
  const el = $('#city-row'); if (!el) return;
  const presets = new Set((S.city_presets || []).map(c => c.toLowerCase()));
  const custom = cities.filter(c => !presets.has(c.toLowerCase()));
  el.replaceChildren(
    ...(S.city_presets || []).map(c => chipToggle(cities, c, c, () => { updateLocLabel(); })),
    ...custom.map(c => h('button', { class: 'chip', 'aria-pressed': 'true', onclick: () => {
      cities = cities.filter(x => x.toLowerCase() !== c.toLowerCase());
      renderCities();
    } }, c, ' ×')),
    h('input', { class: 'chip', style: 'width:120px;cursor:text', placeholder: '+ city', 'aria-label': 'Add city', onkeydown: e => {
      if (e.key === 'Enter' && e.target.value.trim()) {
        const v = e.target.value.trim();
        if (!cities.some(x => x.toLowerCase() === v.toLowerCase())) cities.push(v);
        renderCities();
      }
    }})
  );
  updateLocLabel();
}

function renderPortalPick() {
  const el = $('#portal-row'); if (!el) return;
  const auto = S.portals.filter(p => p.auto);
  el.replaceChildren(
    ...auto.map(p => h('button', { class: 'chip', 'aria-pressed': portalPick.includes(p.id) ? 'true' : 'false', onclick: e => {
      const i = portalPick.indexOf(p.id); i < 0 ? portalPick.push(p.id) : portalPick.splice(i, 1);
      e.currentTarget.setAttribute('aria-pressed', portalPick.includes(p.id) ? 'true' : 'false'); } },
      h('i', { class: 'dot' + (p.connected ? ' on' : '') }), p.name)),
    h('button', { class: 'chip', 'aria-pressed': 'true', title: 'Always included', style: 'opacity:.85' },
      h('i', { class: 'dot on' }), 'Company pages'),
    h('a', { href: '#portals', style: 'font-size:12px;font-weight:600;margin-left:4px' }, 'Connect →'));
}

async function doSearch() {
  if (!roles.length) { const v = $('#role-in')?.value; if (v?.trim()) addRole(v); }
  if (!roles.length) return toast('Add at least one role first');
  if (S.run.running) return toast('Already running. Stop it first.');
  searching = true;
  // Clear previous unapplied jobs so results match the current location / tier / type filters
  try { await api('/api/jobs/clear', { method: 'POST' }); jobs = []; sel.clear(); } catch (e) {}
  const portals = portalPick.length ? portalPick : S.portals.filter(p => p.auto).map(p => p.id);
  const r = await api('/api/search', { json: {
    roles,
    locations: cities.slice(),
    work_modes: modes.length ? modes.slice() : ['remote', 'hybrid', 'wfo'],
    company_tiers: tiers.length ? tiers.slice() : ['tier1', 'tier2', 'tier3'],
    company_types: types.length ? types.slice() : ['mnc', 'product', 'startup', 'service'],
    portals: portals.slice(),
  }});
  toast(r.started ? 'Searching with your filters (locations, company tier, type)…' : 'Busy. Try again shortly.');
  await refresh(true);
}

function scoreColor(n) { return n >= 75 ? 'var(--green)' : n >= 55 ? 'var(--teal)' : 'var(--amber)'; }
function pass(j) {
  const [label] = STATUS[j.status] || [j.status];
  const portal = S.portals.find(p => p.id === j.source);
  const canSel = j.apply_mode === 'auto' && ['new', 'failed', 'needs_human'].includes(j.status);
  const srcName = portal ? portal.name : (j.source || '').startsWith('greenhouse') || (j.source || '').startsWith('lever') || (j.source || '').startsWith('ashby')
    ? 'Company site' : (j.source || '').split(':')[0];
  const tags = [
    j.location && h('span', { class: 'tag' }, j.location),
    j.work_mode && h('span', { class: 'tag ' + j.work_mode }, { remote: 'Remote', hybrid: 'Hybrid', wfo: 'On-site' }[j.work_mode] || j.work_mode),
    j.exp && h('span', { class: 'tag' }, j.exp),
    j.salary && h('span', { class: 'tag' }, j.salary),
    j.company_tier && h('span', { class: 'tag' }, j.company_tier.replace('tier', 'T')),
    h('span', { class: 'tag src' }, srcName),
  ];
  const acts = [
    h('a', { class: 'btn', href: j.url, target: '_blank', rel: 'noopener' }, 'Open'),
    j.status === 'ready' && h('button', { class: 'btn pri', onclick: guard(() => act(`/api/jobs/${j.id}/approve`, 'Submitting…')) }, 'Approve & submit'),
    ['failed', 'needs_human'].includes(j.status) && j.apply_mode === 'auto' && h('button', { class: 'btn', onclick: guard(() => act(`/api/jobs/${j.id}/retry`, 'Retrying…')) }, 'Retry'),
    ['new', 'manual', 'needs_human', 'ready', 'failed'].includes(j.status) && h('button', { class: 'btn', onclick: guard(() => setStatus(j.id, 'applied')) }, 'I applied'),
    ['new', 'manual', 'needs_human', 'failed'].includes(j.status) && h('button', { class: 'btn ghost', onclick: guard(() => setStatus(j.id, 'skipped')) }, 'Skip'),
    j.status === 'skipped' && h('button', { class: 'btn', onclick: guard(() => setStatus(j.id, 'new')) }, 'Restore'),
    ['ready', 'applied', 'needs_human', 'failed'].includes(j.status) && j.apply_mode === 'auto' && h('a', { class: 'btn ghost', href: `/shots/job_${j.id}.png`, target: '_blank' }, 'Screenshot'),
  ];
  const note = j.note || (j.reason && j.status === 'new' ? j.reason : '');
  return h('article', { class: `pass s-${j.status}` + (sel.has(j.id) ? ' sel-on' : '') + (canSel ? '' : ' nosel') },
    h('div', { class: 'sel' }, canSel ? h('input', { type: 'checkbox', 'aria-label': 'Select ' + j.title, checked: sel.has(j.id), onchange: e => { e.target.checked ? sel.add(j.id) : sel.delete(j.id); renderJobs(); } }) : null),
    h('div', { class: 'main' }, h('h3', {}, j.title), h('p', { class: 'co' }, j.company), h('div', { class: 'tags' }, tags),
      j.matched && j.matched.length ? h('div', { class: 'kw' }, 'Matched skills: ', h('b', {}, j.matched.slice(0, 6).join(', '))) : null),
    h('div', { class: 'stub' },
      h('div', { class: 'score' }, h('div', { class: 'ring', style: `--p:${j.score};--c:${scoreColor(j.score)}`, title: 'Match score' }, h('span', {}, j.score)),
        h('div', { class: 'st' }, h('div', { class: 'state' }, label), h('span', { class: 'badge ' + j.apply_mode }, j.apply_mode === 'auto' ? 'Auto' : 'Manual'))),
      note ? h('div', { class: 'note' }, note) : null,
      j.applied_by ? h('div', { class: 'note' }, j.applied_by === 'ai' ? 'Applied by JobPilot' : 'Applied by you') : null,
      h('div', { class: 'acts' }, acts)));
}
async function act(path, msg) { const r = await api(path, { method: 'POST' }); toast(r.started ? msg : 'Busy. Try again.'); await refresh(true); }
async function setStatus(id, s) { await api(`/api/jobs/${id}/status`, { json: { status: s } }); await refresh(true); }

function renderJobs() {
  if (!$('#list')) return;
  const counts = Object.fromEntries(FILTERS.map(([k]) => [k, jobs.filter(j => inFilter(j, k)).length]));
  $('#bar').replaceChildren(
    h('h2', {}, jobs.length ? `${jobs.length} jobs` : 'Jobs'),
    ...FILTERS.map(([k, l]) => h('button', { class: 'pill', 'aria-pressed': filter === k, onclick: () => { filter = k; renderJobs(); } }, l, h('b', {}, counts[k]))),
    jobs.some(j => j.status !== 'applied') ? h('button', { class: 'btn danger', onclick: guard(clearJobs) }, 'Clear unapplied') : null);
  const list = jobs.filter(j => inFilter(j, filter));
  const el = $('#list');
  if (!list.length) {
    el.replaceChildren(h('div', { class: 'empty' },
      h('b', {}, jobs.length ? 'Nothing in this filter' : 'No jobs yet'),
      jobs.length ? 'Try another filter or run a new search.' : 'Add roles, pick Tier 1 / 2 / 3 companies you want, then press Find jobs.'));
  } else {
    el.replaceChildren(...list.map(pass));
  }
  updateDock();
}

async function clearJobs() {
  if (!confirm('Remove all jobs that are not marked Applied?')) return;
  await api('/api/jobs/clear', { method: 'POST' });
  jobs = []; sel.clear(); toast('Cleared'); await refresh();
}

/* ---------------- dock: select + full auto apply ---------------- */
function updateDock() {
  const dock = $('#dock');
  if (view !== 'jobs' || !jobs.length) { dock.hidden = true; dock.replaceChildren(); document.body.classList.remove('has-dock'); return; }
  dock.hidden = false; document.body.classList.add('has-dock');
  const autoJobs = jobs.filter(j => j.apply_mode === 'auto' && ['new', 'failed', 'needs_human'].includes(j.status));
  const strong = autoJobs.filter(j => j.score >= (S.prefs?.min_score || 55));
  const n = sel.size;
  const autoOn = !!(S.prefs?.auto_submit);
  dock.replaceChildren(
    h('span', { class: 'count' }, n ? `${n} selected` : `${autoJobs.length} ready`),
    h('button', { class: 'btn', onclick: () => { strong.forEach(j => sel.add(j.id)); renderJobs(); } }, 'Select strong'),
    h('button', { class: 'btn hide-m', onclick: () => { autoJobs.forEach(j => sel.add(j.id)); renderJobs(); } }, 'Select all auto'),
    h('button', { class: 'btn ghost', onclick: () => { sel.clear(); renderJobs(); } }, 'Clear'),
    h('button', {
      class: 'go',
      disabled: !n || S.run.running,
      onclick: guard(autoApply),
      title: autoOn ? 'Fills profile fields + uploads resume + submits automatically' : 'Fills forms, then waits for your Approve',
    }, autoOn ? 'Auto apply (fill + submit)' : 'Fill forms (review mode)'),
    h('label', { class: 'switch' },
      h('input', {
        type: 'checkbox',
        checked: autoOn,
        onchange: guard(async e => {
          const data = { ...S.prefs, auto_submit: e.target.checked };
          await api('/api/prefs', { method: 'PUT', json: { data } });
          toast(e.target.checked ? 'Full auto-submit ON — bot will submit after filling' : 'Review mode — bot fills, you approve');
          await refresh();
        }),
      }),
      'Full auto-submit'),
    h('span', { class: 'hint' }, autoOn
      ? 'Bot fills every field from your resume and submits. Success emails go to your configured inbox.'
      : 'Bot fills the form and pauses. Press Approve & submit on each job.'),
  );
}

async function autoApply() {
  if (!sel.size) return toast('Select jobs first');
  if (S.run.running) return toast('Already running');
  const submit = !!(S.prefs?.auto_submit);
  const r = await api('/api/apply', { json: { ids: [...sel], submit } });
  toast(r.started
    ? (submit ? 'Auto-applying: filling forms + submitting…' : 'Filling forms (review mode)…')
    : 'Busy. Try again.');
  sel.clear();
  await refresh(true);
}

/* ---------------- Resume view ---------------- */
const FIELDS = [
  ['first_name', 'First name'], ['last_name', 'Last name'], ['email', 'Email'], ['phone', 'Phone'],
  ['linkedin', 'LinkedIn URL'], ['github', 'GitHub'], ['website', 'Portfolio / website'],
  ['location', 'Current city'], ['current_company', 'Current company'], ['current_title', 'Current title'],
  ['years_experience', 'Years of experience'], ['notice_period', 'Notice period'],
  ['current_ctc', 'Current CTC'], ['expected_ctc', 'Expected CTC'],
];

function fieldVal(p, k) {
  const v = p[k];
  if (v == null || v === '') return '';
  return String(v);
}
function isFilled(p, k) {
  const v = p[k];
  if (Array.isArray(v)) return v.length > 0;
  return v != null && String(v).trim() !== '' && v !== 0;
}
function buildResumeView() {
  const v = $('#v-resume');
  const r = S.resume;
  const p = S.profile || {};
  const filledCount = FIELDS.filter(([k]) => isFilled(p, k)).length
    + (isFilled(p, 'skills') ? 1 : 0) + (isFilled(p, 'target_roles') ? 1 : 0);
  const totalFields = FIELDS.length + 2;

  const fileIn = h('input', { type: 'file', accept: '.pdf,.docx,.txt', hidden: true, onchange: e => guard(upload)(e.target.files[0]) });
  const drop = h('div', {
    class: 'drop',
    onclick: () => fileIn.click(),
    ondragover: e => { e.preventDefault(); drop.classList.add('over'); },
    ondragleave: () => drop.classList.remove('over'),
    ondrop: e => { e.preventDefault(); drop.classList.remove('over'); guard(upload)(e.dataTransfer.files[0]); },
  },
    h('b', {}, r ? 'Drop a new resume to replace' : 'Drop your resume here'),
    'PDF · DOCX · TXT — we extract name, email, phone, skills, roles, CTC & notice automatically');
  drop.append(fileIn);

  const left = h('div', {},
    h('h2', { class: 'section-title' }, 'Resume file'),
    h('p', { class: 'section-sub' }, 'Upload once. Every apply form is filled from this profile — no re-typing.'),
    r ? h('div', { class: 'file' },
      h('div', { class: 'ext' }, (r.ext || 'pdf').toUpperCase()),
      h('div', { style: 'min-width:0;flex:1' },
        h('b', {}, r.name),
        h('div', { class: 'muted', style: 'font-size:12px' }, `${r.kb} KB · ${r.modified}`),
        h('div', { class: 'row', style: 'margin-top:8px' },
          h('a', { class: 'btn', href: '/api/resume/file' }, 'Download'),
          h('button', { class: 'btn', onclick: () => fileIn.click() }, 'Replace'))))
      : null,
    drop,
    filledCount > 2 ? h('div', { class: 'profile-banner', style: 'margin-top:14px' },
      h('div', {},
        h('strong', {}, `Profile loaded · ${filledCount}/${totalFields} fields`),
        'Edit anything below if needed, then Save. Target roles feed the Jobs search suggestions.'))
      : null);

  const fields = h('div', { class: 'card' },
    h('h2', { class: 'section-title' }, 'Auto-loaded profile'),
    h('p', { class: 'section-sub' }, 'Parsed from your resume. Highlighted fields were filled automatically.'),
    (p.summary ? h('div', { class: 'field filled', style: 'margin-bottom:12px' },
      h('label', {}, 'Summary'),
      h('textarea', { rows: 2, value: p.summary || '', 'data-k': 'summary', onchange: e => p.summary = e.target.value })) : null),
    (p.education ? h('div', { class: 'field filled', style: 'margin-bottom:12px' },
      h('label', {}, 'Education'),
      h('input', { value: p.education || '', 'data-k': 'education', onchange: e => p.education = e.target.value })) : null),
    h('div', { class: 'grid2' }, ...FIELDS.map(([k, lab]) =>
      h('div', { class: 'field' + (isFilled(p, k) ? ' filled' : '') },
        h('label', {}, lab),
        h('input', { value: fieldVal(p, k), 'data-k': k, onchange: e => p[k] = e.target.value })))),
    h('div', { class: 'field' + (isFilled(p, 'skills') ? ' filled' : ''), style: 'margin-top:12px' },
      h('label', {}, 'Skills (comma separated)'),
      h('textarea', { rows: 3, value: (p.skills || []).join(', '), onchange: e => p.skills = e.target.value.split(',').map(s => s.trim()).filter(Boolean) })),
    h('div', { class: 'field' + (isFilled(p, 'target_roles') ? ' filled' : ''), style: 'margin-top:12px' },
      h('label', {}, 'Target roles (auto-suggested from resume)'),
      h('textarea', { rows: 2, value: (p.target_roles || []).join(', '), onchange: e => p.target_roles = e.target.value.split(',').map(s => s.trim()).filter(Boolean) })),
    h('div', { class: 'row', style: 'margin-top:16px' },
      h('button', { class: 'go', onclick: guard(saveProfile) }, 'Save profile'),
      filledCount > 2 ? h('button', { class: 'btn pri', onclick: () => go('jobs') }, 'Continue to Jobs →') : null));

  v.replaceChildren(h('div', { class: 'resume-grid' }, left, fields));
}
async function upload(f) {
  if (!f) return;
  toast('Parsing resume… extracting full profile');
  const fd = new FormData(); fd.append('file', f);
  const res = await fetch('/api/resume', { method: 'POST', body: fd });
  const r = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(r.detail || r.error || 'Upload failed');
  await refresh(true);
  const p = S.profile || {};
  const n = ['first_name','email','phone','skills','target_roles','years_experience']
    .filter(k => (Array.isArray(p[k]) ? p[k].length : p[k])).length;
  toast(n >= 3
    ? `Resume loaded — ${n}+ profile fields filled automatically`
    : 'Resume uploaded. Review & complete any empty fields.');
  go('resume');
}
async function saveProfile() {
  const p = S.profile || {};
  document.querySelectorAll('[data-k]').forEach(el => { p[el.dataset.k] = el.value; });
  await api('/api/profile', { method: 'PUT', json: { data: p } });
  toast('Profile saved'); await refresh();
}

/* ---------------- Portals view ---------------- */
function buildPortalsView() {
  const v = $('#v-portals');
  const auto = S.portals.filter(p => p.auto);
  const manual = S.portals.filter(p => !p.auto);
  v.replaceChildren(
    h('h2', { class: 'section-title' }, 'Job portals'),
    h('p', { class: 'section-sub' }, 'Click Connect → a real Chrome window opens → log in yourself (OTP fine) → press I’m logged in on the purple banner. Password is never stored by JobPilot.'),
    h('h3', { style: 'font-size:14px;margin:16px 0 10px;color:var(--mute)' }, 'Auto-apply portals'),
    h('div', { class: 'portal-grid' }, ...auto.map(p =>
      h('div', { class: 'portal-card' },
        h('h3', {}, h('i', { class: 'dot' + (p.connected ? ' on' : '') }), p.name),
        h('p', {}, p.blurb || ''),
        h('span', { class: 'status ' + (p.connected ? 'ok' : 'off') }, p.connected ? 'Connected' : 'Not connected'),
        h('div', { class: 'row', style: 'margin-top:12px' },
          h('button', { class: 'btn pri', onclick: guard(() => connectPortal(p.id)) }, p.connected ? 'Reconnect' : 'Connect'),
          p.connected && h('button', { class: 'btn', onclick: guard(() => disconnectPortal(p.id)) }, 'Disconnect'))))),
    h('h3', { style: 'font-size:14px;margin:24px 0 10px;color:var(--mute)' }, 'Manual search links (no auto-apply)'),
    h('div', { class: 'portal-grid' }, ...manual.map(p =>
      h('div', { class: 'portal-card' },
        h('h3', {}, p.name),
        h('p', {}, p.blurb || 'Opens a pre-filled search. You apply yourself.'),
        h('a', { class: 'btn', href: '#jobs', onclick: () => go('jobs') }, 'Use from Jobs page')))));
}
async function connectPortal(id) {
  toast('Opening browser… complete login there (OTP ok)');
  const r = await api(`/api/portals/${id}/connect`, { method: 'POST' });
  // started is async — poll will show "I'm logged in" banner
  if (r.started === false) toast('Busy — stop current task first');
  else toast('Browser opening — log in, then press I’m logged in below');
  await refresh();
}
async function confirmLoggedIn() {
  await api('/api/portals/done', { method: 'POST' });
  toast('Checking login…');
  await refresh(true);
}
async function disconnectPortal(id) {
  await api(`/api/portals/${id}/disconnect`, { method: 'POST' });
  toast('Disconnected'); await refresh();
}

/* ---------------- Settings view ---------------- */
function buildSettingsView() {
  const v = $('#v-settings');
  const p = S.prefs || {};
  const n = S.notify || {};
  v.replaceChildren(
    h('h2', { class: 'section-title' }, 'Settings'),
    h('p', { class: 'section-sub' }, 'Match threshold, daily limit, full auto-submit, and notification delivery.'),
    h('div', { class: 'auto-banner' },
      h('div', {},
        h('strong', {}, 'Full auto-apply mode'),
        ' When Full auto-submit is on, the bot opens the apply page, fills name / email / phone / CTC / notice / skills from your profile, uploads your resume, and submits — then emails you the result.')),
    h('div', { class: 'set-grid' },
      h('div', { class: 'card' },
        h('h3', { style: 'font-size:15px;margin-bottom:12px' }, 'Apply behaviour'),
        h('div', { class: 'field', style: 'margin-bottom:12px' },
          h('label', {}, 'Minimum match score (0–100)'),
          h('input', { type: 'number', min: 0, max: 100, value: p.min_score ?? 55, id: 'set-min' })),
        h('div', { class: 'field', style: 'margin-bottom:12px' },
          h('label', {}, 'Daily apply cap'),
          h('input', { type: 'number', min: 1, max: 100, value: p.daily_cap ?? 25, id: 'set-cap' })),
        h('label', { class: 'switch', style: 'margin-bottom:12px' },
          h('input', { type: 'checkbox', checked: !!p.auto_submit, id: 'set-auto' }),
          'Full auto-submit (fill + submit, no approval step)'),
        h('label', { class: 'switch' },
          h('input', { type: 'checkbox', checked: p.include_career_pages !== false, id: 'set-career' }),
          'Include company career pages'),
        h('div', { class: 'row', style: 'margin-top:16px' },
          h('button', { class: 'go', onclick: guard(saveSettings) }, 'Save settings'))),
      h('div', { class: 'card' },
        h('h3', { style: 'font-size:15px;margin-bottom:12px' }, 'Notifications & status'),
        h('p', { style: 'font-size:13px;color:var(--mute);margin:0 0 8px' }, `AI scoring: ${S.ai_enabled ? 'Enabled' : 'Keyword-only (add ANTHROPIC_API_KEY)'}`),
        h('p', { style: 'font-size:13px;color:var(--mute);margin:0 0 8px' }, `Email alerts: ${S.email_enabled ? 'On → ' + (n.notify_email || n.smtp_user || '') : 'Off — click Email in the header to configure'}`),
        h('p', { style: 'font-size:13px;color:var(--mute);margin:0 0 8px' }, `Push alerts: ${S.push_enabled ? 'On' : 'Off — click Alert in the header'}`),
        h('p', { style: 'font-size:13px;color:var(--mute);margin:0 0 14px' }, `Applied today: ${S.applied_today} / ${p.daily_cap || 25}`),
        h('div', { class: 'row' },
          h('button', { class: 'btn', onclick: () => openCfg('email') }, 'Configure email'),
          h('button', { class: 'btn', onclick: () => openCfg('alert') }, 'Configure alerts'),
          h('button', { class: 'btn', onclick: guard(testNotify) }, 'Send test')))));
}
async function saveSettings() {
  const data = {
    ...S.prefs,
    min_score: +$('#set-min').value,
    daily_cap: +$('#set-cap').value,
    auto_submit: $('#set-auto').checked,
    include_career_pages: $('#set-career').checked,
  };
  await api('/api/prefs', { method: 'PUT', json: { data } });
  toast('Settings saved'); await refresh();
}

/* ---------------- render + refresh ---------------- */
function renderView() {
  if (!S && view !== 'admin') return;
  // ensure admin tab visible for admins
  if (CURRENT_USER?.is_admin && !TABS.some(t => t[0] === 'admin')) {
    TABS.push(['admin', 'Team', 'Users & login activity']);
  }
  if (view === 'jobs') buildJobsView();
  else if (view === 'resume') buildResumeView();
  else if (view === 'portals') buildPortalsView();
  else if (view === 'settings') buildSettingsView();
  else if (view === 'admin') buildAdminView();
}

async function buildAdminView() {
  const main = document.getElementById('main') || document.querySelector('main');
  if (!main) return;
  main.innerHTML = '';
  main.appendChild(h('div', { class: 'page-head' },
    h('h1', {}, 'Team & logins'),
    h('p', { class: 'section-sub' }, 'Only you (admin) can see how many times each teammate logged in.')
  ));
  try {
    const [users, logins] = await Promise.all([
      api('/api/admin/users'),
      api('/api/admin/logins'),
    ]);
    const table = h('table', { class: 'admin-table' },
      h('thead', {}, h('tr', {},
        h('th', {}, 'User'), h('th', {}, 'Role'), h('th', {}, 'Logins'), h('th', {}, 'Last login'), h('th', {}, 'Failed')
      )),
      h('tbody', {}, ...users.map(u => h('tr', {},
        h('td', {}, u.display_name || u.username, u.email ? h('div', { style: 'font-size:11px;color:var(--mute)' }, u.email) : null),
        h('td', {}, u.is_admin ? 'Admin' : 'Member'),
        h('td', {}, String(u.login_count || u.successful_logins || 0)),
        h('td', {}, u.last_login || '—'),
        h('td', {}, String(u.failed_logins || 0)),
      )))
    );
    main.appendChild(h('div', { class: 'card', style: 'margin-top:12px;overflow:auto' }, table));

    // Create user form
    const form = h('div', { class: 'card', style: 'margin-top:16px' },
      h('h3', {}, 'Create team member'),
      h('div', { style: 'display:grid;gap:10px;max-width:360px' },
        h('input', { id: 'nu-user', placeholder: 'username' }),
        h('input', { id: 'nu-pass', type: 'password', placeholder: 'password (min 6)' }),
        h('input', { id: 'nu-email', placeholder: 'email (optional)' }),
        h('label', { style: 'display:flex;gap:8px;align-items:center;font-size:13px' },
          h('input', { id: 'nu-admin', type: 'checkbox' }), ' Make admin'
        ),
        h('button', { class: 'btn primary', type: 'button', onclick: guard(async () => {
          await api('/api/admin/users', { method: 'POST', json: {
            username: document.getElementById('nu-user').value.trim(),
            password: document.getElementById('nu-pass').value,
            email: document.getElementById('nu-email').value.trim() || null,
            is_admin: document.getElementById('nu-admin').checked,
          }});
          toast('User created');
          buildAdminView();
        }) }, 'Create user')
      )
    );
    main.appendChild(form);

    if (logins?.length) {
      const hist = h('table', { class: 'admin-table' },
        h('thead', {}, h('tr', {}, h('th', {}, 'When'), h('th', {}, 'User'), h('th', {}, 'Result'), h('th', {}, 'IP'))),
        h('tbody', {}, ...logins.slice(0, 40).map(l => h('tr', {},
          h('td', {}, l.created_at || ''),
          h('td', {}, l.display_name || l.username || ('#' + l.user_id)),
          h('td', {}, l.success ? 'OK' : 'Failed'),
          h('td', {}, l.ip || ''),
        )))
      );
      main.appendChild(h('div', { class: 'card', style: 'margin-top:16px;overflow:auto' },
        h('h3', {}, 'Recent login activity'), hist
      ));
    }
  } catch (e) {
    main.appendChild(h('p', {}, e.message || 'Could not load admin data'));
  }
}


let wasRunning = false;

let filtersSynced = false;
async function refresh(forceJobs = false) {
  S = await api('/api/state');
  // Sync filter chips from saved prefs only on first load (or after explicit clear)
  if (!filtersSynced) {
    if (S.prefs.roles?.length) roles = [...S.prefs.roles];
    if (S.prefs.locations?.length) cities = [...S.prefs.locations];
    if (S.prefs.work_modes?.length) modes = [...S.prefs.work_modes];
    if (S.prefs.company_tiers?.length) tiers = [...S.prefs.company_tiers];
    if (S.prefs.company_types?.length) types = [...S.prefs.company_types];
    if (S.prefs.portals?.length) portalPick = [...S.prefs.portals];
    else portalPick = S.portals.filter(p => p.auto).map(p => p.id);
    filtersSynced = true;
  }

  renderLeds(); renderAutopilot(); renderLog();

  // Reload jobs when: forced, searching, stats changed, or a run just finished
  const key = JSON.stringify(S.stats || {}) + '|' + (S.run?.last_run || '') + '|' + (S.applied_today || 0);
  const runEnded = wasRunning && !S.run.running;
  wasRunning = !!S.run.running;
  if (forceJobs || key !== jobsKey || searching || runEnded || S.run.running) {
    jobs = await api('/api/jobs').then(r => Array.isArray(r) ? r : (r.jobs || [])).catch(() => []);
    jobsKey = key;
    searching = false;
  }
  renderView();
}

setInterval(() => { if (S?.run?.running || wasRunning) refresh(); }, 2000);

async function bootApp() {
  await refresh();
  renderNav();
  renderView();
  injectUserChip();
}

function injectUserChip() {
  const foot = document.querySelector('.side-foot');
  if (!foot || !CURRENT_USER) return;
  let chip = document.getElementById('user-chip');
  if (!chip) {
    chip = document.createElement('div');
    chip.id = 'user-chip';
    chip.className = 'user-chip';
    foot.insertBefore(chip, foot.firstChild);
  }
  const adminLink = CURRENT_USER.is_admin
    ? `<button type="button" class="link" id="open-admin" style="margin-left:6px;font-size:.75rem">Team</button>`
    : '';
  chip.innerHTML = `<b title="${CURRENT_USER.username}">${CURRENT_USER.display_name || CURRENT_USER.username}</b>${adminLink}<button type="button" class="logout" id="btn-logout">Logout</button>`;
  const lo = document.getElementById('btn-logout');
  if (lo) lo.onclick = () => doLogout();
  const ad = document.getElementById('open-admin');
  if (ad) ad.onclick = () => { view = 'admin'; location.hash = 'admin'; renderNav(); renderView(); };
}

// Extend TABS for admin
if (typeof TABS !== 'undefined') {
  // will inject dynamically when admin
}

const _origRenderView = typeof renderView === 'function' ? renderView : null;

// Patch go/renderNav later via wrap

(async function start() {
  wireAuth();
  updateAuthFormMode();
  const ok = await checkAuth();
  if (ok) await bootApp();
})();
