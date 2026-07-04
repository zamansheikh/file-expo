#!/usr/bin/env node
/* File Expo — self-hosted web file manager (zero-dependency Node.js server) */
'use strict';

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { exec, spawn } = require('child_process');
const os = require('os');

const CONF_DIR = process.env.FILE_EXPO_CONF || '/etc/file-expo';
const CONF_FILE = path.join(CONF_DIR, 'config.json');
const PUB = path.join(__dirname, 'public');
const VERSION = '1.0.0';

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
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  fs.createReadStream(fp).pipe(res);
}

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
    const r = await run(`find ${q(base)} -iname ${q('*' + query + '*')} 2>/dev/null | head -300`, { timeout: 30000 });
    return json(res, 200, r.stdout.split('\n').map(s => s.trim()).filter(Boolean));
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

  json(res, 404, { error: 'Unknown API route: ' + route });
}

/* ---------- server ---------- */
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  try {
    if (u.pathname.startsWith('/api/')) await handleApi(req, res, u);
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
