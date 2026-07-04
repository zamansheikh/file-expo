#!/usr/bin/env node
/* File Expo — self-hosted web file manager (zero-dependency Node.js server) */
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { exec, spawn } = require('child_process');
const os = require('os');

const CONF_DIR = process.env.FILE_EXPO_CONF || '/etc/file-expo';
const CONF_FILE = path.join(CONF_DIR, 'config.json');
const PUB = path.join(__dirname, 'public');
const VERSION = '1.2.2';
const REPO = 'zamansheikh/file-expo';
const BRANCH = 'main';
const APP_ROOT = path.resolve(__dirname, '..');
const TRASH_DIR = path.join(CONF_DIR, 'trash');

function loadTrash() {
  try { return JSON.parse(fs.readFileSync(path.join(TRASH_DIR, 'manifest.json'), 'utf8')); } catch (e) { return []; }
}
function saveTrash(list) {
  fs.mkdirSync(TRASH_DIR, { recursive: true });
  fs.writeFileSync(path.join(TRASH_DIR, 'manifest.json'), JSON.stringify(list, null, 2));
}

/* ---------- config ---------- */
let conf = { port: 7777, configured: false, setupToken: null, passHash: null, salt: null };
try { conf = { ...conf, ...JSON.parse(fs.readFileSync(CONF_FILE, 'utf8')) }; } catch (e) {}
if (process.env.FILE_EXPO_PORT) conf.port = parseInt(process.env.FILE_EXPO_PORT, 10) || conf.port;

function saveConf() {
  fs.mkdirSync(CONF_DIR, { recursive: true });
  fs.writeFileSync(CONF_FILE, JSON.stringify(conf, null, 2), { mode: 0o600 });
}
if (!conf.configured && !conf.setupToken) {
  conf.setupToken = crypto.randomBytes(16).toString('hex');
  try { saveConf(); } catch (e) { console.error('WARN: cannot write config:', e.message); }
}

/* ---------- helpers ---------- */
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

function hashPass(pw, salt) { return crypto.scryptSync(pw, salt, 64).toString('hex'); }
function safeEq(a, b) {
  const ab = Buffer.from(String(a)), bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

const sessions = new Map(); // token -> expiry ms
const SESS_TTL = 12 * 60 * 60 * 1000;
function newSession() {
  const t = crypto.randomBytes(24).toString('hex');
  sessions.set(t, Date.now() + SESS_TTL);
  return t;
}
function validSession(t) {
  if (!t || !sessions.has(t)) return false;
  if (sessions.get(t) < Date.now()) { sessions.delete(t); return false; }
  sessions.set(t, Date.now() + SESS_TTL);
  return true;
}
function cookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(c => {
    const i = c.indexOf('=');
    if (i > 0) out[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim());
  });
  return out;
}

const loginFails = new Map(); // ip -> {count, until}
function loginLocked(ip) {
  const f = loginFails.get(ip);
  return f && f.until > Date.now();
}
function loginFail(ip) {
  const f = loginFails.get(ip) || { count: 0, until: 0 };
  f.count++;
  if (f.count >= 5) { f.until = Date.now() + 60000; f.count = 0; }
  loginFails.set(ip, f);
}

function json(res, code, obj) {
  const b = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) });
  res.end(b);
}
function readBody(req, limit = 12 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new Error('Body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch (e) { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}
function run(cmd, opts = {}) {
  return new Promise((resolve) => {
    exec(cmd, { maxBuffer: 16 * 1024 * 1024, timeout: opts.timeout || 120000, cwd: opts.cwd }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code || 1) : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

function permString(mode) {
  const t = mode & 0o170000;
  let s = t === 0o040000 ? 'd' : t === 0o120000 ? 'l' : t === 0o140000 ? 's' : t === 0o060000 ? 'b' : t === 0o020000 ? 'c' : t === 0o010000 ? 'p' : '-';
  const bits = ['r', 'w', 'x'];
  for (let g = 2; g >= 0; g--)
    for (let b = 0; b < 3; b++)
      s += (mode >> (g * 3 + (2 - b))) & 1 ? bits[b] : '-';
  return s;
}

let userMap = {};
function loadUsers() {
  try {
    fs.readFileSync('/etc/passwd', 'utf8').split('\n').forEach(l => {
      const p = l.split(':');
      if (p.length > 3) userMap[p[2]] = p[0];
    });
  } catch (e) {}
}
loadUsers();

function distroName() {
  try {
    const t = fs.readFileSync('/etc/os-release', 'utf8');
    const m = t.match(/^PRETTY_NAME="?([^"\n]*)"?/m);
    return m ? m[1] : 'Linux';
  } catch (e) { return os.platform(); }
}

const cleanRel = (rel) => String(rel || '').split('/').filter(p => p && p !== '..' && p !== '.').join('/');

/* ---------- static ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
function serveStatic(req, res, urlPath) {
  let rel = cleanRel(urlPath);
  if (!rel || !fs.existsSync(path.join(PUB, rel))) rel = 'index.html';
  const fp = path.join(PUB, rel);
  const ext = path.extname(fp).toLowerCase();
  if (rel === 'index.html') {
    // version-stamp asset URLs so browsers never mix old JS with new HTML
    let html = fs.readFileSync(fp, 'utf8')
      .replace('href="styles.css"', `href="styles.css?v=${VERSION}"`)
      .replace('src="app.js"', `src="app.js?v=${VERSION}"`);
    res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
    return res.end(html);
  }
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(fp).pipe(res);
}

/* ---------- update / system helpers ---------- */
const RAW_MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.ico': 'image/x-icon',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.mov': 'video/quicktime',
  '.m4v': 'video/mp4', '.avi': 'video/x-msvideo',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.flac': 'audio/flac',
  '.m4a': 'audio/mp4', '.aac': 'audio/aac',
  '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8'
};

function fetchUrl(url, depth = 0) {
  return new Promise((resolve, reject) => {
    if (depth > 4) return reject(new Error('Too many redirects'));
    https.get(url, { headers: { 'User-Agent': 'file-expo' }, timeout: 10000 }, (r) => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
        r.resume();
        return resolve(fetchUrl(r.headers.location, depth + 1));
      }
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => resolve({ status: r.statusCode, body: d }));
    }).on('error', reject).on('timeout', function () { this.destroy(new Error('timeout')); });
  });
}

function semverGt(a, b) {
  const pa = String(a).split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return false;
}

const UPDATE_SCRIPT = `#!/bin/bash
set -e
sleep 1
TMP=$(mktemp -d)
curl -fsSL "https://codeload.github.com/${REPO}/tar.gz/refs/heads/${BRANCH}" -o "$TMP/app.tar.gz"
mkdir -p "$TMP/x"
tar -xzf "$TMP/app.tar.gz" -C "$TMP/x" --strip-components=1
[ -f "$TMP/x/server/server.js" ]
rm -rf "${APP_ROOT}.new"
cp -a "$TMP/x" "${APP_ROOT}.new"
rm -rf "${APP_ROOT}.old"
mv "${APP_ROOT}" "${APP_ROOT}.old" 2>/dev/null || true
mv "${APP_ROOT}.new" "${APP_ROOT}"
rm -rf "${APP_ROOT}.old" "$TMP"
systemctl restart file-expo 2>/dev/null || { pkill -f "${APP_ROOT}/server/server.js" || true; sleep 1; nohup node "${APP_ROOT}/server/server.js" >/var/log/file-expo.log 2>&1 & }
`;

function detectPM() {
  try {
    const t = fs.readFileSync('/etc/os-release', 'utf8');
    const id = (t.match(/^ID=("?)([^"\n]*)\1/m) || [])[2] || '';
    const map = {
      ubuntu: 'apt', debian: 'apt', linuxmint: 'apt', pop: 'apt', raspbian: 'apt', kali: 'apt',
      arch: 'pacman', manjaro: 'pacman', endeavouros: 'pacman',
      fedora: 'dnf', centos: 'dnf', rhel: 'dnf', rocky: 'dnf', almalinux: 'dnf', amzn: 'dnf', ol: 'dnf',
      alpine: 'apk'
    };
    if (map[id]) return map[id];
    const like = (t.match(/^ID_LIKE=("?)([^"\n]*)\1/m) || [])[2] || '';
    for (const l of like.split(/\s+/)) if (map[l]) return map[l];
  } catch (e) {}
  return null;
}
const PM_INSTALL = {
  apt: (p) => `DEBIAN_FRONTEND=noninteractive apt-get install -y ${p}`,
  pacman: (p) => `pacman -S --noconfirm --needed ${p}`,
  dnf: (p) => `dnf install -y ${p}`,
  apk: (p) => `apk add ${p}`
};
const CERTBOT_PKGS = { apt: 'certbot python3-certbot-nginx', dnf: 'certbot python3-certbot-nginx', pacman: 'certbot certbot-nginx', apk: 'certbot certbot-nginx' };

function nginxDirs() {
  if (fs.existsSync('/etc/nginx/sites-available')) return { avail: '/etc/nginx/sites-available', enabled: '/etc/nginx/sites-enabled' };
  if (fs.existsSync('/etc/nginx/conf.d')) return { avail: '/etc/nginx/conf.d', enabled: null };
  return null;
}
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
async function hasCmd(c) { return (await run(`command -v ${c} >/dev/null 2>&1 && echo y`)).stdout.includes('y'); }

/* ---------- API ---------- */
async function handleApi(req, res, u) {
  const route = u.pathname.replace(/^\/api\//, '');
  const ip = req.socket.remoteAddress || '?';
  const authed = validSession(cookies(req).fx_sess);
  const P = u.searchParams;

  /* --- public routes --- */
  if (route === 'state') {
    return json(res, 200, { configured: conf.configured, authed, hostname: os.hostname(), version: VERSION });
  }

  if (route === 'setup/info') {
    if (conf.configured) return json(res, 400, { error: 'Already configured' });
    if (!safeEq(P.get('token') || '', conf.setupToken || 'x')) return json(res, 403, { error: 'Invalid setup token — copy the full link printed by the installer' });
    const tools = {};
    for (const t of ['zip', 'unzip', 'tar', 'rsync', 'file', 'curl']) {
      tools[t] = (await run(`command -v ${t} >/dev/null 2>&1 && echo y`)).stdout.includes('y');
    }
    return json(res, 200, {
      hostname: os.hostname(), distro: distroName(),
      user: os.userInfo().username, node: process.version,
      uname: `${os.platform()} ${os.release()} ${os.arch()}`, tools
    });
  }

  if (route === 'setup/complete' && req.method === 'POST') {
    if (conf.configured) return json(res, 400, { error: 'Already configured' });
    const b = await readBody(req);
    if (!safeEq(b.token || '', conf.setupToken || 'x')) return json(res, 403, { error: 'Invalid setup token' });
    if (!b.password || b.password.length < 6) return json(res, 400, { error: 'Password must be at least 6 characters' });
    conf.salt = crypto.randomBytes(16).toString('hex');
    conf.passHash = hashPass(b.password, conf.salt);
    conf.configured = true;
    conf.setupToken = null;
    saveConf();
    const t = newSession();
    res.setHeader('Set-Cookie', `fx_sess=${t}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESS_TTL / 1000}`);
    return json(res, 200, { ok: true });
  }

  if (route === 'login' && req.method === 'POST') {
    if (!conf.configured) return json(res, 400, { error: 'Not configured yet' });
    if (loginLocked(ip)) return json(res, 429, { error: 'Too many attempts — wait a minute' });
    const b = await readBody(req);
    if (!b.password || !safeEq(hashPass(b.password, conf.salt), conf.passHash)) {
      loginFail(ip);
      return json(res, 401, { error: 'Wrong password' });
    }
    loginFails.delete(ip);
    const t = newSession();
    res.setHeader('Set-Cookie', `fx_sess=${t}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESS_TTL / 1000}`);
    return json(res, 200, { ok: true });
  }

  /* --- everything below requires auth --- */
  if (!authed) return json(res, 401, { error: 'Login required' });

  if (route === 'logout' && req.method === 'POST') {
    sessions.delete(cookies(req).fx_sess);
    res.setHeader('Set-Cookie', 'fx_sess=; Path=/; Max-Age=0');
    return json(res, 200, { ok: true });
  }

  if (route === 'sysinfo') {
    return json(res, 200, {
      hostname: os.hostname(), distro: distroName(),
      user: os.userInfo().username, home: os.homedir(),
      uname: `${os.type()} ${os.release()} ${os.arch()}`,
      isRoot: typeof process.getuid === 'function' && process.getuid() === 0,
      version: VERSION
    });
  }

  if (route === 'list') {
    const dir = P.get('path') || '/';
    const names = await fsp.readdir(dir);
    const items = await Promise.all(names.map(async name => {
      const fp = path.posix.join(dir, name);
      try {
        const st = await fsp.lstat(fp);
        const isLink = st.isSymbolicLink();
        let isDir = st.isDirectory(), broken = false;
        if (isLink) {
          try { isDir = (await fsp.stat(fp)).isDirectory(); } catch (e) { broken = true; }
        }
        return {
          name, size: st.size, mtime: st.mtimeMs, uid: st.uid,
          owner: userMap[st.uid] || String(st.uid),
          mode: st.mode, perms: permString(st.mode), isDir, isLink, broken
        };
      } catch (e) {
        return { name, size: 0, mtime: 0, mode: 0, perms: '?????????', isDir: false, isLink: false, error: true };
      }
    }));
    return json(res, 200, items);
  }

  if (route === 'read') {
    const fp = P.get('path');
    const st = await fsp.stat(fp);
    if (st.size > 5 * 1024 * 1024) return json(res, 200, { tooLarge: true, size: st.size });
    const buf = await fsp.readFile(fp);
    if (buf.subarray(0, 8000).includes(0)) return json(res, 200, { binary: true, size: st.size });
    return json(res, 200, { content: buf.toString('utf8'), size: st.size });
  }

  if (route === 'write' && req.method === 'POST') {
    const b = await readBody(req);
    await fsp.writeFile(b.path, b.content, 'utf8');
    return json(res, 200, { ok: true });
  }

  if (route === 'mkdir' && req.method === 'POST') {
    const b = await readBody(req);
    await fsp.mkdir(b.path, { recursive: true });
    return json(res, 200, { ok: true });
  }

  if (route === 'touch' && req.method === 'POST') {
    const b = await readBody(req);
    if (fs.existsSync(b.path)) return json(res, 400, { error: 'A file with that name already exists' });
    await fsp.writeFile(b.path, '');
    return json(res, 200, { ok: true });
  }

  if (route === 'rename' && req.method === 'POST') {
    const b = await readBody(req);
    await fsp.rename(b.from, b.to);
    return json(res, 200, { ok: true });
  }

  if (route === 'delete' && req.method === 'POST') {
    const b = await readBody(req);
    for (const p of b.paths || []) await fsp.rm(p, { recursive: true, force: true });
    return json(res, 200, { ok: true });
  }

  if (route === 'copyMove' && req.method === 'POST') {
    const b = await readBody(req);
    const cmd = b.move ? 'mv' : 'cp -a';
    const r = await run(`${cmd} -- ${b.paths.map(q).join(' ')} ${q(b.dest)}/`);
    if (r.code !== 0) return json(res, 400, { error: r.stderr.trim() || 'operation failed' });
    return json(res, 200, { ok: true });
  }

  if (route === 'chmod' && req.method === 'POST') {
    const b = await readBody(req);
    if (!/^[0-7]{3,4}$/.test(b.octal)) return json(res, 400, { error: 'Invalid mode' });
    const r = await run(`chmod ${b.recursive ? '-R ' : ''}${b.octal} -- ${q(b.path)}`);
    if (r.code !== 0) return json(res, 400, { error: r.stderr.trim() || 'chmod failed' });
    return json(res, 200, { ok: true });
  }

  if (route === 'search') {
    const base = P.get('base') || '/', query = (P.get('q') || '').replace(/[*?[\]]/g, '');
    if (P.get('mode') === 'content') {
      const r = await run(
        `grep -rIn -m1 -i --exclude-dir=.git --exclude-dir=node_modules -e ${q(query)} ${q(base)} 2>/dev/null | head -200`,
        { timeout: 45000 });
      const out = r.stdout.split('\n').filter(Boolean).map(l => {
        const m = l.match(/^(.*?):(\d+):(.*)$/);
        return m ? { path: m[1], line: +m[2], snippet: m[3].trim().slice(0, 140) } : null;
      }).filter(Boolean);
      return json(res, 200, out);
    }
    const r = await run(`find ${q(base)} -iname ${q('*' + query + '*')} 2>/dev/null | head -300`, { timeout: 30000 });
    return json(res, 200, r.stdout.split('\n').map(s => s.trim()).filter(Boolean).map(p => ({ path: p })));
  }

  if (route === 'du') {
    const p0 = P.get('path');
    const r = await run(`du -k -d1 -- ${q(p0)} 2>/dev/null | sort -rn | head -40`, { timeout: 90000 });
    const rows = r.stdout.split('\n').filter(Boolean).map(l => {
      const m = l.match(/^(\d+)\s+(.*)$/);
      return m ? { size: +m[1] * 1024, path: m[2] } : null;
    }).filter(Boolean);
    return json(res, 200, rows);
  }

  if (route === 'duplicate' && req.method === 'POST') {
    const b = await readBody(req);
    const dir = path.posix.dirname(b.path), base = path.posix.basename(b.path);
    const dot = base.startsWith('.') ? -1 : base.lastIndexOf('.');
    const stem = dot > 0 ? base.slice(0, dot) : base;
    const ext = dot > 0 ? base.slice(dot) : '';
    let cand, i = 0;
    do { cand = path.posix.join(dir, stem + '-copy' + (i ? '-' + i : '') + ext); i++; } while (fs.existsSync(cand) && i < 100);
    const r = await run(`cp -a -- ${q(b.path)} ${q(cand)}`);
    if (r.code !== 0) return json(res, 400, { error: r.stderr.trim() || 'copy failed' });
    return json(res, 200, { ok: true, name: path.posix.basename(cand) });
  }

  /* ---------- trash ---------- */
  if (route === 'trash' && req.method === 'POST') {
    const b = await readBody(req);
    fs.mkdirSync(TRASH_DIR, { recursive: true });
    const list = loadTrash();
    const ids = [];
    for (const p of b.paths || []) {
      const id = crypto.randomBytes(6).toString('hex');
      const base = path.posix.basename(p);
      const r = await run(`mv -- ${q(p)} ${q(path.join(TRASH_DIR, id + '__' + base))}`);
      if (r.code === 0) { list.push({ id, name: base, orig: p, at: Date.now() }); ids.push(id); }
    }
    saveTrash(list);
    if (!ids.length) return json(res, 400, { error: 'Nothing could be moved to trash' });
    return json(res, 200, { ok: true, ids });
  }

  if (route === 'trash/list') {
    return json(res, 200, loadTrash().sort((a, b2) => b2.at - a.at));
  }

  if (route === 'trash/restore' && req.method === 'POST') {
    const b = await readBody(req);
    let list = loadTrash();
    for (const id of b.ids || []) {
      const en = list.find(x => x.id === id);
      if (!en) continue;
      let dest = en.orig;
      if (fs.existsSync(dest)) dest = dest + '.restored-' + id.slice(0, 4);
      await run(`mkdir -p -- ${q(path.posix.dirname(en.orig))}`);
      const r = await run(`mv -- ${q(path.join(TRASH_DIR, en.id + '__' + en.name))} ${q(dest)}`);
      if (r.code === 0) list = list.filter(x => x.id !== id);
    }
    saveTrash(list);
    return json(res, 200, { ok: true });
  }

  if (route === 'trash/purge' && req.method === 'POST') {
    const b = await readBody(req);
    let list = loadTrash();
    if (b.all) {
      await run(`rm -rf -- ${q(TRASH_DIR)}`);
      saveTrash([]);
      return json(res, 200, { ok: true });
    }
    for (const id of b.ids || []) {
      const en = list.find(x => x.id === id);
      if (!en) continue;
      await run(`rm -rf -- ${q(path.join(TRASH_DIR, en.id + '__' + en.name))}`);
      list = list.filter(x => x.id !== id);
    }
    saveTrash(list);
    return json(res, 200, { ok: true });
  }

  /* ---------- share links ---------- */
  if (route === 'share/create' && req.method === 'POST') {
    const b = await readBody(req);
    if (!fs.existsSync(b.path)) return json(res, 400, { error: 'File not found' });
    const hours = parseFloat(b.hours);
    const token = crypto.randomBytes(12).toString('hex');
    conf.shares = conf.shares || [];
    conf.shares.push({
      token, path: b.path, name: path.posix.basename(b.path),
      expires: hours > 0 ? Date.now() + hours * 3600000 : null,
      created: Date.now()
    });
    saveConf();
    return json(res, 200, { ok: true, url: '/s/' + token });
  }

  if (route === 'share/list') {
    return json(res, 200, (conf.shares || []).map(s => ({
      ...s, expired: !!(s.expires && Date.now() > s.expires)
    })));
  }

  if (route === 'share/revoke' && req.method === 'POST') {
    const b = await readBody(req);
    conf.shares = (conf.shares || []).filter(s => s.token !== b.token);
    saveConf();
    return json(res, 200, { ok: true });
  }

  /* ---------- multi download as archive ---------- */
  if (route === 'download-multi') {
    const base = P.get('base') || '/';
    let names;
    try { names = JSON.parse(P.get('names') || '[]'); } catch (e) { names = []; }
    names = names.filter(n => typeof n === 'string' && n && !n.includes('/') && n !== '..');
    if (!names.length) return json(res, 400, { error: 'No items' });
    res.writeHead(200, {
      'Content-Type': 'application/gzip',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.posix.basename(base) || 'files')}-selection.tar.gz`
    });
    const tar = spawn('tar', ['-czf', '-', '-C', base, ...names]);
    tar.stdout.pipe(res);
    tar.on('error', () => res.end());
    req.on('close', () => tar.kill());
    return;
  }

  /* ---------- git ---------- */
  if (route === 'git/info') {
    const p0 = P.get('path');
    const top = await run(`git -C ${q(p0)} rev-parse --show-toplevel 2>/dev/null`);
    if (top.code !== 0) return json(res, 200, { repo: false });
    const branch = (await run(`git -C ${q(p0)} branch --show-current 2>/dev/null`)).stdout.trim();
    const sb = (await run(`git -C ${q(p0)} status -sb 2>/dev/null | head -1`)).stdout.trim();
    const status = (await run(`git -C ${q(p0)} status --porcelain 2>/dev/null | head -60`)).stdout.trimEnd();
    const log = (await run(`git -C ${q(p0)} log --oneline -12 2>/dev/null`)).stdout.trimEnd();
    return json(res, 200, {
      repo: true, root: top.stdout.trim(), branch, sb, status, log,
      changes: status ? status.split('\n').length : 0
    });
  }

  if (route === 'git/action' && req.method === 'POST') {
    const b = await readBody(req);
    if (!['pull', 'fetch'].includes(b.action)) return json(res, 400, { error: 'Bad action' });
    const r = await run(`git -C ${q(b.path)} ${b.action} 2>&1`, { timeout: 120000 });
    return json(res, 200, { code: r.code, output: (r.stdout + r.stderr).trim().slice(-2000) });
  }

  /* ---------- docker ---------- */
  if (route === 'docker/ps') {
    if (!(await hasCmd('docker'))) return json(res, 200, { installed: false, containers: [] });
    const r = await run(`docker ps -a --format '{{.ID}}|{{.Names}}|{{.Image}}|{{.Status}}|{{.Ports}}' 2>/dev/null`);
    const containers = r.stdout.split('\n').filter(Boolean).map(l => {
      const p = l.split('|');
      return { id: p[0], name: p[1] || '', image: p[2] || '', status: p[3] || '', ports: p[4] || '' };
    });
    return json(res, 200, { installed: true, containers });
  }

  if (route === 'docker/action' && req.method === 'POST') {
    const b = await readBody(req);
    if (!/^[A-Za-z0-9_.-]+$/.test(b.id || '')) return json(res, 400, { error: 'Bad container id' });
    if (!['start', 'stop', 'restart', 'rm'].includes(b.action)) return json(res, 400, { error: 'Bad action' });
    const cmd = b.action === 'rm' ? 'rm -f' : b.action;
    const r = await run(`docker ${cmd} ${q(b.id)} 2>&1`, { timeout: 60000 });
    if (r.code !== 0) return json(res, 400, { error: (r.stdout + r.stderr).trim().slice(-400) });
    return json(res, 200, { ok: true });
  }

  if (route === 'docker/logs') {
    const id = P.get('id') || '';
    if (!/^[A-Za-z0-9_.-]+$/.test(id)) return json(res, 400, { error: 'Bad id' });
    const r = await run(`docker logs --tail 150 ${q(id)} 2>&1 | tail -c 60000`);
    return json(res, 200, { text: r.stdout.trim() || '(no logs)' });
  }

  if (route === 'props') {
    const fp = P.get('path');
    const st = await fsp.stat(fp);
    let duSize = null, fileType = null;
    if (st.isDirectory()) duSize = (await run(`du -sh -- ${q(fp)} 2>/dev/null | cut -f1`, { timeout: 30000 })).stdout.trim() || null;
    else fileType = (await run(`file -b -- ${q(fp)} 2>/dev/null`)).stdout.trim() || null;
    return json(res, 200, {
      size: st.size, mode: st.mode, perms: permString(st.mode),
      octal: (st.mode & 0o7777).toString(8).padStart(3, '0'),
      uid: st.uid, gid: st.gid,
      owner: userMap[st.uid] || String(st.uid), group: String(st.gid),
      mtime: st.mtimeMs, atime: st.atimeMs, duSize, fileType
    });
  }

  if (route === 'compress' && req.method === 'POST') {
    const b = await readBody(req);
    const names = b.items.map(q).join(' ');
    let cmd;
    if (b.name.endsWith('.zip')) cmd = `zip -ryq ${q(b.name)} ${names}`;
    else if (b.name.endsWith('.tar.gz') || b.name.endsWith('.tgz')) cmd = `tar -czf ${q(b.name)} ${names}`;
    else if (b.name.endsWith('.tar')) cmd = `tar -cf ${q(b.name)} ${names}`;
    else return json(res, 400, { error: 'Use a .zip, .tar.gz or .tar name' });
    const r = await run(cmd, { cwd: b.dir, timeout: 600000 });
    if (r.code !== 0) return json(res, 400, { error: r.stderr.trim() || 'compress failed (is zip/tar installed?)' });
    return json(res, 200, { ok: true });
  }

  if (route === 'extract' && req.method === 'POST') {
    const b = await readBody(req);
    let cmd;
    if (/\.zip$/i.test(b.file)) cmd = `unzip -oq ${q(b.file)} -d ${q(b.dest)}`;
    else if (/\.(tar\.gz|tgz|tar\.bz2|tbz2|tar\.xz|txz|tar)$/i.test(b.file)) cmd = `tar -xf ${q(b.file)} -C ${q(b.dest)}`;
    else if (/\.gz$/i.test(b.file)) cmd = `gunzip -k ${q(b.file)}`;
    else return json(res, 400, { error: 'Unsupported archive type' });
    const r = await run(cmd, { timeout: 600000 });
    if (r.code !== 0) return json(res, 400, { error: r.stderr.trim() || 'extract failed' });
    return json(res, 200, { ok: true });
  }

  if (route === 'exec' && req.method === 'POST') {
    const b = await readBody(req);
    const r = await run(b.cmd, { cwd: b.cwd, timeout: 60000 });
    return json(res, 200, { code: r.code, output: (r.stdout + (r.stderr ? '\n' + r.stderr : '')).trim() });
  }

  if (route === 'upload' && req.method === 'POST') {
    const dir = P.get('dir') || '/tmp';
    const rel = cleanRel(P.get('rel'));
    if (!rel) return json(res, 400, { error: 'Missing file name' });
    const dest = path.posix.join(dir, rel);
    await fsp.mkdir(path.posix.dirname(dest), { recursive: true });
    await new Promise((resolve, reject) => {
      const ws = fs.createWriteStream(dest);
      req.pipe(ws);
      ws.on('finish', resolve);
      ws.on('error', reject);
      req.on('error', reject);
    });
    return json(res, 200, { ok: true });
  }

  if (route === 'download') {
    const fp = P.get('path');
    const st = await fsp.stat(fp);
    const base = path.posix.basename(fp) || 'root';
    if (st.isDirectory()) {
      res.writeHead(200, {
        'Content-Type': 'application/gzip',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(base)}.tar.gz`
      });
      const tar = spawn('tar', ['-czf', '-', '-C', path.posix.dirname(fp) || '/', base]);
      tar.stdout.pipe(res);
      tar.on('error', () => res.end());
      req.on('close', () => tar.kill());
    } else {
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': st.size,
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(base)}`
      });
      fs.createReadStream(fp).pipe(res);
    }
    return;
  }

  /* ---------- raw preview (Range support for media seeking) ---------- */
  if (route === 'raw') {
    const fp = P.get('path');
    const st = await fsp.stat(fp);
    const ext = path.posix.extname(fp).toLowerCase();
    const mime = RAW_MIME[ext] || 'application/octet-stream';
    const range = req.headers.range;
    if (range && st.size) {
      const m = range.match(/bytes=(\d*)-(\d*)/);
      let start = m && m[1] ? parseInt(m[1], 10) : 0;
      let end = m && m[2] ? parseInt(m[2], 10) : st.size - 1;
      if (isNaN(start) || start >= st.size) start = 0;
      if (isNaN(end) || end >= st.size) end = st.size - 1;
      res.writeHead(206, {
        'Content-Type': mime, 'Accept-Ranges': 'bytes',
        'Content-Range': `bytes ${start}-${end}/${st.size}`,
        'Content-Length': end - start + 1
      });
      fs.createReadStream(fp, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { 'Content-Type': mime, 'Content-Length': st.size, 'Accept-Ranges': 'bytes' });
      fs.createReadStream(fp).pipe(res);
    }
    return;
  }

  /* ---------- self-update from GitHub ---------- */
  if (route === 'update/check') {
    try {
      const r = await fetchUrl(`https://raw.githubusercontent.com/${REPO}/${BRANCH}/version.json`);
      const latest = String((JSON.parse(r.body) || {}).version || '').trim();
      return json(res, 200, { current: VERSION, latest: latest || null, updateAvailable: !!latest && semverGt(latest, VERSION) });
    } catch (e) {
      return json(res, 200, { current: VERSION, latest: null, updateAvailable: false, error: e.message });
    }
  }

  if (route === 'changelog') {
    const out = [];
    const dir = path.join(APP_ROOT, 'changelog');
    const files = (await fsp.readdir(dir).catch(() => [])).filter(f => /^\d+\.\d+\.\d+\.md$/.test(f));
    for (const f of files) {
      out.push({ version: f.replace(/\.md$/, ''), content: await fsp.readFile(path.join(dir, f), 'utf8') });
    }
    // if a newer version exists on GitHub, pull its changelog too so users see what's coming
    try {
      const chk = await fetchUrl(`https://raw.githubusercontent.com/${REPO}/${BRANCH}/version.json`);
      const latest = String((JSON.parse(chk.body) || {}).version || '').trim();
      if (latest && semverGt(latest, VERSION) && !out.find(o => o.version === latest)) {
        const md = await fetchUrl(`https://raw.githubusercontent.com/${REPO}/${BRANCH}/changelog/${latest}.md`);
        if (md.status === 200) out.push({ version: latest, content: md.body, isNew: true });
      }
    } catch (e) {}
    out.sort((a, b) => semverGt(a.version, b.version) ? -1 : 1);
    return json(res, 200, out);
  }

  if (route === 'update/run' && req.method === 'POST') {
    const scriptPath = path.join(os.tmpdir(), 'fx-update.sh');
    fs.writeFileSync(scriptPath, UPDATE_SCRIPT, { mode: 0o755 });
    const child = spawn('bash', [scriptPath], { detached: true, stdio: 'ignore' });
    child.unref();
    return json(res, 200, { ok: true });
  }

  /* ---------- system tools ---------- */
  if (route === 'system/stats') {
    let mem = { total: os.totalmem(), avail: os.freemem() };
    try {
      const mi = fs.readFileSync('/proc/meminfo', 'utf8');
      const g = (k) => { const m = mi.match(new RegExp('^' + k + ':\\s+(\\d+)', 'm')); return m ? parseInt(m[1], 10) * 1024 : null; };
      if (g('MemTotal')) mem = { total: g('MemTotal'), avail: g('MemAvailable') != null ? g('MemAvailable') : g('MemFree') };
    } catch (e) {}
    const df = await run('df -kP 2>/dev/null | tail -n +2');
    const disks = df.stdout.split('\n').filter(Boolean).map(l => {
      const p = l.trim().split(/\s+/);
      return { fs: p[0], size: (+p[1] || 0) * 1024, used: (+p[2] || 0) * 1024, pct: parseInt(p[4], 10) || 0, mount: p.slice(5).join(' ') };
    }).filter(d => d.mount && !/^\/(dev|sys|proc|run|snap|boot\/efi)/.test(d.mount) && d.size > 0).slice(0, 6);
    return json(res, 200, {
      hostname: os.hostname(), distro: distroName(), uptime: os.uptime(),
      loadavg: os.loadavg(), cpus: os.cpus().length,
      cpuModel: (os.cpus()[0] || {}).model || '',
      mem, disks, node: process.version, version: VERSION
    });
  }

  if (route === 'system/services') {
    const r = await run('systemctl list-units --type=service --all --no-pager --no-legend --plain 2>/dev/null | head -300');
    const list = r.stdout.split('\n').map(l => l.trim()).filter(Boolean).map(l => {
      const p = l.split(/\s+/);
      return { name: p[0], load: p[1], active: p[2], sub: p[3], desc: p.slice(4).join(' ') };
    }).filter(s => s.name && s.name.endsWith('.service'));
    return json(res, 200, list);
  }

  if (route === 'system/service' && req.method === 'POST') {
    const b = await readBody(req);
    if (!/^[A-Za-z0-9_.@:-]+$/.test(b.name || '')) return json(res, 400, { error: 'Bad service name' });
    if (!['start', 'stop', 'restart', 'enable', 'disable'].includes(b.action)) return json(res, 400, { error: 'Bad action' });
    const r = await run(`systemctl ${b.action} ${q(b.name)} 2>&1`, { timeout: 60000 });
    if (r.code !== 0) return json(res, 400, { error: (r.stdout + r.stderr).trim().slice(-400) || 'failed' });
    return json(res, 200, { ok: true });
  }

  if (route === 'system/logs') {
    const name = P.get('name') || '';
    if (!/^[A-Za-z0-9_.@:-]+$/.test(name)) return json(res, 400, { error: 'Bad name' });
    const r = await run(`journalctl -u ${q(name)} -n 150 --no-pager 2>&1 | tail -c 60000`);
    return json(res, 200, { text: (r.stdout || r.stderr).trim() });
  }

  if (route === 'system/processes') {
    const r = await run('ps aux --sort=-%cpu 2>/dev/null | head -50');
    const lines = r.stdout.split('\n').filter(Boolean);
    const procs = lines.slice(1).map(l => {
      const p = l.trim().split(/\s+/);
      return { user: p[0], pid: parseInt(p[1], 10), cpu: p[2], mem: p[3], stat: p[7], cmd: p.slice(10).join(' ').slice(0, 160) };
    }).filter(x => x.pid);
    return json(res, 200, procs);
  }

  if (route === 'system/kill' && req.method === 'POST') {
    const b = await readBody(req);
    const pid = parseInt(b.pid, 10);
    if (!pid || pid < 2) return json(res, 400, { error: 'Bad pid' });
    try { process.kill(pid, b.force ? 'SIGKILL' : 'SIGTERM'); }
    catch (e) { return json(res, 400, { error: e.message }); }
    return json(res, 200, { ok: true });
  }

  if (route === 'system/ports') {
    const r = await run('ss -tulnp 2>/dev/null || netstat -tulnp 2>/dev/null');
    return json(res, 200, { text: r.stdout.trim() || 'ss / netstat not available' });
  }

  if (route === 'system/cron' && req.method === 'GET') {
    const r = await run('crontab -l 2>/dev/null');
    return json(res, 200, { content: r.code === 0 ? r.stdout : '' });
  }

  if (route === 'system/cron' && req.method === 'POST') {
    const b = await readBody(req);
    const tmp = path.join(os.tmpdir(), 'fx-cron-' + process.pid);
    await fsp.writeFile(tmp, String(b.content || '').replace(/\r\n/g, '\n').replace(/\n*$/, '\n'));
    const r = await run(`crontab ${q(tmp)} 2>&1`);
    await fsp.unlink(tmp).catch(() => {});
    if (r.code !== 0) return json(res, 400, { error: (r.stdout + r.stderr).trim().slice(-400) });
    return json(res, 200, { ok: true });
  }

  /* ---------- domains (nginx + certbot) ---------- */
  if (route === 'domains/list') {
    const hasNginx = await hasCmd('nginx');
    const hasCertbot = await hasCmd('certbot');
    const dirs = nginxDirs();
    const sites = [];
    if (hasNginx && dirs) {
      const files = await fsp.readdir(dirs.avail).catch(() => []);
      for (const f of files) {
        if (!f.startsWith('fx-')) continue;
        try {
          const txt = await fsp.readFile(path.join(dirs.avail, f), 'utf8');
          const domain = ((txt.match(/server_name\s+([^;]+);/) || [])[1] || f).trim();
          const proxy = (txt.match(/proxy_pass\s+([^;]+);/) || [])[1];
          const root = (txt.match(/root\s+([^;]+);/) || [])[1];
          sites.push({
            file: f, domain,
            target: (proxy || root || '').trim(),
            mode: proxy ? 'proxy' : 'static',
            ssl: /listen\s+443/.test(txt)
          });
        } catch (e) {}
      }
    }
    return json(res, 200, { hasNginx, hasCertbot, sites });
  }

  if (route === 'domains/add' && req.method === 'POST') {
    const b = await readBody(req);
    const domain = String(b.domain || '').toLowerCase().trim();
    if (!DOMAIN_RE.test(domain)) return json(res, 400, { error: 'Invalid domain name (e.g. example.com)' });
    const log = [];
    if (!(await hasCmd('nginx'))) {
      const pm = detectPM();
      if (!pm || !PM_INSTALL[pm]) return json(res, 400, { error: 'nginx is not installed and the package manager is unknown — install nginx manually first' });
      log.push('nginx not found — installing it now…');
      const ri = await run(PM_INSTALL[pm]('nginx'), { timeout: 300000 });
      if (ri.code !== 0) return json(res, 400, { error: 'nginx install failed: ' + (ri.stderr || ri.stdout).slice(-400) });
      await run('systemctl enable --now nginx 2>/dev/null || nginx');
      log.push('nginx installed and started');
    }
    const dirs = nginxDirs();
    if (!dirs) return json(res, 400, { error: 'Could not locate nginx config directory' });
    let block;
    if (b.mode === 'static') {
      const rootDir = String(b.target || '').trim();
      if (!rootDir.startsWith('/')) return json(res, 400, { error: 'Static site target must be an absolute folder path (e.g. /var/www/mysite)' });
      block = `server {
    listen 80;
    listen [::]:80;
    server_name ${domain};
    root ${rootDir};
    index index.html index.htm;
    location / { try_files $uri $uri/ =404; }
}`;
    } else {
      const port = parseInt(b.target, 10);
      if (!port || port < 1 || port > 65535) return json(res, 400, { error: 'Reverse-proxy target must be a port number (e.g. 3000)' });
      block = `server {
    listen 80;
    listen [::]:80;
    server_name ${domain};
    client_max_body_size 512m;
    location / {
        proxy_pass http://127.0.0.1:${port};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}`;
    }
    const file = path.join(dirs.avail, `fx-${domain}.conf`);
    await fsp.writeFile(file, block + '\n');
    if (dirs.enabled) await run(`ln -sf ${q(file)} ${q(path.join(dirs.enabled, `fx-${domain}.conf`))}`);
    log.push('Config written: ' + file);
    const t = await run('nginx -t 2>&1');
    if (t.code !== 0) {
      await fsp.unlink(file).catch(() => {});
      if (dirs.enabled) await fsp.unlink(path.join(dirs.enabled, `fx-${domain}.conf`)).catch(() => {});
      return json(res, 400, { error: 'nginx config test failed: ' + (t.stdout + t.stderr).slice(-400) });
    }
    await run('systemctl reload nginx 2>/dev/null || nginx -s reload');
    log.push(`nginx reloaded — http://${domain} is live`);
    log.push(`Make sure ${domain} has a DNS A record pointing to this server's IP.`);
    log.push('Next: click "Enable HTTPS" to get a free Let’s Encrypt certificate.');
    return json(res, 200, { ok: true, log });
  }

  if (route === 'domains/ssl' && req.method === 'POST') {
    const b = await readBody(req);
    const domain = String(b.domain || '').toLowerCase().trim();
    const email = String(b.email || '').trim();
    if (!DOMAIN_RE.test(domain)) return json(res, 400, { error: 'Invalid domain' });
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(res, 400, { error: 'A valid email is required for Let’s Encrypt' });
    const log = [];
    if (!(await hasCmd('certbot'))) {
      const pm = detectPM();
      if (!pm || !CERTBOT_PKGS[pm]) return json(res, 400, { error: 'certbot is not installed and cannot be auto-installed on this distro' });
      log.push('Installing certbot…');
      const ri = await run(PM_INSTALL[pm](CERTBOT_PKGS[pm]), { timeout: 300000 });
      if (ri.code !== 0) return json(res, 400, { error: 'certbot install failed: ' + (ri.stderr || ri.stdout).slice(-400) });
      log.push('certbot installed');
    }
    const r = await run(`certbot --nginx -d ${q(domain)} --non-interactive --agree-tos -m ${q(email)} --redirect 2>&1`, { timeout: 300000 });
    if (r.code !== 0) return json(res, 400, { error: (r.stdout + r.stderr).slice(-800) });
    log.push(`SSL certificate installed — https://${domain} is live (auto-renews)`);
    return json(res, 200, { ok: true, log });
  }

  if (route === 'domains/delete' && req.method === 'POST') {
    const b = await readBody(req);
    const domain = String(b.domain || '').toLowerCase().trim();
    if (!DOMAIN_RE.test(domain)) return json(res, 400, { error: 'Invalid domain' });
    const dirs = nginxDirs();
    if (!dirs) return json(res, 400, { error: 'nginx config directory not found' });
    await fsp.unlink(path.join(dirs.avail, `fx-${domain}.conf`)).catch(() => {});
    if (dirs.enabled) await fsp.unlink(path.join(dirs.enabled, `fx-${domain}.conf`)).catch(() => {});
    await run('systemctl reload nginx 2>/dev/null || nginx -s reload');
    return json(res, 200, { ok: true });
  }

  json(res, 404, { error: 'Unknown API route: ' + route });
}

/* ---------- server ---------- */
async function handleShare(req, res, u) {
  const token = u.pathname.slice(3);
  const sh = (conf.shares || []).find(s => s.token === token);
  if (!sh) return json(res, 404, { error: 'This share link does not exist or was revoked' });
  if (sh.expires && Date.now() > sh.expires) return json(res, 410, { error: 'This share link has expired' });
  const st = await fsp.stat(sh.path).catch(() => null);
  if (!st) return json(res, 404, { error: 'The shared file no longer exists' });
  const base = path.posix.basename(sh.path) || 'file';
  if (st.isDirectory()) {
    res.writeHead(200, {
      'Content-Type': 'application/gzip',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(base)}.tar.gz`
    });
    const tar = spawn('tar', ['-czf', '-', '-C', path.posix.dirname(sh.path) || '/', base]);
    tar.stdout.pipe(res);
    tar.on('error', () => res.end());
    req.on('close', () => tar.kill());
  } else {
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': st.size,
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(base)}`
    });
    fs.createReadStream(sh.path).pipe(res);
  }
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  try {
    if (u.pathname.startsWith('/api/')) await handleApi(req, res, u);
    else if (u.pathname.startsWith('/s/')) await handleShare(req, res, u);
    else serveStatic(req, res, u.pathname);
  } catch (err) {
    if (!res.headersSent) json(res, 500, { error: err.message });
    else res.end();
  }
});

server.listen(conf.port, '0.0.0.0', () => {
  console.log(`File Expo v${VERSION} listening on port ${conf.port}`);
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    if (/^(docker|br-|veth|virbr|lo)/.test(name)) continue;
    for (const n of nets[name] || []) {
      if (n.family === 'IPv4' && !n.internal) {
        console.log(`  → http://${n.address}:${conf.port}${conf.configured ? '' : '/?token=' + conf.setupToken}`);
      }
    }
  }
  if (!conf.configured) console.log(`Setup token: ${conf.setupToken}`);
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
