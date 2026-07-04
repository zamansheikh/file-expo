/* ══════════ File Expo — renderer ══════════ */
'use strict';

const $ = (id) => document.getElementById(id);
const invoke = (ch, ...a) => window.api.invoke(ch, ...a).catch(err => {
  const msg = String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  throw new Error(msg);
});

// ---------- state ----------
const S = {
  sys: null,             // connect result
  cwd: '/',
  items: [],
  sel: new Set(),
  anchor: null,
  sort: { key: 'name', asc: true },
  showHidden: false,
  history: [], hIdx: -1,
  clipboard: null,       // { paths, cut }
  filter: '',
  searchMode: false,
  transfers: new Map(),
  editingProfileId: null,
  editorPath: null,
  editorDirty: false,
  chmodTarget: null,
  connecting: false
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
  if (!n.includes('.')) return true; // README, Makefile, dotless configs — try it
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

function switchScreen(name) {
  ['screen-conn', 'screen-setup', 'screen-fm'].forEach(id => $(id).classList.toggle('hidden', id !== 'screen-' + name));
}

/* ══════════ SCREEN 1 : connection ══════════ */

async function refreshProfiles() {
  const list = await invoke('profiles:list');
  const box = $('profileList');
  box.innerHTML = '';
  if (!list.length) {
    box.innerHTML = '<div class="profile-empty">No saved servers yet.<br/>Fill the form and hit Save.</div>';
    return;
  }
  for (const p of list) {
    const el = document.createElement('div');
    el.className = 'profile-item';
    el.innerHTML = `<span>🖥️</span>
      <span class="pi-info">
        <span class="pi-name">${esc(p.name)}</span><br/>
        <span class="pi-host">${esc(p.username)}@${esc(p.host)}:${esc(p.port)}</span>
      </span>
      <button class="pi-del" title="Delete">✕</button>`;
    el.addEventListener('click', () => {
      S.editingProfileId = p.id;
      $('formTitle').textContent = 'Connect to ' + p.name;
      $('fName').value = p.name; $('fHost').value = p.host; $('fPort').value = p.port;
      $('fUser').value = p.username; $('fKey').value = p.keyPath || '';
      $('fPass').value = ''; $('fPhrase').value = '';
      setAuthMode(p.auth || 'password');
      if (p.hasPassword) $('fPass').placeholder = '(saved — leave blank to use it)';
    });
    el.addEventListener('dblclick', () => doConnect(true));
    el.querySelector('.pi-del').addEventListener('click', async (ev) => {
      ev.stopPropagation();
      await invoke('profiles:delete', p.id);
      if (S.editingProfileId === p.id) S.editingProfileId = null;
      refreshProfiles();
    });
    box.appendChild(el);
  }
}

let authMode = 'password';
function setAuthMode(m) {
  authMode = m;
  $('authPass').classList.toggle('active', m === 'password');
  $('authKey').classList.toggle('active', m === 'key');
  $('rowPass').classList.toggle('hidden', m !== 'password');
  $('rowKey').classList.toggle('hidden', m !== 'key');
}
$('authPass').addEventListener('click', () => setAuthMode('password'));
$('authKey').addEventListener('click', () => setAuthMode('key'));
$('btnPickKey').addEventListener('click', async () => {
  const p = await invoke('dialog:pickKey');
  if (p) $('fKey').value = p;
});

function formProfile() {
  return {
    id: S.editingProfileId,
    name: $('fName').value.trim(),
    host: $('fHost').value.trim(),
    port: parseInt($('fPort').value, 10) || 22,
    username: $('fUser').value.trim(),
    auth: authMode,
    password: $('fPass').value,
    keyPath: $('fKey').value.trim(),
    passphrase: $('fPhrase').value
  };
}

$('btnSaveProfile').addEventListener('click', async () => {
  const p = formProfile();
  if (!p.host || !p.username) { showConnError('Host and username are required'); return; }
  const r = await invoke('profiles:save', p);
  S.editingProfileId = r.id;
  toast('Server saved', 'ok');
  refreshProfiles();
});

function showConnError(msg) {
  const el = $('connError');
  el.textContent = msg;
  el.classList.remove('hidden');
}

async function doConnect(useSavedSecret) {
  if (S.connecting) return;
  const p = formProfile();
  if (!p.host || !p.username) { showConnError('Host and username are required'); return; }
  $('connError').classList.add('hidden');
  S.connecting = true;
  const btn = $('btnConnect');
  btn.disabled = true; btn.textContent = '⏳ Connecting…';
  try {
    let payload;
    if (useSavedSecret && S.editingProfileId && !p.password) payload = { profileId: S.editingProfileId };
    else payload = p;
    const info = await invoke('ssh:connect', payload);
    S.sys = info;
    S.cwd = info.home || '/';
    if (info.needsSetup) startSetup();
    else enterFileManager();
  } catch (err) {
    showConnError(err.message);
  } finally {
    S.connecting = false;
    btn.disabled = false; btn.textContent = '⚡ Connect';
  }
}
$('btnConnect').addEventListener('click', () => doConnect(true));
document.querySelectorAll('#screen-conn input').forEach(inp =>
  inp.addEventListener('keydown', e => { if (e.key === 'Enter') doConnect(true); }));

/* ══════════ SCREEN 2 : setup installer ══════════ */

const SETUP_TOTAL = 6;

function startSetup() {
  switchScreen('setup');
  $('setupTitle').textContent = `Setting up ${S.sys.distroName}`;
  $('setupSub').textContent = `Preparing ${S.sys.user}@${S.sys.host} — installing components like an OS setup. Sit back.`;
  $('setupLog').textContent = '';
  $('setupBar').style.width = '2%';
  $('setupPct').textContent = '0%';
  $('btnLaunchFM').classList.add('hidden');
  $('setupSpinner').classList.remove('done');
  document.querySelectorAll('#setupSteps li').forEach(li => {
    li.className = '';
    li.querySelector('.s-ic').textContent = '○';
  });
  runSetup();
}

async function runSetup() {
  try {
    const res = await invoke('setup:run');
    $('setupBar').style.width = '100%';
    $('setupPct').textContent = '100%';
    $('setupStepLabel').textContent = 'Setup complete';
    $('setupSpinner').classList.add('done');
    $('setupTitle').textContent = 'Your server is ready!';
    $('setupSub').textContent = res.missing.length
      ? `Ready — note: some optional tools are missing (${res.missing.join(', ')}).`
      : 'All components installed and verified.';
    $('btnLaunchFM').classList.remove('hidden');
    setTimeout(() => { if (!$('screen-setup').classList.contains('hidden')) enterFileManager(); }, 2500);
  } catch (err) {
    $('setupStepLabel').textContent = 'Setup failed';
    appendSetupLog('!! ' + err.message);
    $('setupTitle').textContent = 'Setup hit a problem';
    $('setupSub').textContent = 'You can still use the file manager — some tools may be unavailable.';
    $('btnLaunchFM').classList.remove('hidden');
  }
}

function appendSetupLog(line) {
  const el = $('setupLog');
  el.textContent += line + '\n';
  el.scrollTop = el.scrollHeight;
}

window.api.on('setup:step', ({ index, total, label, state }) => {
  const li = document.querySelector(`#setupSteps li[data-i="${index}"]`);
  if (li) {
    li.className = state;
    const ic = li.querySelector('.s-ic');
    ic.textContent = state === 'running' ? '◌' : state === 'done' ? '✓' : state === 'warn' ? '⚠' : state === 'skip' ? '–' : '○';
  }
  const frac = (index + (state === 'running' ? 0.45 : 1)) / total;
  const pct = Math.min(99, Math.round(frac * 100));
  $('setupBar').style.width = pct + '%';
  $('setupPct').textContent = pct + '%';
  $('setupStepLabel').textContent = label;
});
window.api.on('setup:log', ({ line }) => appendSetupLog(line));
$('btnLaunchFM').addEventListener('click', enterFileManager);

/* ══════════ SCREEN 3 : file manager ══════════ */

function enterFileManager() {
  switchScreen('fm');
  $('connInfo').textContent = `${S.sys.user}@${S.sys.host} · ${S.sys.distroName}`;
  $('statSys').textContent = `${S.sys.uname || ''}${S.sys.isRoot ? ' · root' : S.sys.canSudo ? ' · sudo' : ''}`;
  S.history = []; S.hIdx = -1;
  renderPlaces();
  renderBookmarks();
  go(S.sys.home || '/');
  $('fileList').focus();
}

$('btnDisconnect').addEventListener('click', async () => {
  await invoke('ssh:disconnect');
  S.sys = null;
  switchScreen('conn');
  refreshProfiles();
});

window.api.on('ssh:closed', () => {
  if (S.sys) {
    toast('Connection lost', 'err', 6000);
    S.sys = null;
    switchScreen('conn');
  }
});

// ---------- navigation ----------
async function go(path, { pushHistory = true } = {}) {
  try {
    const items = await invoke('fs:list', path);
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

// breadcrumb <-> path input
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
function bmKey() { return 'fx-bm-' + (S.sys ? S.sys.host + ':' + S.sys.user : ''); }
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
  const dirFirst = (a, b) => (b.isDir - a.isDir);
  list = [...list].sort((a, b) => {
    const d = dirFirst(a, b);
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
    const owner = (S.sys.users && S.sys.users[it.uid]) || it.uid;
    const displayName = S.searchMode ? it.fullPath : it.name;
    row.innerHTML =
      `<span class="col-name"><span class="fic">${iconFor(it)}</span><span class="fname" title="${esc(displayName)}">${esc(displayName)}${it.isLink ? ' <span class="lnk">→ link</span>' : ''}</span></span>` +
      `<span class="col-size">${it.isDir ? '—' : humanSize(it.size)}</span>` +
      `<span class="col-perm">${esc(it.perms || '')}</span>` +
      `<span class="col-owner">${esc(String(owner ?? ''))}</span>` +
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
  const vis = visibleItems();
  return vis.filter(i => S.sel.has(i.name));
}
function selectedPaths() {
  return selectedItems().map(i => i.fullPath || pjoin(S.cwd, i.name));
}

function openItem(it) {
  const full = it.fullPath || pjoin(S.cwd, it.name);
  if (it.isDir) { go(S.searchMode ? full : pjoin(S.cwd, it.name)); return; }
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
    const results = await invoke('fs:search', S.cwd, qy);
    S.searchMode = true;
    S.items = results.map(p => ({
      name: pbase(p), fullPath: p, size: 0, mtime: 0,
      isDir: false, isLink: false, perms: '', uid: null
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
    await invoke('fs:mkdir', pjoin(S.cwd, v));
    toast('Folder created', 'ok'); refresh();
  }, 'Create'));

$('actNewFile').addEventListener('click', () =>
  promptModal('New file', 'file.txt', async (v) => {
    await invoke('fs:touch', pjoin(S.cwd, v));
    toast('File created', 'ok'); refresh();
  }, 'Create'));

function doRename() {
  const items = selectedItems();
  if (items.length !== 1) return;
  const it = items[0];
  const oldPath = it.fullPath || pjoin(S.cwd, it.name);
  promptModal('Rename ' + it.name, it.name, async (v) => {
    await invoke('fs:rename', oldPath, pjoin(pparent(oldPath), v));
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
      await invoke('fs:delete', paths);
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
    await invoke('fs:copyMove', paths, S.cwd, cut);
    if (cut) S.clipboard = null;
    toast(cut ? 'Moved' : 'Copied', 'ok'); refresh();
  } catch (err) { toast(err.message, 'err'); }
}

/* ---------- editor ---------- */
async function openEditor(fullPath, name) {
  try {
    const r = await invoke('fs:read', fullPath);
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
    await invoke('fs:write', S.editorPath, $('meText').value);
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
    await invoke('fs:chmod', S.chmodTarget, octal, $('chRec').checked);
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
    const p = await invoke('fs:props', full, it.isDir);
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
    await invoke('fs:compress', S.cwd, items.map(i => i.name), v);
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
    await invoke('fs:extract', full, S.searchMode ? pparent(full) : S.cwd);
    toast('Extracted', 'ok'); refresh();
  } catch (err) { toast(err.message, 'err'); }
}

/* ---------- transfers ---------- */
$('actUpload').addEventListener('click', async () => {
  const files = await invoke('dialog:pickFiles');
  if (files.length) uploadPaths(files);
});
$('actUploadFolder').addEventListener('click', async () => {
  const dir = await invoke('dialog:pickFolder');
  if (dir) uploadPaths([dir]);
});
async function uploadPaths(localPaths) {
  showTransfers();
  toast(`Uploading ${localPaths.length} item(s) to ${S.cwd}…`);
  try {
    const r = await invoke('transfer:upload', localPaths, S.cwd);
    toast(r.failCount ? `Upload finished: ${r.okCount} ok, ${r.failCount} failed` : `Uploaded ${r.okCount} file(s)`, r.failCount ? 'err' : 'ok');
    refresh();
  } catch (err) { toast('Upload failed: ' + err.message, 'err'); }
}

$('actDownload').addEventListener('click', doDownload);
async function doDownload() {
  const paths = selectedPaths();
  if (!paths.length) return;
  const dir = await invoke('dialog:pickFolder');
  if (!dir) return;
  showTransfers();
  toast(`Downloading ${paths.length} item(s)…`);
  try {
    const r = await invoke('transfer:download', paths, dir);
    toast(r.failCount ? `Download finished: ${r.okCount} ok, ${r.failCount} failed` : `Downloaded ${r.okCount} file(s)`, r.failCount ? 'err' : 'ok');
    if (r.okCount) invoke('shell:openLocal', r.localDir);
  } catch (err) { toast('Download failed: ' + err.message, 'err'); }
}

window.api.on('transfer:progress', (t) => {
  S.transfers.set(t.id, t);
  renderTransfers();
});

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

// drag & drop upload
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
document.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('dropHint').classList.add('hidden');
  if (!S.sys || $('screen-fm').classList.contains('hidden') || S.searchMode) return;
  const paths = [...e.dataTransfer.files].map(f => window.api.filePath(f)).filter(Boolean);
  if (paths.length) uploadPaths(paths);
});

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
    const r = await invoke('fs:exec', cmd, S.cwd);
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
  // editor shortcuts
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
refreshProfiles();
