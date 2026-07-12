#!/usr/bin/env python3
"""
File Expo PTY bridge.

Node has no built-in pseudo-terminal, so this tiny helper provides one:
  - fd 0  : keystrokes from the browser  -> written to the PTY
  - fd 1  : PTY output                   -> streamed back to the browser
  - fd 3  : control channel, lines of "cols,rows\n" -> TIOCSWINSZ on the PTY

Interactive programs (vim, top, htop, sudo prompts, nano, less) work because
they see a real TTY, and output streams live instead of arriving all at once.
"""
import os
import sys
import pty
import select
import signal
import struct
import fcntl
import termios

shell = sys.argv[1] if len(sys.argv) > 1 else "/bin/bash"
cwd = sys.argv[2] if len(sys.argv) > 2 else "/"
cols = int(sys.argv[3]) if len(sys.argv) > 3 else 80
rows = int(sys.argv[4]) if len(sys.argv) > 4 else 24

pid, master = pty.fork()

if pid == 0:
    # child: become the shell inside the new controlling terminal
    try:
        os.chdir(cwd)
    except Exception:
        os.chdir("/")
    env = os.environ.copy()
    env["TERM"] = "xterm-256color"
    env["COLUMNS"] = str(cols)
    env["LINES"] = str(rows)
    env.setdefault("LANG", "C.UTF-8")
    # login-ish interactive shell so aliases / prompt / PATH are right
    try:
        os.execvpe(shell, [shell, "-i"], env)
    except Exception:
        os.execvpe("/bin/sh", ["/bin/sh", "-i"], env)
    os._exit(1)


def set_size(c, r):
    try:
        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", r, c, 0, 0))
        os.kill(pid, signal.SIGWINCH)
    except Exception:
        pass


set_size(cols, rows)

try:
    ctrl = os.fdopen(3, "rb", 0)
except Exception:
    ctrl = None

stdin_fd = sys.stdin.fileno()
out = sys.stdout.buffer
ctrl_buf = b""

while True:
    watch = [master, stdin_fd] + ([ctrl.fileno()] if ctrl else [])
    try:
        ready, _, _ = select.select(watch, [], [], 30)
    except (OSError, select.error):
        break

    if master in ready:
        try:
            data = os.read(master, 65536)
        except OSError:
            data = b""
        if not data:
            break  # shell exited
        out.write(data)
        out.flush()

    if stdin_fd in ready:
        try:
            data = os.read(stdin_fd, 65536)
        except OSError:
            data = b""
        if not data:
            break  # browser disconnected
        try:
            os.write(master, data)
        except OSError:
            break

    if ctrl and ctrl.fileno() in ready:
        try:
            chunk = os.read(ctrl.fileno(), 4096)
        except OSError:
            chunk = b""
        if chunk:
            ctrl_buf += chunk
            while b"\n" in ctrl_buf:
                line, ctrl_buf = ctrl_buf.split(b"\n", 1)
                try:
                    c, r = line.decode().strip().split(",")
                    set_size(int(c), int(r))
                except Exception:
                    pass

try:
    os.close(master)
except Exception:
    pass
try:
    os.kill(pid, signal.SIGHUP)
except Exception:
    pass
