/* ══════════ File Expo — web client ══════════ */
'use strict';

const $ = (id) => document.getElementById(id);

async function api(route, body, method) {
  const opts = { method: method || (body !== undefined ? 'POST' : 'GET'), credentials: 'same-origin' };
  if (body !== undefined) {
    opts.headers = { 'Content-Type': 'application/json' };
    opts.body = JSON.stringify(body);
  }
  const r = await fetch('/api/' + route, opts);
  if (r.status === 401) {
    if (S.booted) showLogin();
    throw new Error('Login required');
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}

// ---------- state ----------
const S = {
  sys: null, booted: false,
  cwd: '/', items: [], sel: new Set(), anchor: null,
  sort: { key: 'name', asc: true },
  showHidden: false,
  history: [], hIdx: -1,
  clipboard: null, filter: '', searchMode: false,
  transfers: new Map(), transferSeq: 0,
  editorPath: null, editorDirty: false, chmodTarget: null
};

// ---------- helpers ----------
const pjoin = (dir, name) => (dir === '/' ? '' : dir) + '/' + name;
const pparent = (p) => { const parts = p.split('/').filter(Boolean); parts.pop(); return '/' + parts.join('/'); };
const pbase = (p) => p.split('/').filter(Boolean).pop() || '/';

function humanSize(n) {
  if (n == null) return '';
  if (n < 1024) return n + ' B';
  const u = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return n.toFixed(n >= 100 ? 0 : 1) + ' ' + u[i];
}
function fmtDate(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

const ICONS = {
  dir: '📁', link: '🔗', file: '📄',
  js: '🟨', ts: '🟦', json: '🧾', md: '📝', txt: '📝', log: '📜',
  html: '🌐', htm: '🌐', css: '🎨', scss: '🎨',
  py: '🐍', sh: '⚙️', bash: '⚙️', service: '⚙️', conf: '🔧', cfg: '🔧', ini: '🔧', yml: '🔧', yaml: '🔧', toml: '🔧', env: '🔧',
  png: '🖼️', jpg: '🖼️', jpeg: '🖼️', gif: '🖼️', svg: '🖼️', webp: '🖼️', ico: '🖼️',
  mp3: '🎵', wav: '🎵', ogg: '🎵', flac: '🎵',
  mp4: '🎬', mkv: '🎬', avi: '🎬', webm: '🎬', mov: '🎬',
  zip: '🗜️', tar: '🗜️', gz: '🗜️', tgz: '🗜️', bz2: '🗜️', xz: '🗜️', rar: '🗜️', '7z': '🗜️',
  pdf: '📕', doc: '📘', docx: '📘', xls: '📗', xlsx: '📗',
  sql: '🗃️', db: '🗃️', sqlite: '🗃️',
  php: '🐘', rb: '💎', go: '🐹', rs: '🦀', java: '☕', c: '🇨', cpp: '🇨', h: '🇨',
  key: '🔑', pem: '🔑', crt: '🔑', pub: '🔑'
};
function iconFor(it) {
  if (it.isDir) return ICONS.dir;
  if (it.isLink) return ICONS.link;
  const ext = it.name.includes('.') ? it.name.split('.').pop().toLowerCase() : '';
  return ICONS[ext] || ICONS.file;
}
const TEXT_EXTS = new Set(['txt','md','log','json','js','mjs','cjs','ts','tsx','jsx','html','htm','css','scss','less','py','sh','bash','zsh','conf','cfg','ini','yml','yaml','toml','env','xml','sql','php','rb','go','rs','java','c','cpp','h','hpp','service','socket','timer','list','sources','csv','tsv','properties','gitignore','dockerfile','vue','svelte','lock','pl','lua','vim','nginx','htaccess']);
function looksTexty(name) {
  const n = name.toLowerCase();
  if (!n.includes('.')) return true;
  return TEXT_EXTS.has(n.split('.').pop());
}
const ARCHIVE_RE = /\.(zip|tar|tar\.gz|tgz|tar\.bz2|tbz2|tar\.xz|txz|gz)$/i;

function toast(msg, type = '', ms = 3500) {
  const t = document.createElement('div');
  t.className = 'toast ' + type;
  t.textContent = msg;
  $('toasts').appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = '0.3s'; setTimeout(() => t.remove(), 350); }, ms);
}

const SCREENS = ['screen-boot', 'screen-welcome', 'screen-notoken', 'screen-login', 'screen-setup', 'screen-fm'];
function switchScreen(name) {
  SCREENS.forEach(id => $(id).classList.toggle('hidden', id !== 'screen-' + name));
}

/* ══════════ boot ══════════ */
const setupToken = new URLSearchParams(location.search).get('token');

async function boot() {
  try {
    const st = await api('state');
    S.booted = true;
    if (!st.configured) {
      if (!setupToken) { switchScreen('notoken'); return; }
      showWelcome(st);
    } else if (!st.authed) {
      showLogin(st.hostname);
    } else {
      await enterFileManager();
    }
  } catch (err) {
    S.booted = true;
    document.body.innerHTML = `<div class="screen center-screen"><div class="card center"><h1>⚠️ ${esc(err.message)}</h1></div></div>`;
  }
}

/* ══════════ setup welcome ══════════ */
let setupInfo = null;

async function showWelcome(st) {
  switchScreen('welcome');
  $('wHost').textContent = st.hostname || 'this server';
  try {
    setupInfo = await api('setup/info?token=' + encodeURIComponent(setupToken));
    const t = setupInfo.tools;
    $('wInfo').innerHTML =
      `<span>System</span><b>${esc(setupInfo.distro)}</b>` +
      `<span>Hostname</span><b>${esc(setupInfo.hostname)}</b>` +
      `<span>User</span><b>${esc(setupInfo.user)}</b>` +
      `<span>Node.js</span><b>${esc(setupInfo.node)}</b>` +
      `<span>Tools</span><b>${Object.keys(t).map(k => (t[k] ? '✓' : '✗') + ' ' + k).join('  ')}</b>`;
  } catch (err) {
    $('wInfo').innerHTML = `<span>Error</span><b>${esc(err.message)}</b>`;
    $('wInstall').disabled = true;
  }
}

$('wInstall').addEventListener('click', () => {
  const p1 = $('wPass').value, p2 = $('wPass2').value;
  const err = $('wError');
  err.classList.add('hidden');
  if (p1.length < 6) { err.textContent = 'Password must be at least 6 characters'; err.classList.remove('hidden'); return; }
  if (p1 !== p2) { err.textContent = 'Passwords do not match'; err.classList.remove('hidden'); return; }
  runSetup(p1);
});
['wPass', 'wPass2'].forEach(id => $(id).addEventListener('keydown', e => { if (e.key === 'Enter') $('wInstall').click(); }));

/* ══════════ setup installer ══════════ */
const SETUP_TOTAL = 6;

function setStep(i, state, label) {
  const li = document.querySelector(`#setupSteps li[data-i="${i}"]`);
  if (li) {
    li.className = state;
    li.querySelector('.s-ic').textContent =
      state === 'running' ? '◌' : state === 'done' ? '✓' : state === 'warn' ? '⚠' : state === 'skip' ? '–' : '○';
  }
  const frac = (i + (state === 'running' ? 0.45 : 1)) / SETUP_TOTAL;
  const pct = Math.min(99, Math.round(frac * 100));
  $('setupBar').style.width = pct + '%';
  $('setupPct').textContent = pct + '%';
  if (label) $('setupStepLabel').textContent = label;
}
function slog(line) {
  const el = $('setupLog');
  el.textContent += line + '\n';
  el.scrollTop = el.scrollHeight;
}
const wait = (ms) => new Promise(r => setTimeout(r, ms));

async function runSetup(password) {
  switchScreen('setup');
  $('setupLog').textContent = '';
  try {
    setStep(0, 'running', 'Verifying setup token');
    slog('Validating setup token…');
    await wait(500);
    setStep(0, 'done');

    setStep(1, 'running', 'Probing system');
    const info = setupInfo || await api('setup/info?token=' + encodeURIComponent(setupToken));
    slog(`System : ${info.distro}`);
    slog(`Host   : ${info.hostname} (${info.uname})`);
    slog(`User   : ${info.user}`);
    slog(`Node   : ${info.node}`);
    await wait(600);
    setStep(1, 'done');

    setStep(2, 'running', 'Checking tools');
    for (const [tool, ok] of Object.entries(info.tools)) {
      slog(`  ${ok ? '[ok]  ' : '[miss]'} ${tool}`);
      await wait(120);
    }
    setStep(2, 'done');

    setStep(3, 'running', 'Securing your password');
    slog('Hashing password with scrypt…');
    await wait(500);
    setStep(3, 'done');

    setStep(4, 'running', 'Writing configuration');
    await api('setup/complete', { token: setupToken, password });
    slog('Configuration written to /etc/file-expo/config.json');
    setStep(4, 'done');

    setStep(5, 'running', 'Starting services');
    slog('Session created. File manager ready.');
    await wait(600);
    setStep(5, 'done');

    $('setupBar').style.width = '100%';
    $('setupPct').textContent = '100%';
    $('setupStepLabel').textContent = 'Installation complete';
    $('setupSpinner').classList.add('done');
    $('setupTitle').textContent = 'Your server is ready!';
    $('setupSub').textContent = 'File Expo is installed. Keep your password safe.';
    slog('');
    slog('✓ Setup complete. Welcome to File Expo!');
    history.replaceState(null, '', '/');
    $('btnLaunchFM').classList.remove('hidden');
    setTimeout(() => { if (!$('screen-setup').classList.contains('hidden')) enterFileManager(); }, 2200);
  } catch (err) {
    slog('!! ' + err.message);
    $('setupTitle').textContent = 'Setup hit a problem';
    $('setupSub').textContent = err.message;
    $('setupStepLabel').textContent = 'Failed';
  }
}
$('btnLaunchFM').addEventListener('click', enterFileManager);

/* ══════════ login ══════════ */
function showLogin(hostname) {
  switchScreen('login');
  if (hostname) $('loginHost').textContent = hostname;
  setTimeout(() => $('loginPass').focus(), 50);
}
$('btnLogin').addEventListener('click', doLogin);
$('loginPass').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
async function doLogin() {
  const err = $('loginError');
  err.classList.add('hidden');
  try {
    await api('login', { password: $('loginPass').value });
    $('loginPass').value = '';
    enterFileManager();
  } catch (e) {
    err.textContent = e.message;
    err.classList.remove('hidden');
  }
}

/* ══════════ file manager ══════════ */
async function enterFileManager() {
  S.sys = await api('sysinfo');
  switchScreen('fm');
  $('connInfo').textContent = `${S.sys.user}@${S.sys.hostname} · ${S.sys.distro}`;
  $('statSys').textContent = `${S.sys.uname}${S.sys.isRoot ? ' · root' : ''}`;
  document.title = `File Expo — ${S.sys.hostname}`;
  S.history = []; S.hIdx = -1;
  renderPlaces();
  renderBookmarks();
  go(S.sys.home || '/');
  $('fileList').focus();
}

$('btnDisconnect').addEventListener('click', async () => {
  try { await api('logout', {}); } catch (e) {}
  location.href = '/';
});

// ---------- navigation ----------
async function go(path, { pushHistory = true } = {}) {
  try {
    const items = await api('list?path=' + encodeURIComponent(path));
    S.searchMode = false;
    $('searchBanner').classList.add('hidden');
    S.cwd = path;
    S.items = items;
    S.sel.clear(); S.anchor = null;
    S.filter = ''; $('filterInput').value = '';
    if (pushHistory) {
      S.history = S.history.slice(0, S.hIdx + 1);
      S.history.push(path);
      S.hIdx = S.history.length - 1;
    }
    renderAll();
  } catch (err) {
    toast(`Cannot open ${path}: ${err.message}`, 'err');
  }
}
function refresh() { go(S.cwd, { pushHistory: false }); }

$('navBack').addEventListener('click', () => { if (S.hIdx > 0) { S.hIdx--; go(S.history[S.hIdx], { pushHistory: false }); } });
$('navFwd').addEventListener('click', () => { if (S.hIdx < S.history.length - 1) { S.hIdx++; go(S.history[S.hIdx], { pushHistory: false }); } });
$('navUp').addEventListener('click', () => { if (S.cwd !== '/') go(pparent(S.cwd)); });
$('navRefresh').addEventListener('click', refresh);

function renderBreadcrumb() {
  const bc = $('breadcrumb');
  bc.innerHTML = '';
  const parts = S.cwd.split('/').filter(Boolean);
  const mk = (label, path, last) => {
    const s = document.createElement('span');
    s.className = 'crumb' + (last ? ' last' : '');
    s.textContent = label;
    s.addEventListener('click', (e) => { e.stopPropagation(); go(path); });
    bc.appendChild(s);
  };
  mk('/', '/', parts.length === 0);
  let acc = '';
  parts.forEach((p, i) => {
    const sep = document.createElement('span');
    sep.className = 'crumb-sep'; sep.textContent = '›';
    bc.appendChild(sep);
    acc += '/' + p;
    mk(p, acc, i === parts.length - 1);
  });
}
$('breadcrumb').addEventListener('click', () => {
  $('breadcrumb').classList.add('hidden');
  const pi = $('pathInput');
  pi.classList.remove('hidden');
  pi.value = S.cwd;
  pi.focus(); pi.select();
});
$('pathInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { const v = $('pathInput').value.trim(); hidePathInput(); if (v) go(v.replace(/\/+$/, '') || '/'); }
  if (e.key === 'Escape') hidePathInput();
});
$('pathInput').addEventListener('blur', hidePathInput);
function hidePathInput() {
  $('pathInput').classList.add('hidden');
  $('breadcrumb').classList.remove('hidden');
}

// ---------- places & bookmarks ----------
const PLACES = [
  ['🏠', 'Home', () => S.sys.home || '/'],
  ['💻', 'Root /', () => '/'],
  ['🌐', 'www', () => '/var/www'],
  ['⚙️', 'etc', () => '/etc'],
  ['📜', 'logs', () => '/var/log'],
  ['📦', 'opt', () => '/opt'],
  ['🧪', 'tmp', () => '/tmp']
];
function renderPlaces() {
  const box = $('places');
  box.innerHTML = '';
  for (const [ic, label, fn] of PLACES) {
    const p = fn();
    const el = document.createElement('div');
    el.className = 'place' + (S.cwd === p ? ' active' : '');
    el.innerHTML = `<span>${ic}</span><span>${esc(label)}</span>`;
    el.addEventListener('click', () => go(p));
    box.appendChild(el);
  }
}
function bmKey() { return 'fx-bm-' + (S.sys ? S.sys.hostname : ''); }
function getBookmarks() { try { return JSON.parse(localStorage.getItem(bmKey())) || []; } catch (e) { return []; } }
function renderBookmarks() {
  const box = $('bookmarks');
  box.innerHTML = '';
  for (const b of getBookmarks()) {
    const el = document.createElement('div');
    el.className = 'place' + (S.cwd === b ? ' active' : '');
    el.innerHTML = `<span>⭐</span><span title="${esc(b)}">${esc(pbase(b))}</span><button class="p-del">✕</button>`;
    el.addEventListener('click', () => go(b));
    el.querySelector('.p-del').addEventListener('click', (e) => {
      e.stopPropagation();
      localStorage.setItem(bmKey(), JSON.stringify(getBookmarks().filter(x => x !== b)));
      renderBookmarks();
    });
    box.appendChild(el);
  }
}
$('btnAddBookmark').addEventListener('click', () => {
  const list = getBookmarks();
  if (!list.includes(S.cwd)) { list.push(S.cwd); localStorage.setItem(bmKey(), JSON.stringify(list)); }
  renderBookmarks();
  toast('Bookmarked ' + S.cwd, 'ok');
});

// ---------- listing / render ----------
function visibleItems() {
  let list = S.items;
  if (!S.showHidden && !S.searchMode) list = list.filter(i => !i.name.startsWith('.'));
  if (S.filter) {
    const f = S.filter.toLowerCase();
    list = list.filter(i => i.name.toLowerCase().includes(f));
  }
  const { key, asc } = S.sort;
  list = [...list].sort((a, b) => {
    const d = b.isDir - a.isDir;
    if (d) return d;
    let c = 0;
    if (key === 'name') c = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    else if (key === 'size') c = a.size - b.size;
    else if (key === 'mtime') c = a.mtime - b.mtime;
    return asc ? c : -c;
  });
  return list;
}

function renderAll() {
  renderBreadcrumb();
  renderPlaces();
  renderBookmarks();
  renderList();
  $('consoleCwd').textContent = S.cwd;
}

function renderList() {
  const box = $('fileList');
  box.innerHTML = '';
  const list = visibleItems();
  if (!list.length) {
    box.innerHTML = `<div class="empty-dir">${S.filter ? 'No matches for “' + esc(S.filter) + '”' : S.searchMode ? 'No results' : '📂 This folder is empty'}</div>`;
  }
  const cutSet = S.clipboard && S.clipboard.cut ? new Set(S.clipboard.paths) : null;
  for (const it of list) {
    const row = document.createElement('div');
    const full = it.fullPath || pjoin(S.cwd, it.name);
    row.className = 'frow-item' + (S.sel.has(it.name) ? ' sel' : '') + (cutSet && cutSet.has(full) ? ' cut' : '');
    row.dataset.name = it.name;
    const displayName = S.searchMode ? it.fullPath : it.name;
    row.innerHTML =
      `<span class="col-name"><span class="fic">${iconFor(it)}</span><span class="fname" title="${esc(displayName)}">${esc(displayName)}${it.isLink ? ' <span class="lnk">→ link</span>' : ''}</span></span>` +
      `<span class="col-size">${it.isDir ? '—' : humanSize(it.size)}</span>` +
      `<span class="col-perm">${esc(it.perms || '')}</span>` +
      `<span class="col-owner">${esc(String(it.owner ?? ''))}</span>` +
      `<span class="col-date">${fmtDate(it.mtime)}</span>`;
    row.addEventListener('click', (e) => onRowClick(e, it, list));
    row.addEventListener('dblclick', () => openItem(it));
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (!S.sel.has(it.name)) { S.sel.clear(); S.sel.add(it.name); S.anchor = it.name; renderList(); }
      showCtxMenu(e.clientX, e.clientY);
    });
    box.appendChild(row);
  }
  updateSelUI(list);
}

function onRowClick(e, it, list) {
  if (e.ctrlKey || e.metaKey) {
    if (S.sel.has(it.name)) S.sel.delete(it.name); else S.sel.add(it.name);
    S.anchor = it.name;
  } else if (e.shiftKey && S.anchor) {
    const names = list.map(x => x.name);
    const a = names.indexOf(S.anchor), b = names.indexOf(it.name);
    if (a >= 0 && b >= 0) {
      S.sel.clear();
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) S.sel.add(names[i]);
    }
  } else {
    S.sel.clear(); S.sel.add(it.name); S.anchor = it.name;
  }
  renderList();
}

function updateSelUI(list) {
  const vis = list || visibleItems();
  const selItems = vis.filter(i => S.sel.has(i.name));
  const totSize = selItems.reduce((s, i) => s + (i.isDir ? 0 : i.size), 0);
  const hiddenCount = S.items.filter(i => i.name.startsWith('.')).length;
  $('statItems').textContent = S.searchMode
    ? `${vis.length} results`
    : `${vis.length} items${!S.showHidden && hiddenCount ? ` (${hiddenCount} hidden)` : ''}`;
  $('statSel').textContent = selItems.length ? `${selItems.length} selected · ${humanSize(totSize)}` : '';
  $('actDownload').disabled = !selItems.length;
  $('actDelete').disabled = !selItems.length;
}

function selectedItems() {
  return visibleItems().filter(i => S.sel.has(i.name));
}
function selectedPaths() {
  return selectedItems().map(i => i.fullPath || pjoin(S.cwd, i.name));
}

function openItem(it) {
  const full = it.fullPath || pjoin(S.cwd, it.name);
  if (it.isDir) { go(full); return; }
  if (looksTexty(it.name) || it.size < 512 * 1024) openEditor(full, it.name);
  else toast('Binary file — use Download instead', '', 3000);
}

// sorting
document.querySelectorAll('.list-head .sortable').forEach(el => {
  el.addEventListener('click', () => {
    const k = el.dataset.k;
    if (S.sort.key === k) S.sort.asc = !S.sort.asc;
    else { S.sort.key = k; S.sort.asc = true; }
    document.querySelectorAll('.list-head .sortable i').forEach(i => i.textContent = '');
    el.querySelector('i').textContent = S.sort.asc ? '▲' : '▼';
    renderList();
  });
});

// filter + deep search
$('filterInput').addEventListener('input', () => { S.filter = $('filterInput').value.trim(); renderList(); });
$('filterInput').addEventListener('keydown', async (e) => {
  if (e.key !== 'Enter') return;
  const qy = $('filterInput').value.trim();
  if (!qy) return;
  toast('Searching under ' + S.cwd + '…');
  try {
    const results = await api('search?base=' + encodeURIComponent(S.cwd) + '&q=' + encodeURIComponent(qy));
    S.searchMode = true;
    S.items = results.map(p => ({
      name: pbase(p), fullPath: p, size: 0, mtime: 0,
      isDir: false, isLink: false, perms: '', owner: ''
    }));
    S.sel.clear(); S.filter = ''; $('filterInput').value = '';
    $('searchBanner').classList.remove('hidden');
    $('searchBannerText').textContent = `🔍 ${results.length} result(s) for “${qy}” under ${S.cwd}`;
    renderList();
  } catch (err) { toast('Search failed: ' + err.message, 'err'); }
});
$('btnCloseSearch').addEventListener('click', refresh);

$('chkHidden').addEventListener('change', () => { S.showHidden = $('chkHidden').checked; renderList(); });

/* ---------- modals ---------- */
function openModal(id) {
  $('modalBack').classList.remove('hidden');
  ['modalInput', 'modalConfirm', 'modalEditor', 'modalChmod', 'modalProps'].forEach(m => $(m).classList.toggle('hidden', m !== id));
}
function closeModal() {
  $('modalBack').classList.add('hidden');
  S.editorPath = null;
  $('fileList').focus();
}
document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', closeModal));
$('modalBack').addEventListener('mousedown', (e) => { if (e.target === $('modalBack')) closeModal(); });

function promptModal(title, initial, onOk, okLabel = 'OK') {
  $('miTitle').textContent = title;
  $('miValue').value = initial || '';
  $('miOk').textContent = okLabel;
  openModal('modalInput');
  const inp = $('miValue');
  setTimeout(() => {
    inp.focus();
    const dot = (initial || '').lastIndexOf('.');
    if (dot > 0) inp.setSelectionRange(0, dot); else inp.select();
  }, 30);
  $('miOk').onclick = async () => {
    const v = inp.value.trim();
    if (!v) return;
    closeModal();
    try { await onOk(v); } catch (err) { toast(err.message, 'err'); }
  };
  inp.onkeydown = (e) => { if (e.key === 'Enter') $('miOk').click(); if (e.key === 'Escape') closeModal(); };
}

function confirmModal(title, text, onOk, okLabel = 'Delete') {
  $('mcTitle').textContent = title;
  $('mcText').textContent = text;
  $('mcOk').textContent = okLabel;
  openModal('modalConfirm');
  $('mcOk').onclick = async () => { closeModal(); try { await onOk(); } catch (err) { toast(err.message, 'err'); } };
}

/* ---------- file actions ---------- */
$('actNewFolder').addEventListener('click', () =>
  promptModal('New folder', 'new-folder', async (v) => {
    await api('mkdir', { path: pjoin(S.cwd, v) });
    toast('Folder created', 'ok'); refresh();
  }, 'Create'));

$('actNewFile').addEventListener('click', () =>
  promptModal('New file', 'file.txt', async (v) => {
    await api('touch', { path: pjoin(S.cwd, v) });
    toast('File created', 'ok'); refresh();
  }, 'Create'));

function doRename() {
  const items = selectedItems();
  if (items.length !== 1) return;
  const it = items[0];
  const oldPath = it.fullPath || pjoin(S.cwd, it.name);
  promptModal('Rename ' + it.name, it.name, async (v) => {
    await api('rename', { from: oldPath, to: pjoin(pparent(oldPath), v) });
    toast('Renamed', 'ok'); refresh();
  }, 'Rename');
}

function doDelete() {
  const paths = selectedPaths();
  if (!paths.length) return;
  confirmModal(
    `Delete ${paths.length} item(s)?`,
    paths.slice(0, 6).map(pbase).join(', ') + (paths.length > 6 ? ` … and ${paths.length - 6} more` : '') + '\nThis cannot be undone.',
    async () => {
      await api('delete', { paths });
      toast('Deleted', 'ok'); refresh();
    });
}
$('actDelete').addEventListener('click', doDelete);

function doCopy(cut) {
  const paths = selectedPaths();
  if (!paths.length) return;
  S.clipboard = { paths, cut };
  toast(`${paths.length} item(s) ${cut ? 'cut' : 'copied'} — paste with Ctrl+V`, 'ok', 2200);
  renderList();
}
async function doPaste() {
  if (!S.clipboard || S.searchMode) return;
  const { paths, cut } = S.clipboard;
  try {
    await api('copyMove', { paths, dest: S.cwd, move: cut });
    if (cut) S.clipboard = null;
    toast(cut ? 'Moved' : 'Copied', 'ok'); refresh();
  } catch (err) { toast(err.message, 'err'); }
}

/* ---------- editor ---------- */
async function openEditor(fullPath, name) {
  try {
    const r = await api('read?path=' + encodeURIComponent(fullPath));
    if (r.tooLarge) { toast(`File is ${humanSize(r.size)} — too large to edit. Download it instead.`, 'err'); return; }
    if (r.binary) { toast('Binary file — use Download instead', '', 3000); return; }
    S.editorPath = fullPath;
    S.editorDirty = false;
    $('meName').textContent = name;
    $('meDirty').textContent = '';
    $('meInfo').textContent = `${fullPath} · ${humanSize(r.size)}`;
    $('meText').value = r.content;
    openModal('modalEditor');
    setTimeout(() => $('meText').focus(), 30);
  } catch (err) { toast('Open failed: ' + err.message, 'err'); }
}
$('meText').addEventListener('input', () => { S.editorDirty = true; $('meDirty').textContent = '● modified'; });
$('meSave').addEventListener('click', saveEditor);
async function saveEditor() {
  if (!S.editorPath) return;
  try {
    await api('write', { path: S.editorPath, content: $('meText').value });
    S.editorDirty = false;
    $('meDirty').textContent = '✓ saved';
    toast('Saved', 'ok', 1500);
    refresh();
  } catch (err) { toast('Save failed: ' + err.message, 'err'); }
}

/* ---------- chmod ---------- */
function openChmod() {
  const items = selectedItems();
  if (items.length !== 1) return;
  const it = items[0];
  S.chmodTarget = it.fullPath || pjoin(S.cwd, it.name);
  $('chName').textContent = it.name;
  const mode = (it.mode || 0) & 0o777;
  document.querySelectorAll('#modalChmod input[data-b]').forEach(cb => {
    cb.checked = !!(mode >> parseInt(cb.dataset.b, 10) & 1);
  });
  $('chOctal').value = mode.toString(8).padStart(3, '0');
  $('chRec').checked = false;
  openModal('modalChmod');
}
document.querySelectorAll('#modalChmod input[data-b]').forEach(cb =>
  cb.addEventListener('change', () => {
    let m = 0;
    document.querySelectorAll('#modalChmod input[data-b]').forEach(c => {
      if (c.checked) m |= 1 << parseInt(c.dataset.b, 10);
    });
    $('chOctal').value = m.toString(8).padStart(3, '0');
  }));
$('chOctal').addEventListener('input', () => {
  const v = parseInt($('chOctal').value, 8);
  if (isNaN(v)) return;
  document.querySelectorAll('#modalChmod input[data-b]').forEach(c => {
    c.checked = !!(v >> parseInt(c.dataset.b, 10) & 1);
  });
});
$('chOk').addEventListener('click', async () => {
  const octal = $('chOctal').value.trim();
  closeModal();
  try {
    await api('chmod', { path: S.chmodTarget, octal, recursive: $('chRec').checked });
    toast('Permissions updated', 'ok'); refresh();
  } catch (err) { toast(err.message, 'err'); }
});

/* ---------- properties ---------- */
async function openProps() {
  const items = selectedItems();
  if (items.length !== 1) return;
  const it = items[0];
  const full = it.fullPath || pjoin(S.cwd, it.name);
  $('ppName').textContent = it.name;
  $('ppBody').innerHTML = '<span class="k">Loading…</span>';
  openModal('modalProps');
  try {
    const p = await api('props?path=' + encodeURIComponent(full));
    const rows = [
      ['Path', full],
      ['Type', it.isDir ? 'Directory' : (p.fileType || 'File')],
      ['Size', it.isDir ? (p.duSize || '—') : `${humanSize(p.size)} (${p.size.toLocaleString()} bytes)`],
      ['Permissions', `${p.perms} (${p.octal})`],
      ['Owner', `${p.owner} (${p.uid})`],
      ['Group', `${p.group} (${p.gid})`],
      ['Modified', fmtDate(p.mtime)],
      ['Accessed', fmtDate(p.atime)]
    ];
    $('ppBody').innerHTML = rows.map(([k, v]) => `<span class="k">${k}</span><span class="v">${esc(String(v))}</span>`).join('');
  } catch (err) {
    $('ppBody').innerHTML = `<span class="k">Error</span><span class="v">${esc(err.message)}</span>`;
  }
}

/* ---------- compress / extract ---------- */
function doCompress() {
  const items = selectedItems();
  if (!items.length || S.searchMode) return;
  const defName = (items.length === 1 ? items[0].name.replace(/\.[^.]+$/, '') : 'archive') + '.zip';
  promptModal('Compress to (.zip / .tar.gz)', defName, async (v) => {
    toast('Compressing…');
    await api('compress', { dir: S.cwd, items: items.map(i => i.name), name: v });
    toast('Archive created: ' + v, 'ok'); refresh();
  }, 'Compress');
}
async function doExtract() {
  const items = selectedItems();
  if (items.length !== 1) return;
  const it = items[0];
  const full = it.fullPath || pjoin(S.cwd, it.name);
  toast('Extracting…');
  try {
    await api('extract', { file: full, dest: S.searchMode ? pparent(full) : S.cwd });
    toast('Extracted', 'ok'); refresh();
  } catch (err) { toast(err.message, 'err'); }
}

/* ---------- transfers (uploads via XHR, downloads via browser) ---------- */
$('actUpload').addEventListener('click', () => $('pickFiles').click());
$('actUploadFolder').addEventListener('click', () => $('pickFolder').click());
$('pickFiles').addEventListener('change', () => {
  uploadFileList([...$('pickFiles').files].map(f => ({ file: f, rel: f.name })));
  $('pickFiles').value = '';
});
$('pickFolder').addEventListener('change', () => {
  uploadFileList([...$('pickFolder').files].map(f => ({ file: f, rel: f.webkitRelativePath || f.name })));
  $('pickFolder').value = '';
});

async function uploadFileList(entries) {
  if (!entries.length) return;
  showTransfers();
  const targetDir = S.cwd;
  let ok = 0, fail = 0;
  for (const { file, rel } of entries) {
    const id = 'up' + (++S.transferSeq);
    setTransfer(id, { id, name: rel, dir: 'up', done: 0, total: file.size, state: 'active' });
    try {
      await uploadOne(file, targetDir, rel, (done) => setTransfer(id, { id, name: rel, dir: 'up', done, total: file.size, state: 'active' }));
      setTransfer(id, { id, name: rel, dir: 'up', done: file.size, total: file.size, state: 'done' });
      ok++;
    } catch (err) {
      setTransfer(id, { id, name: rel, dir: 'up', done: 0, total: file.size, state: 'error', error: err.message });
      fail++;
    }
  }
  toast(fail ? `Upload finished: ${ok} ok, ${fail} failed` : `Uploaded ${ok} file(s)`, fail ? 'err' : 'ok');
  if (targetDir === S.cwd) refresh();
}

function uploadOne(file, dir, rel, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload?dir=' + encodeURIComponent(dir) + '&rel=' + encodeURIComponent(rel));
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded); };
    xhr.onload = () => {
      if (xhr.status === 200) resolve();
      else {
        let msg = 'HTTP ' + xhr.status;
        try { msg = JSON.parse(xhr.responseText).error || msg; } catch (e) {}
        reject(new Error(msg));
      }
    };
    xhr.onerror = () => reject(new Error('Network error'));
    xhr.send(file);
  });
}

let lastRender = 0;
function setTransfer(id, t) {
  S.transfers.set(id, t);
  const now = Date.now();
  if (t.state === 'active' && now - lastRender < 120) return;
  lastRender = now;
  renderTransfers();
}

$('actDownload').addEventListener('click', doDownload);
async function doDownload() {
  const paths = selectedPaths();
  if (!paths.length) return;
  toast(`Starting ${paths.length} download(s) — check your browser downloads`, 'ok');
  for (let i = 0; i < paths.length; i++) {
    setTimeout(() => {
      const a = document.createElement('a');
      a.href = '/api/download?path=' + encodeURIComponent(paths[i]);
      a.download = '';
      document.body.appendChild(a);
      a.click();
      a.remove();
    }, i * 600);
  }
}

function renderTransfers() {
  const box = $('transferList');
  const arr = [...S.transfers.values()].reverse();
  const active = arr.filter(t => t.state === 'active').length;
  const cnt = $('transferCount');
  cnt.textContent = active;
  cnt.classList.toggle('hidden', !active);
  box.innerHTML = arr.map(t => {
    const pct = t.total ? Math.min(100, Math.round(t.done / t.total * 100)) : (t.state === 'done' ? 100 : 0);
    const stat = t.state === 'error' ? `failed: ${esc(t.error || '')}`
      : t.state === 'done' ? 'done'
      : `${humanSize(t.done)} / ${humanSize(t.total)} · ${pct}%`;
    return `<div class="t-item">
      <div class="t-top"><span>${t.dir === 'up' ? '⬆' : '⬇'}</span><span class="t-name">${esc(t.name)}</span>
        <span class="t-stat ${t.state === 'error' ? 'err' : ''}">${stat}</span></div>
      <div class="t-bar"><div class="t-fill ${t.state === 'done' ? 'done' : t.state === 'error' ? 'err' : ''}" style="width:${pct}%"></div></div>
    </div>`;
  }).join('');
}
function showTransfers() { $('panelTransfers').classList.remove('hidden'); $('panelConsole').classList.add('hidden'); }
$('actTransfers').addEventListener('click', () => { $('panelTransfers').classList.toggle('hidden'); $('panelConsole').classList.add('hidden'); });
$('closeTransfers').addEventListener('click', () => $('panelTransfers').classList.add('hidden'));
$('btnClearTransfers').addEventListener('click', () => {
  for (const [id, t] of S.transfers) if (t.state !== 'active') S.transfers.delete(id);
  renderTransfers();
});

// drag & drop upload (supports folders via webkitGetAsEntry)
let dragDepth = 0;
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('dragenter', (e) => {
  e.preventDefault();
  if (!S.sys || $('screen-fm').classList.contains('hidden')) return;
  dragDepth++;
  $('dropHint').classList.remove('hidden');
});
document.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) $('dropHint').classList.add('hidden');
});
document.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('dropHint').classList.add('hidden');
  if (!S.sys || $('screen-fm').classList.contains('hidden') || S.searchMode) return;
  const entries = await entriesFromDrop(e.dataTransfer);
  if (entries.length) uploadFileList(entries);
});

async function entriesFromDrop(dt) {
  const out = [];
  async function walk(entry, prefix) {
    if (entry.isFile) {
      const f = await new Promise((res, rej) => entry.file(res, rej));
      out.push({ file: f, rel: prefix + f.name });
    } else if (entry.isDirectory) {
      const rd = entry.createReader();
      let batch;
      do {
        batch = await new Promise((res, rej) => rd.readEntries(res, rej));
        for (const c of batch) await walk(c, prefix + entry.name + '/');
      } while (batch.length);
    }
  }
  const tops = [];
  for (const item of dt.items || []) {
    const en = item.webkitGetAsEntry && item.webkitGetAsEntry();
    if (en) tops.push(en);
  }
  if (tops.length) { for (const en of tops) await walk(en, ''); }
  else for (const f of dt.files || []) out.push({ file: f, rel: f.name });
  return out;
}

/* ---------- console ---------- */
$('actConsole').addEventListener('click', () => {
  $('panelConsole').classList.toggle('hidden');
  $('panelTransfers').classList.add('hidden');
  if (!$('panelConsole').classList.contains('hidden')) $('consoleInput').focus();
});
$('closeConsole').addEventListener('click', () => $('panelConsole').classList.add('hidden'));
$('btnClearConsole').addEventListener('click', () => { $('consoleOut').textContent = ''; });
$('consoleInput').addEventListener('keydown', async (e) => {
  if (e.key !== 'Enter') return;
  const cmd = $('consoleInput').value.trim();
  if (!cmd) return;
  $('consoleInput').value = '';
  const out = $('consoleOut');
  out.textContent += `\n${S.cwd} $ ${cmd}\n`;
  out.scrollTop = out.scrollHeight;
  try {
    const r = await api('exec', { cmd, cwd: S.cwd });
    out.textContent += (r.output || '(no output)') + (r.code ? `\n[exit ${r.code}]` : '') + '\n';
  } catch (err) {
    out.textContent += '!! ' + err.message + '\n';
  }
  out.scrollTop = out.scrollHeight;
  if (/^(rm|mv|cp|mkdir|touch|chmod|chown|tar|zip|unzip|git|wget|curl -[oO])/.test(cmd)) refresh();
});

/* ---------- context menu ---------- */
function showCtxMenu(x, y) {
  const menu = $('ctxMenu');
  const items = selectedItems();
  const one = items.length === 1 ? items[0] : null;
  const entries = [];
  if (one && one.isDir) entries.push(['📂', 'Open', () => openItem(one)]);
  if (one && !one.isDir) {
    entries.push(['✏️', 'Open / Edit', () => openItem(one)]);
    if (ARCHIVE_RE.test(one.name)) entries.push(['📤', 'Extract here', doExtract]);
  }
  if (items.length) {
    entries.push(['⬇', `Download${items.length > 1 ? ` (${items.length})` : ''}`, doDownload]);
    entries.push(null);
    entries.push(['📋', 'Copy', () => doCopy(false)]);
    entries.push(['✂️', 'Cut', () => doCopy(true)]);
  }
  if (S.clipboard && !S.searchMode) entries.push(['📥', `Paste (${S.clipboard.paths.length})`, doPaste]);
  if (items.length) {
    if (!S.searchMode) entries.push(['🗜️', 'Compress…', doCompress]);
    entries.push(null);
    if (one) entries.push(['🏷️', 'Rename (F2)', doRename]);
    if (one) entries.push(['🔐', 'Permissions…', openChmod]);
    if (one) entries.push(['ℹ️', 'Properties', openProps]);
    entries.push(null);
    entries.push(['🗑', 'Delete', doDelete, 'danger']);
  } else {
    entries.push(['📁', 'New folder', () => $('actNewFolder').click()]);
    entries.push(['📄', 'New file', () => $('actNewFile').click()]);
    if (S.clipboard) entries.push(['📥', `Paste (${S.clipboard.paths.length})`, doPaste]);
    entries.push(['⟳', 'Refresh', refresh]);
  }
  menu.innerHTML = '';
  for (const en of entries) {
    if (!en) { const s = document.createElement('div'); s.className = 'ctx-sep'; menu.appendChild(s); continue; }
    const [ic, label, fn, cls] = en;
    const el = document.createElement('div');
    el.className = 'ctx-item' + (cls ? ' ' + cls : '');
    el.innerHTML = `<span>${ic}</span><span>${esc(label)}</span>`;
    el.addEventListener('click', () => { hideCtx(); fn(); });
    menu.appendChild(el);
  }
  menu.classList.remove('hidden');
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, window.innerWidth - r.width - 8) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - r.height - 8) + 'px';
}
function hideCtx() { $('ctxMenu').classList.add('hidden'); }
document.addEventListener('mousedown', (e) => { if (!$('ctxMenu').contains(e.target)) hideCtx(); });
$('fileList').addEventListener('contextmenu', (e) => {
  if (e.target === $('fileList')) {
    e.preventDefault();
    S.sel.clear(); renderList();
    showCtxMenu(e.clientX, e.clientY);
  }
});
$('fileList').addEventListener('click', (e) => {
  if (e.target === $('fileList')) { S.sel.clear(); S.anchor = null; renderList(); }
});

/* ---------- keyboard ---------- */
document.addEventListener('keydown', (e) => {
  if (!$('modalEditor').classList.contains('hidden')) {
    if (e.ctrlKey && e.key === 's') { e.preventDefault(); saveEditor(); }
    if (e.key === 'Escape') closeModal();
    return;
  }
  if (!$('modalBack').classList.contains('hidden')) {
    if (e.key === 'Escape') closeModal();
    return;
  }
  if ($('screen-fm').classList.contains('hidden')) return;
  const inInput = ['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName);
  if (inInput) { if (e.key === 'Escape') document.activeElement.blur(); return; }

  if (e.key === 'F5') { e.preventDefault(); refresh(); }
  else if (e.key === 'F2') { e.preventDefault(); doRename(); }
  else if (e.key === 'Delete') { e.preventDefault(); doDelete(); }
  else if (e.key === 'Backspace') { e.preventDefault(); if (S.cwd !== '/') go(pparent(S.cwd)); }
  else if (e.key === 'Enter') { const it = selectedItems()[0]; if (it) openItem(it); }
  else if (e.ctrlKey && e.key === 'a') { e.preventDefault(); visibleItems().forEach(i => S.sel.add(i.name)); renderList(); }
  else if (e.ctrlKey && e.key === 'c') { doCopy(false); }
  else if (e.ctrlKey && e.key === 'x') { doCopy(true); }
  else if (e.ctrlKey && e.key === 'v') { doPaste(); }
  else if (e.altKey && e.key === 'ArrowLeft') { $('navBack').click(); }
  else if (e.altKey && e.key === 'ArrowRight') { $('navFwd').click(); }
  else if (e.ctrlKey && e.key === 'f') { e.preventDefault(); $('filterInput').focus(); }
  else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const vis = visibleItems();
    if (!vis.length) return;
    const names = vis.map(i => i.name);
    let idx = S.anchor ? names.indexOf(S.anchor) : -1;
    idx = e.key === 'ArrowDown' ? Math.min(names.length - 1, idx + 1) : Math.max(0, idx - 1);
    const name = names[idx];
    if (e.shiftKey && S.sel.size) S.sel.add(name);
    else { S.sel.clear(); S.sel.add(name); }
    S.anchor = name;
    renderList();
    const row = document.querySelector(`.frow-item[data-name="${CSS.escape(name)}"]`);
    if (row) row.scrollIntoView({ block: 'nearest' });
  }
});

/* ---------- init ---------- */
boot();
