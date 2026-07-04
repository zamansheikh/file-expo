const { app, BrowserWindow, ipcMain, dialog, safeStorage, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { Client } = require('ssh2');

const APP_VERSION = '1.0.0';

let win = null;
let ssh = null;
let sftp = null;
let sys = null; // { user, home, uid, distroId, distroName, pm, sudo, users, groups }
let transferSeq = 0;

app.setName('File Expo');

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 880,
    minWidth: 980,
    minHeight: 620,
    backgroundColor: '#0b0f14',
    autoHideMenuBar: true,
    title: 'File Expo',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { cleanup(); app.quit(); });

function cleanup() {
  try { if (ssh) ssh.end(); } catch (e) {}
  ssh = null; sftp = null; sys = null;
}

function send(ch, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(ch, payload);
}

// shell-quote a path/arg for the remote POSIX shell
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

function requireConn() {
  if (!ssh || !sftp) throw new Error('Not connected to a server');
}

function execRemote(cmd, { timeout = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!ssh) return reject(new Error('Not connected'));
    ssh.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      let out = '', errOut = '';
      const timer = setTimeout(() => {
        try { stream.close(); } catch (e) {}
        resolve({ code: 124, stdout: out, stderr: errOut + '\n[command timed out]' });
      }, timeout);
      stream.on('data', d => { out += d.toString(); });
      stream.stderr.on('data', d => { errOut += d.toString(); });
      stream.on('close', (code) => { clearTimeout(timer); resolve({ code: code == null ? 0 : code, stdout: out, stderr: errOut }); });
    });
  });
}

function execStream(cmd, onLine, { timeout = 600000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!ssh) return reject(new Error('Not connected'));
    ssh.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      let buf = '', code = null;
      const feed = (d) => {
        buf += d.toString();
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).replace(/\r$/, '');
          buf = buf.slice(i + 1);
          if (line.trim()) onLine(line);
        }
      };
      const timer = setTimeout(() => { try { stream.close(); } catch (e) {} resolve(124); }, timeout);
      stream.on('data', feed);
      stream.stderr.on('data', feed);
      stream.on('close', (c) => {
        clearTimeout(timer);
        if (buf.trim()) onLine(buf.trim());
        code = c == null ? 0 : c;
        resolve(code);
      });
    });
  });
}

const sftpReaddir = (p) => new Promise((res, rej) => sftp.readdir(p, (e, l) => e ? rej(e) : res(l)));
const sftpStat = (p) => new Promise((res, rej) => sftp.stat(p, (e, s) => e ? rej(e) : res(s)));

function permString(mode) {
  const t = mode & 0o170000;
  let s = t === 0o040000 ? 'd' : t === 0o120000 ? 'l' : t === 0o140000 ? 's' : t === 0o060000 ? 'b' : t === 0o020000 ? 'c' : t === 0o010000 ? 'p' : '-';
  const bits = ['r', 'w', 'x'];
  for (let g = 2; g >= 0; g--) {
    for (let b = 0; b < 3; b++) {
      s += (mode >> (g * 3 + (2 - b))) & 1 ? bits[b] : '-';
    }
  }
  return s;
}

// ---------- connection profiles (stored encrypted) ----------

const storeFile = () => path.join(app.getPath('userData'), 'connections.json');

async function loadProfiles() {
  try { return JSON.parse(await fsp.readFile(storeFile(), 'utf8')); } catch (e) { return []; }
}
async function saveProfiles(list) {
  await fsp.mkdir(path.dirname(storeFile()), { recursive: true });
  await fsp.writeFile(storeFile(), JSON.stringify(list, null, 2));
}
function encSecret(plain) {
  if (!plain) return null;
  try { return safeStorage.encryptString(plain).toString('base64'); } catch (e) { return Buffer.from(plain).toString('base64'); }
}
function decSecret(enc) {
  if (!enc) return null;
  try { return safeStorage.decryptString(Buffer.from(enc, 'base64')); } catch (e) { return Buffer.from(enc, 'base64').toString('utf8'); }
}

ipcMain.handle('profiles:list', async () => {
  const list = await loadProfiles();
  return list.map(p => ({ id: p.id, name: p.name, host: p.host, port: p.port, username: p.username, auth: p.auth, keyPath: p.keyPath || '', hasPassword: !!p.encPassword }));
});

ipcMain.handle('profiles:save', async (e, prof) => {
  const list = await loadProfiles();
  const rec = {
    id: prof.id || String(Date.now()),
    name: prof.name || `${prof.username}@${prof.host}`,
    host: prof.host, port: prof.port || 22, username: prof.username,
    auth: prof.auth, keyPath: prof.keyPath || null,
    encPassword: prof.password ? encSecret(prof.password) : null,
    encPassphrase: prof.passphrase ? encSecret(prof.passphrase) : null
  };
  const idx = list.findIndex(p => p.id === rec.id);
  if (idx >= 0) {
    if (!rec.encPassword) rec.encPassword = list[idx].encPassword;
    if (!rec.encPassphrase) rec.encPassphrase = list[idx].encPassphrase;
    list[idx] = rec;
  } else list.push(rec);
  await saveProfiles(list);
  return { ok: true, id: rec.id };
});

ipcMain.handle('profiles:delete', async (e, id) => {
  const list = await loadProfiles();
  await saveProfiles(list.filter(p => p.id !== id));
  return { ok: true };
});

// ---------- connect / system detection ----------

const PM_FROM_ID = {
  ubuntu: 'apt', debian: 'apt', linuxmint: 'apt', pop: 'apt', raspbian: 'apt', kali: 'apt',
  arch: 'pacman', manjaro: 'pacman', endeavouros: 'pacman',
  fedora: 'dnf', centos: 'dnf', rhel: 'dnf', rocky: 'dnf', almalinux: 'dnf', amzn: 'dnf', ol: 'dnf',
  alpine: 'apk',
  opensuse: 'zypper', 'opensuse-leap': 'zypper', 'opensuse-tumbleweed': 'zypper', sles: 'zypper'
};

async function detectSystem() {
  const r = await execRemote(
    'echo "@USER=$(whoami)"; echo "@HOME=$HOME"; echo "@UID=$(id -u)"; echo "@UNAME=$(uname -smr)"; cat /etc/os-release 2>/dev/null'
  );
  const get = (k) => { const m = r.stdout.match(new RegExp('^@' + k + '=(.*)$', 'm')); return m ? m[1].trim() : ''; };
  const osGet = (k) => {
    const m = r.stdout.match(new RegExp('^' + k + '=("?)([^"\\n]*)\\1', 'm'));
    return m ? m[2].trim() : '';
  };
  const id = (osGet('ID') || 'linux').toLowerCase();
  const idLike = (osGet('ID_LIKE') || '').toLowerCase().split(/\s+/).filter(Boolean);
  let pm = PM_FROM_ID[id] || null;
  if (!pm) for (const alt of idLike) { if (PM_FROM_ID[alt]) { pm = PM_FROM_ID[alt]; break; } }
  if (!pm) {
    const probe = await execRemote('for c in apt-get pacman dnf yum apk zypper; do command -v $c >/dev/null 2>&1 && echo $c && break; done');
    const found = probe.stdout.trim();
    pm = { 'apt-get': 'apt', pacman: 'pacman', dnf: 'dnf', yum: 'yum', apk: 'apk', zypper: 'zypper' }[found] || null;
  }

  const uid = parseInt(get('UID'), 10);
  let sudo = null;
  if (uid === 0) sudo = '';
  else {
    const s = await execRemote('sudo -n true 2>/dev/null && echo OK');
    if (s.stdout.includes('OK')) sudo = 'sudo -n ';
  }

  // uid/gid -> name maps (best effort)
  const users = {}, groups = {};
  const pw = await execRemote('cat /etc/passwd 2>/dev/null');
  pw.stdout.split('\n').forEach(l => { const p = l.split(':'); if (p.length > 3) users[p[2]] = p[0]; });
  const gr = await execRemote('cat /etc/group 2>/dev/null');
  gr.stdout.split('\n').forEach(l => { const p = l.split(':'); if (p.length > 2) groups[p[2]] = p[0]; });

  sys = {
    user: get('USER'), home: get('HOME') || '/', uid,
    uname: get('UNAME'),
    distroId: id,
    distroName: osGet('PRETTY_NAME') || osGet('NAME') || 'Linux',
    pm, sudo, users, groups
  };
  return sys;
}

ipcMain.handle('ssh:connect', async (e, opts) => {
  cleanup();
  let creds = opts;
  if (opts.profileId) {
    const list = await loadProfiles();
    const p = list.find(x => x.id === opts.profileId);
    if (!p) throw new Error('Saved connection not found');
    creds = { ...p, password: decSecret(p.encPassword), passphrase: decSecret(p.encPassphrase) };
  }
  const cfg = {
    host: creds.host,
    port: parseInt(creds.port, 10) || 22,
    username: creds.username,
    readyTimeout: 25000,
    keepaliveInterval: 15000,
    keepaliveCountMax: 4,
    tryKeyboard: true
  };
  if (creds.auth === 'key') {
    if (!creds.keyPath) throw new Error('Private key file is required');
    cfg.privateKey = await fsp.readFile(creds.keyPath);
    if (creds.passphrase) cfg.passphrase = creds.passphrase;
  } else {
    cfg.password = creds.password || '';
  }

  ssh = await new Promise((resolve, reject) => {
    const c = new Client();
    c.on('keyboard-interactive', (name, inst, lang, prompts, finish) => {
      finish(prompts.map(() => creds.password || ''));
    });
    c.on('ready', () => resolve(c));
    c.on('error', (err) => reject(new Error(err.level === 'client-authentication' ? 'Authentication failed — check username / password / key' : err.message)));
    c.on('close', () => { if (ssh === c) { ssh = null; sftp = null; send('ssh:closed', {}); } });
    c.connect(cfg);
  });

  sftp = await new Promise((resolve, reject) => ssh.sftp((err, s) => err ? reject(err) : resolve(s)));

  const info = await detectSystem();
  const inst = await execRemote('cat "$HOME/.file-expo/installed" 2>/dev/null');
  const needsSetup = inst.stdout.trim() !== APP_VERSION;

  return {
    ok: true,
    user: info.user, home: info.home, uname: info.uname,
    distroId: info.distroId, distroName: info.distroName, pm: info.pm,
    isRoot: info.uid === 0, canSudo: info.sudo !== null,
    host: creds.host,
    needsSetup,
    version: APP_VERSION,
    users: info.users, groups: info.groups
  };
});

ipcMain.handle('ssh:disconnect', async () => { cleanup(); return { ok: true }; });

// ---------- OS-style setup / installer ----------

const SETUP_PKGS = ['rsync', 'zip', 'unzip', 'tar', 'file', 'curl'];

const PM_CMDS = {
  apt: {
    label: 'APT (Debian / Ubuntu)',
    update: 'DEBIAN_FRONTEND=noninteractive apt-get update -y',
    install: (p) => `DEBIAN_FRONTEND=noninteractive apt-get install -y ${p}`
  },
  pacman: {
    label: 'Pacman (Arch Linux)',
    update: 'pacman -Sy --noconfirm',
    install: (p) => `pacman -S --noconfirm --needed ${p}`
  },
  dnf: {
    label: 'DNF (Fedora / RHEL)',
    update: 'dnf -y makecache',
    install: (p) => `dnf install -y ${p}`
  },
  yum: {
    label: 'YUM (CentOS legacy)',
    update: 'yum makecache -y',
    install: (p) => `yum install -y ${p}`
  },
  apk: {
    label: 'APK (Alpine)',
    update: 'apk update',
    install: (p) => `apk add ${p}`
  },
  zypper: {
    label: 'Zypper (openSUSE)',
    update: 'zypper --non-interactive refresh',
    install: (p) => `zypper --non-interactive install -y ${p}`
  }
};

ipcMain.handle('setup:run', async () => {
  requireConn();
  const total = 6;
  let stepIdx = 0;
  const step = (label, state) => send('setup:step', { index: stepIdx, total, label, state });
  const log = (line) => send('setup:log', { line });

  const results = { missing: [], warnings: [] };

  // 1 — probe
  step('Probing system', 'running');
  log(`Connected as ${sys.user} on ${sys.distroName}`);
  log(`Kernel: ${sys.uname}`);
  log(`Package manager: ${sys.pm ? PM_CMDS[sys.pm].label : 'not detected'}`);
  await new Promise(r => setTimeout(r, 400));
  step('Probing system', 'done'); stepIdx++;

  // 2 — privileges
  step('Checking privileges', 'running');
  if (sys.sudo === '') log('Running as root — full access granted.');
  else if (sys.sudo !== null) log('Passwordless sudo available — using sudo for package installation.');
  else {
    log('No root / passwordless sudo. Package installation will be skipped.');
    log('File management works fine without it; archive tools may be unavailable.');
    results.warnings.push('No sudo — packages not installed');
  }
  await new Promise(r => setTimeout(r, 300));
  step('Checking privileges', 'done'); stepIdx++;

  const canInstall = sys.sudo !== null && sys.pm && PM_CMDS[sys.pm];

  // 3 — package index
  if (canInstall) {
    step('Refreshing package index', 'running');
    log(`$ ${sys.sudo}${PM_CMDS[sys.pm].update}`);
    const code = await execStream(sys.sudo + PM_CMDS[sys.pm].update, log);
    if (code !== 0) { log(`Package index refresh exited with code ${code} (continuing).`); results.warnings.push('Package index refresh failed'); }
    step('Refreshing package index', code === 0 ? 'done' : 'warn');
  } else {
    step('Refreshing package index', 'skip');
    log('Skipping package index refresh.');
  }
  stepIdx++;

  // 4 — install components
  if (canInstall) {
    step('Installing components', 'running');
    const cmd = sys.sudo + PM_CMDS[sys.pm].install(SETUP_PKGS.join(' '));
    log(`$ ${cmd}`);
    const code = await execStream(cmd, log);
    if (code !== 0) { log(`Installer exited with code ${code} (continuing).`); results.warnings.push('Some packages failed to install'); }
    step('Installing components', code === 0 ? 'done' : 'warn');
  } else {
    step('Installing components', 'skip');
    log('Skipping component installation (no privileges or unknown package manager).');
  }
  stepIdx++;

  // 5 — verify tools
  step('Verifying tools', 'running');
  for (const t of SETUP_PKGS) {
    const r = await execRemote(`command -v ${t} >/dev/null 2>&1 && echo yes || echo no`);
    const ok = r.stdout.includes('yes');
    log(`${ok ? '  [ok]   ' : '  [miss] '}${t}`);
    if (!ok) results.missing.push(t);
  }
  step('Verifying tools', 'done'); stepIdx++;

  // 6 — workspace
  step('Creating workspace', 'running');
  await execRemote(`mkdir -p "$HOME/.file-expo" && printf '%s' ${q(APP_VERSION)} > "$HOME/.file-expo/installed" && date > "$HOME/.file-expo/installed_at"`);
  log('Workspace ready at ~/.file-expo');
  log('Setup complete. Welcome to File Expo!');
  step('Creating workspace', 'done'); stepIdx++;

  return { ok: true, ...results };
});

// ---------- file operations ----------

ipcMain.handle('fs:list', async (e, dir) => {
  requireConn();
  const entries = await sftpReaddir(dir);
  const items = entries.map(en => {
    const m = en.attrs.mode || 0;
    const t = m & 0o170000;
    return {
      name: en.filename,
      size: en.attrs.size || 0,
      mtime: (en.attrs.mtime || 0) * 1000,
      uid: en.attrs.uid, gid: en.attrs.gid,
      mode: m,
      perms: permString(m),
      isDir: t === 0o040000,
      isLink: t === 0o120000
    };
  });
  // resolve symlink targets so linked dirs open as dirs
  await Promise.all(items.filter(i => i.isLink).map(async i => {
    try {
      const st = await sftpStat((dir === '/' ? '' : dir) + '/' + i.name);
      i.isDir = (st.mode & 0o170000) === 0o040000;
    } catch (err) { /* broken link */ i.broken = true; }
  }));
  return items;
});

ipcMain.handle('fs:read', async (e, file) => {
  requireConn();
  const st = await sftpStat(file);
  if (st.size > 5 * 1024 * 1024) return { tooLarge: true, size: st.size };
  const buf = await new Promise((res, rej) => sftp.readFile(file, (err, b) => err ? rej(err) : res(b)));
  const probe = buf.subarray(0, 8000);
  if (probe.includes(0)) return { binary: true, size: st.size };
  return { content: buf.toString('utf8'), size: st.size };
});

ipcMain.handle('fs:write', async (e, file, content) => {
  requireConn();
  await new Promise((res, rej) => sftp.writeFile(file, content, 'utf8', (err) => err ? rej(err) : res()));
  return { ok: true };
});

ipcMain.handle('fs:mkdir', async (e, p) => {
  requireConn();
  const r = await execRemote(`mkdir -p -- ${q(p)}`);
  if (r.code !== 0) throw new Error(r.stderr.trim() || 'mkdir failed');
  return { ok: true };
});

ipcMain.handle('fs:touch', async (e, p) => {
  requireConn();
  const r = await execRemote(`if [ -e ${q(p)} ]; then echo EXISTS; else touch -- ${q(p)}; fi`);
  if (r.stdout.includes('EXISTS')) throw new Error('A file with that name already exists');
  if (r.code !== 0) throw new Error(r.stderr.trim() || 'touch failed');
  return { ok: true };
});

ipcMain.handle('fs:rename', async (e, oldPath, newPath) => {
  requireConn();
  try {
    await new Promise((res, rej) => sftp.rename(oldPath, newPath, (err) => err ? rej(err) : res()));
  } catch (err) {
    const r = await execRemote(`mv -- ${q(oldPath)} ${q(newPath)}`);
    if (r.code !== 0) throw new Error(r.stderr.trim() || 'rename failed');
  }
  return { ok: true };
});

ipcMain.handle('fs:delete', async (e, paths) => {
  requireConn();
  const r = await execRemote(`rm -rf -- ${paths.map(q).join(' ')}`);
  if (r.code !== 0) throw new Error(r.stderr.trim() || 'delete failed');
  return { ok: true };
});

ipcMain.handle('fs:copyMove', async (e, paths, destDir, move) => {
  requireConn();
  const cmd = move ? 'mv' : 'cp -a';
  const r = await execRemote(`${cmd} -- ${paths.map(q).join(' ')} ${q(destDir)}/`);
  if (r.code !== 0) throw new Error(r.stderr.trim() || (move ? 'move failed' : 'copy failed'));
  return { ok: true };
});

ipcMain.handle('fs:chmod', async (e, p, octal, recursive) => {
  requireConn();
  if (!/^[0-7]{3,4}$/.test(octal)) throw new Error('Invalid mode');
  const r = await execRemote(`chmod ${recursive ? '-R ' : ''}${octal} -- ${q(p)}`);
  if (r.code !== 0) throw new Error(r.stderr.trim() || 'chmod failed');
  return { ok: true };
});

ipcMain.handle('fs:search', async (e, base, query) => {
  requireConn();
  const pat = q('*' + query.replace(/[*?[\]]/g, '') + '*');
  const r = await execRemote(`find ${q(base)} -iname ${pat} 2>/dev/null | head -300`, { timeout: 30000 });
  return r.stdout.split('\n').map(s => s.trim()).filter(Boolean);
});

ipcMain.handle('fs:props', async (e, p, isDir) => {
  requireConn();
  const st = await sftpStat(p);
  let duSize = null, fileType = null;
  if (isDir) {
    const du = await execRemote(`du -sh -- ${q(p)} 2>/dev/null | cut -f1`, { timeout: 30000 });
    duSize = du.stdout.trim() || null;
  } else {
    const ft = await execRemote(`file -b -- ${q(p)} 2>/dev/null`);
    fileType = ft.stdout.trim() || null;
  }
  return {
    size: st.size, mode: st.mode, perms: permString(st.mode),
    octal: (st.mode & 0o7777).toString(8).padStart(3, '0'),
    uid: st.uid, gid: st.gid,
    owner: (sys && sys.users[st.uid]) || String(st.uid),
    group: (sys && sys.groups[st.gid]) || String(st.gid),
    mtime: st.mtime * 1000, atime: st.atime * 1000,
    duSize, fileType
  };
});

ipcMain.handle('fs:compress', async (e, dir, items, archiveName) => {
  requireConn();
  const names = items.map(q).join(' ');
  let cmd;
  if (archiveName.endsWith('.zip')) cmd = `cd ${q(dir)} && zip -ryq ${q(archiveName)} ${names}`;
  else if (archiveName.endsWith('.tar.gz') || archiveName.endsWith('.tgz')) cmd = `tar -czf ${q(dir + '/' + archiveName)} -C ${q(dir)} ${names}`;
  else if (archiveName.endsWith('.tar')) cmd = `tar -cf ${q(dir + '/' + archiveName)} -C ${q(dir)} ${names}`;
  else throw new Error('Use a .zip, .tar.gz or .tar name');
  const r = await execRemote(cmd, { timeout: 600000 });
  if (r.code !== 0) throw new Error(r.stderr.trim() || 'compress failed (is zip/tar installed?)');
  return { ok: true };
});

ipcMain.handle('fs:extract', async (e, file, destDir) => {
  requireConn();
  let cmd;
  if (/\.zip$/i.test(file)) cmd = `unzip -oq ${q(file)} -d ${q(destDir)}`;
  else if (/\.(tar\.gz|tgz|tar\.bz2|tbz2|tar\.xz|txz|tar)$/i.test(file)) cmd = `tar -xf ${q(file)} -C ${q(destDir)}`;
  else if (/\.gz$/i.test(file)) cmd = `gunzip -k ${q(file)}`;
  else throw new Error('Unsupported archive type');
  const r = await execRemote(cmd, { timeout: 600000 });
  if (r.code !== 0) throw new Error(r.stderr.trim() || 'extract failed (is unzip/tar installed?)');
  return { ok: true };
});

ipcMain.handle('fs:exec', async (e, cmd, cwd) => {
  requireConn();
  const r = await execRemote(`cd ${q(cwd)} 2>/dev/null; ${cmd}`, { timeout: 60000 });
  return { code: r.code, output: (r.stdout + (r.stderr ? '\n' + r.stderr : '')).trim() };
});

// ---------- transfers ----------

const lastEmit = {};
function progress(id, name, dir, done, total, state, error) {
  const now = Date.now();
  if (state === 'active' && lastEmit[id] && now - lastEmit[id] < 120) return;
  lastEmit[id] = now;
  send('transfer:progress', { id, name, dir, done, total, state, error: error || null });
  if (state !== 'active') delete lastEmit[id];
}

async function walkLocal(root) {
  const st = await fsp.stat(root);
  const base = path.basename(root);
  if (st.isFile()) return { files: [{ local: root, rel: base, size: st.size }], dirs: [] };
  const files = [], dirs = [base];
  async function rec(abs, rel) {
    const ents = await fsp.readdir(abs, { withFileTypes: true });
    for (const en of ents) {
      const a = path.join(abs, en.name), r = rel + '/' + en.name;
      if (en.isDirectory()) { dirs.push(r); await rec(a, r); }
      else if (en.isFile()) {
        try { const s = await fsp.stat(a); files.push({ local: a, rel: r, size: s.size }); } catch (err) {}
      }
    }
  }
  await rec(root, base);
  return { files, dirs };
}

async function walkRemote(rp) {
  const st = await sftpStat(rp);
  const base = rp.split('/').filter(Boolean).pop() || 'root';
  if ((st.mode & 0o170000) !== 0o040000) return { files: [{ remote: rp, rel: base, size: st.size }], dirs: [] };
  const files = [], dirs = [base];
  async function rec(abs, rel) {
    const list = await sftpReaddir(abs);
    for (const en of list) {
      const a = abs + '/' + en.filename, r = rel + '/' + en.filename;
      const t = (en.attrs.mode || 0) & 0o170000;
      if (t === 0o040000) { dirs.push(r); await rec(a, r); }
      else if (t === 0o100000) files.push({ remote: a, rel: r, size: en.attrs.size || 0 });
    }
  }
  await rec(rp, base);
  return { files, dirs };
}

ipcMain.handle('transfer:upload', async (e, localPaths, remoteDir) => {
  requireConn();
  let okCount = 0, failCount = 0;
  for (const lp of localPaths) {
    let plan;
    try { plan = await walkLocal(lp); }
    catch (err) { failCount++; continue; }
    if (plan.dirs.length) {
      await execRemote('mkdir -p -- ' + plan.dirs.map(d => q(remoteDir + '/' + d)).join(' '));
    }
    for (const f of plan.files) {
      const id = 'up' + (++transferSeq);
      const remote = remoteDir + '/' + f.rel;
      progress(id, f.rel, 'up', 0, f.size, 'active');
      try {
        await new Promise((res, rej) =>
          sftp.fastPut(f.local, remote, { step: (t) => progress(id, f.rel, 'up', t, f.size, 'active') },
            (err) => err ? rej(err) : res()));
        progress(id, f.rel, 'up', f.size, f.size, 'done');
        okCount++;
      } catch (err) {
        progress(id, f.rel, 'up', 0, f.size, 'error', err.message);
        failCount++;
      }
    }
  }
  return { ok: failCount === 0, okCount, failCount };
});

ipcMain.handle('transfer:download', async (e, remotePaths, localDir) => {
  requireConn();
  let okCount = 0, failCount = 0;
  for (const rp of remotePaths) {
    let plan;
    try { plan = await walkRemote(rp); }
    catch (err) { failCount++; continue; }
    for (const d of plan.dirs) {
      await fsp.mkdir(path.join(localDir, ...d.split('/')), { recursive: true });
    }
    for (const f of plan.files) {
      const id = 'dn' + (++transferSeq);
      const local = path.join(localDir, ...f.rel.split('/'));
      progress(id, f.rel, 'dn', 0, f.size, 'active');
      try {
        await fsp.mkdir(path.dirname(local), { recursive: true });
        await new Promise((res, rej) =>
          sftp.fastGet(f.remote, local, { step: (t) => progress(id, f.rel, 'dn', t, f.size, 'active') },
            (err) => err ? rej(err) : res()));
        progress(id, f.rel, 'dn', f.size, f.size, 'done');
        okCount++;
      } catch (err) {
        progress(id, f.rel, 'dn', 0, f.size, 'error', err.message);
        failCount++;
      }
    }
  }
  return { ok: failCount === 0, okCount, failCount, localDir };
});

// ---------- local dialogs / shell ----------

ipcMain.handle('dialog:pickFiles', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'] });
  return r.canceled ? [] : r.filePaths;
});
ipcMain.handle('dialog:pickFolder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('dialog:pickKey', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'], title: 'Select private key' });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('shell:openLocal', async (e, p) => { shell.openPath(p); return { ok: true }; });
