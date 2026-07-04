# 🗄️ File Expo

A full GUI file manager for your VPS. One command installs it on your server —
with an OS-style installer — then you manage files from your browser, protected
by your own password.

## 🚀 Install on your server (one line)

SSH into your VPS (any folder), paste this, press Enter:

```bash
curl -fsSL https://raw.githubusercontent.com/zamansheikh/file-expo/main/install.sh | sudo bash
```

The installer shows a step-by-step loader (like an OS installation): it detects
your distro, installs Node.js and tools, downloads File Expo, creates a system
service, opens the firewall port and then prints a link:

```
➜  http://YOUR-SERVER-IP:7777/?token=xxxxxxxxxxxxxxxx
```

**Click that link.** Your browser opens the File Expo setup GUI:

1. It shows your server info and asks you to **create an admin password**
2. A visual installer finishes the setup with a progress bar and live log
3. You land straight in the file manager

From then on, just open `http://YOUR-SERVER-IP:7777` and sign in with your password.

### Custom port

```bash
curl -fsSL https://raw.githubusercontent.com/zamansheikh/file-expo/main/install.sh | sudo FILE_EXPO_PORT=8080 bash
```

### Update

Re-run the install command — your password and settings are kept.

### Uninstall

```bash
curl -fsSL https://raw.githubusercontent.com/zamansheikh/file-expo/main/install.sh | sudo bash -s -- --uninstall
```

## 🆕 What's new in v1.1

- **🧩 Views** — installable preview add-ons: image viewer, video player (with seeking), audio player, PDF viewer, Markdown preview, CSV table, JSON formatter, hex viewer. Open **🧩 Views** in the topbar and install the ones you want.
- **⬆ One-click updates** — when a new version is pushed to GitHub, an **Update** button appears in the explorer. Click it: the server downloads the new version and restarts itself. Settings, password and domains are kept.
- **🧰 Server Tools** (topbar) — built for backend / DevOps / frontend work:
  - **📊 Overview** — live CPU load, RAM, disk usage, uptime
  - **🧩 Services** — start / stop / restart systemd services, view their logs
  - **⚡ Processes** — top processes by CPU, kill button
  - **🔌 Ports** — all listening ports at a glance
  - **⏰ Cron** — edit the crontab right in the browser
  - **🌐 Domains** — attach a domain to your server: auto-installs nginx, writes a reverse-proxy (for your Node/Django/... app on a port) or static-site config, tests and reloads nginx — then **one-click HTTPS** via Let's Encrypt (auto-install certbot, auto-renew).

## ✨ Features (web GUI)

- Browse with back/forward/up, clickable breadcrumb (click it to type a path), places sidebar, bookmarks
- **Upload** files and whole folders — buttons or **drag & drop** (folders too), with live progress bars
- **Download** files, or folders as `.tar.gz`
- Built-in **text editor** — double-click a file, Ctrl+S saves
- New folder / new file, rename (F2), delete (Del), copy/cut/paste (Ctrl+C/X/V)
- **Permissions** editor (rwx checkboxes + octal + recursive), properties dialog (owner, size, type)
- Compress to `.zip` / `.tar.gz`, extract archives in place
- Filter-as-you-type, deep `find` search (press Enter in the filter box)
- Built-in **console** panel for quick commands in the current folder
- Hidden-files toggle, sortable columns, multi-select, keyboard shortcuts
- Login protected (scrypt-hashed password, rate-limited, HttpOnly sessions)

## 🐧 Distro support

| Distro | Package manager | Status |
|---|---|---|
| Ubuntu / Debian / Mint / Kali | apt | ✅ fully supported |
| Arch / Manjaro / EndeavourOS | pacman | ✅ supported |
| Fedora / RHEL / Rocky / Alma | dnf | ✅ supported |
| Alpine | apk | ✅ supported |
| openSUSE | zypper | ✅ supported |

## 🔒 Security notes

- Everything is protected behind your admin password; set a strong one.
- The setup link contains a one-time token; it stops working after setup.
- Traffic is plain HTTP by default. For internet-facing servers, put it behind
  a reverse proxy with HTTPS (Caddy/Nginx + Let's Encrypt), or restrict the
  port to your IP in your firewall.

## 🖥️ Bonus: desktop app

The repo also contains a Windows/macOS/Linux **Electron desktop app** that
connects to servers over SSH/SFTP (no server install needed):

```bash
npm install
npm start
```

## Project layout

```
install.sh          one-line server installer (curl | sudo bash)
server/             self-hosted web app (zero npm dependencies, Node 16+)
  server.js         HTTP server + REST API + auth
  public/           browser GUI
main.js, renderer/  Electron desktop app (bonus)
```
