# 🗄️ File Expo

A desktop GUI file manager for your VPS. Connect over SSH, let it set up the server
with an OS-style installer, then manage files like on your own machine.

## Run it

```bash
npm install
npm start
```

## What it does

1. **Connect** — enter host / user / password (or SSH key). Save servers for one-click reconnect (passwords are encrypted with Windows credential storage).
2. **Setup (first connect only)** — an OS-installation-style screen with a progress bar, step checklist and live terminal log. It detects your distro, refreshes the package index and installs `rsync zip unzip tar file curl` on the server. Runs once per server; skipped afterwards.
3. **File manager** — full GUI:
   - Browse with back/forward/up, clickable breadcrumb (click it to type a path), places sidebar, per-server bookmarks
   - Upload files/folders (buttons or **drag & drop from Windows Explorer**), download files/folders — both recursive, with a live transfer panel and progress bars
   - Built-in **text editor** (double-click a file, Ctrl+S to save)
   - New folder / new file, rename (F2), delete (Del), copy/cut/paste (Ctrl+C/X/V — server-side `cp`/`mv`)
   - **Permissions** editor (rwx checkboxes + octal, recursive option), properties dialog (owner, group, `du` size, `file` type)
   - Compress selection to `.zip` / `.tar.gz`, extract archives in place
   - Filter-as-you-type; press **Enter** in the filter box for a deep `find` search under the current folder
   - Built-in **console** panel to run quick commands in the current directory
   - Hidden-files toggle, sortable columns, multi-select (Ctrl / Shift), keyboard navigation

## Distro support

| Distro | Package manager | Status |
|---|---|---|
| Ubuntu / Debian / Mint / Kali | apt | ✅ fully supported |
| Arch / Manjaro / EndeavourOS | pacman | ✅ wired in |
| Fedora / RHEL / Rocky / Alma | dnf | ✅ wired in |
| Alpine | apk | ✅ wired in |
| openSUSE | zypper | ✅ wired in |

If the user isn't root and has no passwordless sudo, package installation is skipped
gracefully — file management still works over SFTP; only archive tools may be missing.
