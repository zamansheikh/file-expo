/* File Expo — WebSocket terminal (zero dependencies)
 *
 * Implements just enough of RFC 6455 to stream a PTY to the browser,
 * and spawns a real pseudo-terminal so interactive programs work.
 */
'use strict';

const crypto = require('crypto');
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/* ---------- minimal WebSocket framing ---------- */

function encodeFrame(data, opcode = 0x2) {
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeUInt32BE(Math.floor(len / 4294967296), 2);
    header.writeUInt32BE(len >>> 0, 6);
  }
  header[0] = 0x80 | opcode; // FIN + opcode
  return Buffer.concat([header, data]);
}

class FrameParser {
  constructor(onMessage, onClose) {
    this.buf = Buffer.alloc(0);
    this.onMessage = onMessage;
    this.onClose = onClose;
  }
  push(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0], b1 = this.buf[1];
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) === 0x80;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < off + 2) return;
        len = this.buf.readUInt16BE(off);
        off += 2;
      } else if (len === 127) {
        if (this.buf.length < off + 8) return;
        const hi = this.buf.readUInt32BE(off);
        const lo = this.buf.readUInt32BE(off + 4);
        len = hi * 4294967296 + lo;
        off += 8;
      }
      let mask = null;
      if (masked) {
        if (this.buf.length < off + 4) return;
        mask = this.buf.subarray(off, off + 4);
        off += 4;
      }
      if (this.buf.length < off + len) return;
      let payload = Buffer.from(this.buf.subarray(off, off + len));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      this.buf = this.buf.subarray(off + len);

      if (opcode === 0x8) { this.onClose(); return; }        // close
      if (opcode === 0x9) { this.onMessage(payload, 'ping'); continue; }
      if (opcode === 0x1 || opcode === 0x2) this.onMessage(payload, 'data');
      // 0xA (pong) and continuation frames: ignored — the client never sends them
    }
  }
}

/* ---------- PTY spawning ---------- */

function have(cmd) {
  try { execSync(`command -v ${cmd} >/dev/null 2>&1`, { shell: '/bin/sh' }); return true; }
  catch (e) { return false; }
}

function pickShell() {
  for (const s of ['/bin/bash', '/usr/bin/bash', '/bin/sh']) if (fs.existsSync(s)) return s;
  return process.env.SHELL || '/bin/sh';
}

/**
 * Spawns a real PTY. Three strategies, best first:
 *   1. python3 bridge  — true PTY + live window resize (Ubuntu/Debian ship python3)
 *   2. script(1)       — true PTY, resize via `stty` inside the shell
 *   3. plain pipes     — degraded: no interactive apps, but commands still run
 */
function spawnPty({ cwd, cols, rows }) {
  const shell = pickShell();
  const bridge = path.join(__dirname, 'pty-bridge.py');

  if (have('python3') && fs.existsSync(bridge)) {
    const p = spawn('python3', [bridge, shell, cwd || '/', String(cols || 80), String(rows || 24)], {
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'] // fd3 = resize control channel
    });
    return {
      mode: 'pty',
      proc: p,
      write: (d) => { try { p.stdin.write(d); } catch (e) {} },
      resize: (c, r) => { try { p.stdio[3].write(`${c},${r}\n`); } catch (e) {} },
      kill: () => { try { p.kill('SIGHUP'); } catch (e) {} }
    };
  }

  if (have('script')) {
    const p = spawn('script', ['-qfec', `${shell} -i`, '/dev/null'], {
      cwd: cwd || '/',
      env: { ...process.env, TERM: 'xterm-256color', COLUMNS: String(cols || 80), LINES: String(rows || 24) }
    });
    return {
      mode: 'script',
      proc: p,
      write: (d) => { try { p.stdin.write(d); } catch (e) {} },
      resize: (c, r) => { try { p.stdin.write(`stty cols ${c} rows ${r} 2>/dev/null\n`); } catch (e) {} },
      kill: () => { try { p.kill('SIGHUP'); } catch (e) {} }
    };
  }

  const p = spawn(shell, ['-i'], {
    cwd: cwd || '/',
    env: { ...process.env, TERM: 'dumb', PS1: '\\w $ ' }
  });
  return {
    mode: 'pipe',
    proc: p,
    write: (d) => { try { p.stdin.write(d); } catch (e) {} },
    resize: () => {},
    kill: () => { try { p.kill('SIGHUP'); } catch (e) {} }
  };
}

/* ---------- upgrade handler ---------- */

function attach(server, { isAuthed }) {
  server.on('upgrade', (req, socket, head) => {
    if (!req.url.startsWith('/ws/term')) { socket.destroy(); return; }
    if (!isAuthed(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    const key = req.headers['sec-websocket-key'];
    if (!key) { socket.destroy(); return; }

    const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
    socket.setNoDelay(true);

    const u = new URL(req.url, 'http://x');
    const cwd = u.searchParams.get('cwd') || '/';
    const cols = Math.min(500, Math.max(20, parseInt(u.searchParams.get('cols'), 10) || 80));
    const rows = Math.min(200, Math.max(5, parseInt(u.searchParams.get('rows'), 10) || 24));

    let pty;
    try { pty = spawnPty({ cwd, cols, rows }); }
    catch (err) {
      socket.write(encodeFrame(Buffer.from('\r\n\x1b[31mCould not start a shell: ' + err.message + '\x1b[0m\r\n')));
      socket.destroy();
      return;
    }

    let closed = false;
    const send = (buf) => { if (!closed && !socket.destroyed) { try { socket.write(encodeFrame(buf)); } catch (e) {} } };
    const cleanup = () => {
      if (closed) return;
      closed = true;
      pty.kill();
      try { socket.destroy(); } catch (e) {}
    };

    if (pty.mode === 'pipe') {
      send(Buffer.from('\x1b[33mNote: no PTY available (install python3 for full interactive support).\x1b[0m\r\n'));
    }

    pty.proc.stdout.on('data', send);
    if (pty.proc.stderr) pty.proc.stderr.on('data', send);
    pty.proc.on('exit', () => {
      send(Buffer.from('\r\n\x1b[90m[session ended — press Enter or reopen the terminal to start a new one]\x1b[0m\r\n'));
      cleanup();
    });
    pty.proc.on('error', (e) => {
      send(Buffer.from('\r\n\x1b[31m' + e.message + '\x1b[0m\r\n'));
      cleanup();
    });

    const parser = new FrameParser((payload, kind) => {
      if (kind === 'ping') { if (!socket.destroyed) socket.write(encodeFrame(payload, 0xA)); return; }
      // control messages are JSON prefixed with \x00, everything else is keystrokes
      if (payload.length && payload[0] === 0) {
        try {
          const msg = JSON.parse(payload.subarray(1).toString('utf8'));
          if (msg.t === 'resize') pty.resize(msg.cols, msg.rows);
        } catch (e) {}
        return;
      }
      pty.write(payload);
    }, cleanup);

    socket.on('data', (chunk) => { try { parser.push(chunk); } catch (e) { cleanup(); } });
    socket.on('close', cleanup);
    socket.on('error', cleanup);
  });
}

module.exports = { attach };
