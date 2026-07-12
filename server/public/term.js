/* File Expo — terminal emulator (VT100/xterm subset, no dependencies)
 *
 * Screen buffer + ANSI parser + renderer + keyboard, wired to the PTY
 * WebSocket. Enough of xterm to run bash, vim, top, htop, nano, less, git,
 * npm, docker — with colors, cursor control and an alternate screen.
 */
'use strict';

const ANSI_16 = [
  '#0c0c0c', '#c94f4f', '#4fc98a', '#d3b14a', '#4f9ed3', '#a86fd6', '#4fc9c9', '#c8d0d8',
  '#5c6672', '#ff6b6b', '#57e08f', '#f2d06b', '#6fb8ff', '#c58cf5', '#6fe3e3', '#ffffff'
];

function xterm256(n) {
  if (n < 16) return ANSI_16[n];
  if (n < 232) {
    n -= 16;
    const lv = [0, 95, 135, 175, 215, 255];
    const r = lv[Math.floor(n / 36) % 6], g = lv[Math.floor(n / 6) % 6], b = lv[n % 6];
    return `rgb(${r},${g},${b})`;
  }
  const v = 8 + (n - 232) * 10;
  return `rgb(${v},${v},${v})`;
}

const DEF_FG = '#d5e2ee';
const DEF_BG = 'transparent';

class Term {
  constructor(el, { onData }) {
    this.el = el;
    this.onData = onData;
    this.cols = 80;
    this.rows = 24;
    this.cx = 0;
    this.cy = 0;
    this.scrollTop = 0;
    this.scrollBot = 23;
    this.cursorVisible = true;
    this.altScreen = null;
    this.saved = null;
    this.attr = this.defaultAttr();
    this.parse = { state: 'text', buf: '' };
    this.dirty = true;
    this.frame = null;
    this.scrollback = [];
    this.maxScrollback = 1500;
    this.viewOffset = 0; // >0 = scrolled up into history

    this.screen = this.blankScreen(this.rows, this.cols);
    // streaming decoder: a multi-byte character split across two WebSocket
    // chunks must not turn into garbage
    this.decoder = new TextDecoder('utf-8', { fatal: false });

    el.classList.add('xterm-lite');
    el.tabIndex = 0;
    this.bindInput();
    this.bindScroll();
  }

  defaultAttr() {
    return { fg: null, bg: null, bold: false, dim: false, italic: false, underline: false, inverse: false };
  }
  blankRow(cols) {
    const row = new Array(cols);
    for (let i = 0; i < cols; i++) row[i] = { ch: ' ', a: null };
    return row;
  }
  blankScreen(rows, cols) {
    const s = new Array(rows);
    for (let r = 0; r < rows; r++) s[r] = this.blankRow(cols);
    return s;
  }

  /* ---------- sizing ---------- */
  fit() {
    // measure a single character with the terminal's own font
    const probe = document.createElement('span');
    probe.textContent = 'M';
    probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre';
    this.el.appendChild(probe);
    const cw = probe.getBoundingClientRect().width || 8;
    const chRect = probe.getBoundingClientRect().height || 17;
    probe.remove();

    const style = getComputedStyle(this.el);
    const padX = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
    const padY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
    const cols = Math.max(20, Math.floor((this.el.clientWidth - padX) / cw));
    const rows = Math.max(5, Math.floor((this.el.clientHeight - padY) / chRect));
    if (cols === this.cols && rows === this.rows) return null;
    this.resize(cols, rows);
    return { cols, rows };
  }

  resize(cols, rows) {
    const old = this.screen;
    const oldRows = this.rows;
    this.cols = cols;
    this.rows = rows;
    const next = this.blankScreen(rows, cols);
    // keep the bottom of the old screen (what the user is looking at)
    const copy = Math.min(oldRows, rows);
    const srcStart = Math.max(0, oldRows - copy);
    for (let r = 0; r < copy; r++) {
      const src = old[srcStart + r];
      for (let c = 0; c < Math.min(cols, src.length); c++) next[r][c] = src[c];
    }
    this.screen = next;
    this.scrollTop = 0;
    this.scrollBot = rows - 1;
    this.cy = Math.min(this.cy - srcStart < 0 ? 0 : this.cy - srcStart, rows - 1);
    this.cx = Math.min(this.cx, cols - 1);
    this.markDirty();
  }

  /* ---------- writing ---------- */
  write(data) {
    const s = typeof data === 'string' ? data : this.decoder.decode(data, { stream: true });
    for (let i = 0; i < s.length; i++) this.consume(s[i]);
    this.viewOffset = 0; // any output snaps back to the live screen
    this.markDirty();
  }

  consume(ch) {
    const p = this.parse;
    if (p.state === 'esc') {
      if (ch === '[') { p.state = 'csi'; p.buf = ''; return; }
      if (ch === ']') { p.state = 'osc'; p.buf = ''; return; }
      if (ch === '(' || ch === ')') { p.state = 'charset'; return; }
      if (ch === '7') { this.saveCursor(); p.state = 'text'; return; }
      if (ch === '8') { this.restoreCursor(); p.state = 'text'; return; }
      if (ch === 'M') { this.reverseIndex(); p.state = 'text'; return; }
      if (ch === 'c') { this.reset(); p.state = 'text'; return; }
      p.state = 'text';
      return;
    }
    if (p.state === 'charset') { p.state = 'text'; return; }
    if (p.state === 'csi') {
      if (/[\x40-\x7e]/.test(ch)) { this.csi(p.buf, ch); p.state = 'text'; p.buf = ''; }
      else p.buf += ch;
      return;
    }
    if (p.state === 'osc') {
      // OSC ... BEL  or  OSC ... ESC \   — window title etc: consumed & ignored
      if (ch === '\x07') { p.state = 'text'; p.buf = ''; return; }
      if (ch === '\x1b') { p.state = 'oscEsc'; return; }
      p.buf += ch;
      return;
    }
    if (p.state === 'oscEsc') { p.state = 'text'; p.buf = ''; return; }

    // plain text state
    switch (ch) {
      case '\x1b': p.state = 'esc'; return;
      case '\r': this.cx = 0; return;
      case '\n': this.lineFeed(); return;
      case '\b': this.cx = Math.max(0, this.cx - 1); return;
      case '\t': this.cx = Math.min(this.cols - 1, (Math.floor(this.cx / 8) + 1) * 8); return;
      case '\x07': return; // bell
      case '\x00': return;
      default:
        if (ch < ' ') return;
        this.putChar(ch);
    }
  }

  putChar(ch) {
    if (this.cx >= this.cols) { this.cx = 0; this.lineFeed(); }
    this.screen[this.cy][this.cx] = { ch, a: this.attrSnapshot() };
    this.cx++;
  }

  attrSnapshot() {
    const a = this.attr;
    if (!a.fg && !a.bg && !a.bold && !a.dim && !a.italic && !a.underline && !a.inverse) return null;
    return { ...a };
  }

  lineFeed() {
    if (this.cy === this.scrollBot) this.scrollUp(1);
    else if (this.cy < this.rows - 1) this.cy++;
  }
  reverseIndex() {
    if (this.cy === this.scrollTop) this.scrollDown(1);
    else if (this.cy > 0) this.cy--;
  }
  scrollUp(n) {
    for (let i = 0; i < n; i++) {
      const gone = this.screen.splice(this.scrollTop, 1)[0];
      if (!this.altScreenActive && this.scrollTop === 0) {
        this.scrollback.push(gone);
        if (this.scrollback.length > this.maxScrollback) this.scrollback.shift();
      }
      this.screen.splice(this.scrollBot, 0, this.blankRow(this.cols));
    }
  }
  scrollDown(n) {
    for (let i = 0; i < n; i++) {
      this.screen.splice(this.scrollBot, 1);
      this.screen.splice(this.scrollTop, 0, this.blankRow(this.cols));
    }
  }
  saveCursor() { this.saved = { cx: this.cx, cy: this.cy, attr: { ...this.attr } }; }
  restoreCursor() {
    if (!this.saved) return;
    this.cx = Math.min(this.saved.cx, this.cols - 1);
    this.cy = Math.min(this.saved.cy, this.rows - 1);
    this.attr = { ...this.saved.attr };
  }
  reset() {
    this.screen = this.blankScreen(this.rows, this.cols);
    this.cx = this.cy = 0;
    this.attr = this.defaultAttr();
    this.scrollTop = 0;
    this.scrollBot = this.rows - 1;
  }

  csi(buf, cmd) {
    const priv = buf.startsWith('?');
    const body = priv ? buf.slice(1) : buf;
    const args = body.split(';').map(x => parseInt(x, 10));
    const a0 = isNaN(args[0]) ? 0 : args[0];
    const n = a0 || 1;

    if (priv) {
      const on = cmd === 'h';
      if (cmd !== 'h' && cmd !== 'l') return;
      for (const code of args) {
        if (code === 25) this.cursorVisible = on;
        else if (code === 1049 || code === 47 || code === 1047) this.setAltScreen(on);
      }
      return;
    }

    switch (cmd) {
      case 'A': this.cy = Math.max(0, this.cy - n); break;
      case 'B': this.cy = Math.min(this.rows - 1, this.cy + n); break;
      case 'C': this.cx = Math.min(this.cols - 1, this.cx + n); break;
      case 'D': this.cx = Math.max(0, this.cx - n); break;
      case 'E': this.cy = Math.min(this.rows - 1, this.cy + n); this.cx = 0; break;
      case 'F': this.cy = Math.max(0, this.cy - n); this.cx = 0; break;
      case 'G': case '`': this.cx = Math.min(this.cols - 1, n - 1); break;
      case 'd': this.cy = Math.min(this.rows - 1, n - 1); break;
      case 'H': case 'f': {
        const r = (isNaN(args[0]) ? 1 : args[0] || 1) - 1;
        const c = (isNaN(args[1]) ? 1 : args[1] || 1) - 1;
        this.cy = Math.max(0, Math.min(this.rows - 1, r));
        this.cx = Math.max(0, Math.min(this.cols - 1, c));
        break;
      }
      case 'J': this.eraseDisplay(a0); break;
      case 'K': this.eraseLine(a0); break;
      case 'L': { // insert lines
        for (let i = 0; i < n && this.cy <= this.scrollBot; i++) {
          this.screen.splice(this.scrollBot, 1);
          this.screen.splice(this.cy, 0, this.blankRow(this.cols));
        }
        break;
      }
      case 'M': { // delete lines
        for (let i = 0; i < n && this.cy <= this.scrollBot; i++) {
          this.screen.splice(this.cy, 1);
          this.screen.splice(this.scrollBot, 0, this.blankRow(this.cols));
        }
        break;
      }
      case 'P': { // delete chars
        const row = this.screen[this.cy];
        for (let i = 0; i < n; i++) { row.splice(this.cx, 1); row.push({ ch: ' ', a: null }); }
        break;
      }
      case '@': { // insert chars
        const row = this.screen[this.cy];
        for (let i = 0; i < n; i++) { row.splice(this.cx, 0, { ch: ' ', a: null }); row.pop(); }
        break;
      }
      case 'X': { // erase chars
        const row = this.screen[this.cy];
        for (let i = 0; i < n && this.cx + i < this.cols; i++) row[this.cx + i] = { ch: ' ', a: null };
        break;
      }
      case 'S': this.scrollUp(n); break;
      case 'T': this.scrollDown(n); break;
      case 'r':
        this.scrollTop = Math.max(0, (isNaN(args[0]) ? 1 : args[0] || 1) - 1);
        this.scrollBot = Math.min(this.rows - 1, (isNaN(args[1]) ? this.rows : args[1] || this.rows) - 1);
        this.cx = 0; this.cy = this.scrollTop;
        break;
      case 's': this.saveCursor(); break;
      case 'u': this.restoreCursor(); break;
      case 'm': this.sgr(body === '' ? [0] : body.split(';')); break;
      default: break;
    }
  }

  eraseDisplay(mode) {
    if (mode === 2 || mode === 3) {
      this.screen = this.blankScreen(this.rows, this.cols);
      return;
    }
    if (mode === 1) {
      for (let r = 0; r < this.cy; r++) this.screen[r] = this.blankRow(this.cols);
      for (let c = 0; c <= this.cx && c < this.cols; c++) this.screen[this.cy][c] = { ch: ' ', a: null };
      return;
    }
    for (let c = this.cx; c < this.cols; c++) this.screen[this.cy][c] = { ch: ' ', a: null };
    for (let r = this.cy + 1; r < this.rows; r++) this.screen[r] = this.blankRow(this.cols);
  }

  eraseLine(mode) {
    const row = this.screen[this.cy];
    if (mode === 1) { for (let c = 0; c <= this.cx && c < this.cols; c++) row[c] = { ch: ' ', a: null }; return; }
    if (mode === 2) { this.screen[this.cy] = this.blankRow(this.cols); return; }
    for (let c = this.cx; c < this.cols; c++) row[c] = { ch: ' ', a: null };
  }

  setAltScreen(on) {
    if (on && !this.altScreenActive) {
      this.altScreenActive = true;
      this.altSaved = { screen: this.screen, cx: this.cx, cy: this.cy };
      this.screen = this.blankScreen(this.rows, this.cols);
      this.cx = this.cy = 0;
    } else if (!on && this.altScreenActive) {
      this.altScreenActive = false;
      if (this.altSaved) {
        this.screen = this.altSaved.screen;
        this.cx = this.altSaved.cx;
        this.cy = Math.min(this.altSaved.cy, this.rows - 1);
        // the saved screen may be a different size after a resize
        if (this.screen.length !== this.rows) this.resize(this.cols, this.rows);
      }
    }
  }

  sgr(parts) {
    for (let i = 0; i < parts.length; i++) {
      const p = parseInt(parts[i], 10);
      if (isNaN(p) || p === 0) { this.attr = this.defaultAttr(); continue; }
      if (p === 1) this.attr.bold = true;
      else if (p === 2) this.attr.dim = true;
      else if (p === 3) this.attr.italic = true;
      else if (p === 4) this.attr.underline = true;
      else if (p === 7) this.attr.inverse = true;
      else if (p === 22) { this.attr.bold = false; this.attr.dim = false; }
      else if (p === 23) this.attr.italic = false;
      else if (p === 24) this.attr.underline = false;
      else if (p === 27) this.attr.inverse = false;
      else if (p >= 30 && p <= 37) this.attr.fg = ANSI_16[p - 30];
      else if (p >= 90 && p <= 97) this.attr.fg = ANSI_16[p - 90 + 8];
      else if (p >= 40 && p <= 47) this.attr.bg = ANSI_16[p - 40];
      else if (p >= 100 && p <= 107) this.attr.bg = ANSI_16[p - 100 + 8];
      else if (p === 39) this.attr.fg = null;
      else if (p === 49) this.attr.bg = null;
      else if (p === 38 || p === 48) {
        const target = p === 38 ? 'fg' : 'bg';
        const kind = parseInt(parts[i + 1], 10);
        if (kind === 5) { this.attr[target] = xterm256(parseInt(parts[i + 2], 10) || 0); i += 2; }
        else if (kind === 2) {
          const r = parseInt(parts[i + 2], 10) || 0, g = parseInt(parts[i + 3], 10) || 0, b = parseInt(parts[i + 4], 10) || 0;
          this.attr[target] = `rgb(${r},${g},${b})`;
          i += 4;
        }
      }
    }
  }

  /* ---------- rendering ---------- */
  markDirty() {
    this.dirty = true;
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => { this.frame = null; this.render(); });
  }

  render() {
    if (!this.dirty) return;
    this.dirty = false;

    let rows = this.screen;
    let showCursor = this.cursorVisible && document.activeElement === this.el;
    if (this.viewOffset > 0) {
      const hist = this.scrollback;
      const start = Math.max(0, hist.length - this.viewOffset);
      const histSlice = hist.slice(start, start + this.rows);
      rows = histSlice.concat(this.screen.slice(0, Math.max(0, this.rows - histSlice.length)));
      showCursor = false;
    }

    const esc = (s) => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    const styleOf = (a, cursor) => {
      if (!a && !cursor) return '';
      const at = a || {};
      let fg = at.fg || DEF_FG;
      let bg = at.bg || DEF_BG;
      if (at.inverse) { const t = fg; fg = at.bg || '#0b0f14'; bg = t; }
      if (cursor) { const t = fg; fg = '#0b0f14'; bg = t === DEF_FG ? '#7cc4ff' : t; }
      let s = `color:${fg};`;
      if (bg !== 'transparent') s += `background:${bg};`;
      if (at.bold) s += 'font-weight:700;';
      if (at.dim) s += 'opacity:.65;';
      if (at.italic) s += 'font-style:italic;';
      if (at.underline) s += 'text-decoration:underline;';
      return s;
    };

    const out = [];
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r];
      if (!row) { out.push(''); continue; }
      let line = '';
      let runStyle = null, runText = '';
      const flush = () => {
        if (!runText) return;
        line += runStyle ? `<span style="${runStyle}">${esc(runText)}</span>` : esc(runText);
        runText = '';
      };
      for (let c = 0; c < row.length; c++) {
        const cell = row[c];
        const isCursor = showCursor && r === this.cy && c === this.cx;
        const st = styleOf(cell.a, isCursor);
        if (st !== runStyle) { flush(); runStyle = st; }
        runText += cell.ch;
      }
      flush();
      out.push(line.replace(/\s+$/, m => m) || ' ');
    }
    this.el.innerHTML = out.map(l => `<div class="trow">${l || ' '}</div>`).join('');
  }

  /* ---------- input ---------- */
  bindScroll() {
    this.el.addEventListener('wheel', (e) => {
      if (this.altScreenActive) return; // let full-screen apps handle it
      e.preventDefault();
      const dir = e.deltaY > 0 ? -3 : 3;
      const max = this.scrollback.length;
      this.viewOffset = Math.max(0, Math.min(max, this.viewOffset + dir));
      this.markDirty();
    }, { passive: false });
  }

  bindInput() {
    this.el.addEventListener('focus', () => this.markDirty());
    this.el.addEventListener('blur', () => this.markDirty());

    this.el.addEventListener('keydown', (e) => {
      // let the user copy a selection
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c' && !window.getSelection().isCollapsed) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') return; // paste event handles it

      const k = e.key;
      let seq = null;

      if (k === 'Enter') seq = '\r';
      else if (k === 'Backspace') seq = '\x7f';
      else if (k === 'Tab') seq = '\t';
      else if (k === 'Escape') seq = '\x1b';
      else if (k === 'ArrowUp') seq = '\x1b[A';
      else if (k === 'ArrowDown') seq = '\x1b[B';
      else if (k === 'ArrowRight') seq = '\x1b[C';
      else if (k === 'ArrowLeft') seq = '\x1b[D';
      else if (k === 'Home') seq = '\x1b[H';
      else if (k === 'End') seq = '\x1b[F';
      else if (k === 'PageUp') seq = '\x1b[5~';
      else if (k === 'PageDown') seq = '\x1b[6~';
      else if (k === 'Insert') seq = '\x1b[2~';
      else if (k === 'Delete') seq = '\x1b[3~';
      else if (/^F\d{1,2}$/.test(k)) {
        const map = { F1: 'OP', F2: 'OQ', F3: 'OR', F4: 'OS', F5: '[15~', F6: '[17~', F7: '[18~', F8: '[19~', F9: '[20~', F10: '[21~', F11: '[23~', F12: '[24~' };
        if (map[k]) seq = '\x1b' + map[k];
      }
      else if (e.ctrlKey && k.length === 1) {
        const c = k.toLowerCase();
        if (c >= 'a' && c <= 'z') seq = String.fromCharCode(c.charCodeAt(0) - 96);
        else if (c === '[') seq = '\x1b';
        else if (c === '\\') seq = '\x1c';
        else if (c === ']') seq = '\x1d';
        else if (c === '_') seq = '\x1f';
        else if (c === ' ') seq = '\x00';
      }
      else if (e.altKey && k.length === 1) seq = '\x1b' + k;
      else if (k.length === 1 && !e.metaKey) seq = k;

      if (seq !== null) {
        e.preventDefault();
        this.viewOffset = 0;
        this.onData(seq);
      }
    });

    this.el.addEventListener('paste', (e) => {
      e.preventDefault();
      const text = (e.clipboardData || window.clipboardData).getData('text');
      if (text) this.onData(text.replace(/\r?\n/g, '\r'));
    });
  }
}

window.Term = Term;
