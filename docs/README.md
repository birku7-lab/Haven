# Haven — Personal Storage Hub (Stage 1: Windows Desktop Application)

Haven turns a Windows PC's hard drive (e.g. `D:\HavenStorage`) into a private, self-hosted storage server and desktop console, architected for Stage 2 Android connectivity.

---

## Architecture

1. **Windows Native Desktop Shell (`src-tauri/`)**:
   - Built with **Tauri v2** (WebView2 + Rust).
   - Embedded **Axum** local IPC API (`127.0.0.1:<ephemeral>`) + independent configurable **LAN Storage Server** (`0.0.0.0:48720` default).
   - Native Windows **System Tray** (`Open Haven`, `Quit Haven Completely`), close-to-tray / minimize-to-tray behavior, native folder picker (`tauri-plugin-dialog`), OS default-app opener (`tauri-plugin-opener`), and Windows Startup integration (`tauri-plugin-autostart`).
   - Bundled **SQLite** (`rusqlite` with `WAL` mode, foreign keys, and online `Backup` API).
2. **React + TypeScript + Tailwind CSS UI (`src/`)**:
   - Matte charcoal dark theme (plus full light theme), 9 navigation sections (`Dashboard`, `Files`, `Photos & Videos`, `Transfers`, `Storage Analytics`, `Devices`, `Sync`, `Recycle Bin`, `Settings`).
   - Automatically detects `window.__TAURI_INTERNALS__` and binds to the native Rust local IPC backend; also works against the Node/Express development backend (`server.ts`) on port `3000`.
3. **Node.js / Express Reference & Preview Backend (`server/`)**:
   - Shares the exact SQLite schema, directory layout, chunked streaming protocol, and REST API contract used by automated integration tests and the live web preview.

---

## Storage Directory Structure

When configured (for example at `D:\HavenStorage`), Haven creates:

```text
HavenStorage/
├── Files/          # General user folders and files
├── Photos/         # Photo library root
├── Videos/         # Video library root
├── Documents/      # Documents root
├── Audio/          # Audio library root
├── Archives/       # Compressed archives
├── Other/          # Uncategorized files
├── Thumbnails/     # Generated .webp thumbnails (<fileId>.webp)
├── Database/       # haven.db (+ WAL/SHM journal)
├── Backups/        # Timestamped SQLite database backups
├── Temp/           # Resumable upload part files (<transferId>.part)
└── RecycleBin/     # Soft-deleted items awaiting restore or purge
```

---

## Database & Configuration

- **Bootstrap pointer (`bootstrap.json`)**:
  - Windows Desktop (`Haven.exe`): `%LOCALAPPDATA%\Haven\bootstrap.json`
  - Node/Preview server: `$HAVEN_CONFIG_DIR/bootstrap.json` or `~/.haven-storage/bootstrap.json`
  - Stores `storageRoot`, `adminPasscodeHash`, and `adminPasscodeSalt`.
- **SQLite (`Database/haven.db`)**:
  - Enabled pragmas: `journal_mode = WAL`, `foreign_keys = ON`, `synchronous = NORMAL`.
  - Tables: `config`, `folders`, `files`, `transfers`, `devices`, `pairing_sessions`, `sync_rules`, `sync_history`, `activity_logs`, `storage_history`.
  - Online backups use SQLite's native Backup API (`rusqlite::backup::Backup` / `better-sqlite3` `.backup()`) and restore performs a `PRAGMA integrity_check` + safety pre-restore snapshot.

---

## Dependencies

### Frontend & Node Backend (`package.json`)
- React 19, Vite 8, TypeScript, Tailwind CSS v4, `lucide-react`
- `@tauri-apps/api`, `@tauri-apps/cli`
- `express`, `express-rate-limit`, `better-sqlite3`, `sharp`, `qrcode`, `dotenv`, `vitest`

### Windows Desktop Rust Core (`src-tauri/Cargo.toml`)
- `tauri` (v2, `tray-icon`), `tauri-plugin-opener`, `tauri-plugin-dialog`, `tauri-plugin-autostart`
- `axum`, `tokio`, `tokio-util`, `tower-http`
- `rusqlite` (`bundled`, `backup`), `windows-sys` (`Win32_Storage_FileSystem`), `sha2`, `hex`, `base64`, `uuid`, `chrono`, `image`, `qrcode`, `rand`, `mime_guess`, `dirs`

---

## Build Instructions (Windows `.exe` & NSIS Installer)

### On Windows 10/11
1. Install Node.js 20+, Rust (`rustup`), and Microsoft Visual Studio C++ Build Tools (Desktop development with C++).
2. Either double-click `build-windows.bat` (or run `.\build-windows.ps1` in PowerShell), **or** run manually:
   ```bash
   npm install
   npm run build
   npx tauri build
   ```
   Outputs (also copied to `release\` by `build-windows.bat` / `build-windows.ps1`):
   - `src-tauri/target/release/haven.exe` (portable binary)
   - `src-tauri/target/release/bundle/nsis/Haven_0.1.0_x64-setup.exe` (Windows NSIS installer)

### Cross-Compiling Windows `.exe` from Linux
1. Install `mingw-w64` (`gcc-mingw-w64-x86-64-posix`, `binutils-mingw-w64-x86-64`), `nsis`, and `rustup` with the `x86_64-pc-windows-gnu` target:
   ```bash
   rustup target add x86_64-pc-windows-gnu
   ```
2. Build:
   ```bash
   npm run build
   CC_x86_64_pc_windows_gnu=x86_64-w64-mingw32-gcc npx tauri build --target x86_64-pc-windows-gnu
   ```
   Outputs:
   - `src-tauri/target/x86_64-pc-windows-gnu/release/haven.exe` (portable binary)
   - `src-tauri/target/x86_64-pc-windows-gnu/release/bundle/nsis/Haven_0.1.0_x64-setup.exe` (Windows NSIS installer)
