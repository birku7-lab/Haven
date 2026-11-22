# Haven Stage 1 — Verification & Test Results

## Automated Verification (Executed in Linux Workspace)

### 1. TypeScript Static Type Check (`npm run lint`)
- **Command**: `tsc --noEmit`
- **Result**: **PASS** (0 errors)

### 2. Frontend Production Bundle (`npm run build`)
- **Command**: `vite build`
- **Result**: **PASS** (`1676` modules transformed; `dist/index.html`, `dist/assets/*.css`, `dist/assets/*.js` emitted)

### 3. Backend & Storage Integration Suite (`npm test`)
- **Command**: `vitest run --pool=forks` (`tests/haven.test.ts`)
- **Result**: **PASS — 9 / 9 tests passed**
- **Verified Coverage**:
  - Passcode setup, authentication, and invalid passcode rejection (`401`)
  - Storage directory initialization (`Files/`, `Photos/`, `Videos/`, `Documents/`, `Audio/`, `Archives/`, `Other/`, `Thumbnails/`, `Database/`, `Backups/`, `Temp/`, `RecycleBin/`)
  - Path traversal rejection across file and folder endpoints
  - Folder CRUD + file rename, move, copy, collision handling (`report (1).pdf`), favorite & tag updates
  - Resumable chunked upload (`PUT /api/v1/transfers/:id/chunks/:index`), chunk SHA-256 mismatch rejection, final assembly & SHA-256 verification
  - HTTP `Range` (`206 Partial Content`) byte-range media streaming
  - Background storage scanner detection of externally dropped files + duplicate SHA-256 detection
  - Soft delete to `RecycleBin/`, restore to original folder, and permanent purge
  - SQLite online backup + `PRAGMA integrity_check` + restore
  - Independent LAN server startup/shutdown, QR pairing session exchange, Bearer device token authentication, and permission enforcement

### 4. Dev Server & Reverse-Proxy Header Check
- **Command**: `curl -sS -i http://127.0.0.1:3000/api/v1/health`
- **Result**: **PASS — `HTTP/1.1 200 OK`** (`{"status":"ok","service":"haven-desktop-core",...}`)
- **Rate-Limiter Proxy Verification**: Express `trust proxy` (`1`) and `express-rate-limit` validation configuration verified for `X-Forwarded-For` and `Forwarded` headers without `ValidationError`.

---

## Native Windows Build Notes (`src-tauri/`)

- **Included Ready-to-Build Sources**:
  - `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, `src-tauri/build.rs`, `src-tauri/tauri.conf.json`, `src-tauri/capabilities/default.json`
  - `src-tauri/src/{main,lib,db,storage,transfers,lan_server}.rs`
  - `src-tauri/icons/{32x32.png,128x128.png,128x128@2x.png,icon.ico,icon.png}`
  - One-click Windows build helpers: `build-windows.bat` and `build-windows.ps1`
- **Why `.exe` was not cross-compiled inside this cloud container**:
  - The cloud container has a hard `4.0 GiB` RAM ceiling with `0 B` swap; compiling the transitive Windows WinRT/COM dependency crate (`windows v0.62.2` pulled by `webview2-com` in Tauri v2) exceeds the `4.0 GiB` container limit alongside the active Node/Vite dev server.
- **Windows Host Verification Checklist (Run after building on Windows 10/11)**:
  1. Run `build-windows.bat` (or `.\build-windows.ps1`) on Windows 10/11 with Node.js 20+, Rust (`rustup`), and Visual Studio C++ Build Tools installed.
  2. Confirm `release\Haven_0.1.0_x64-setup.exe` and `release\haven-windows-x64-portable.exe` are generated.
  3. Launch `Haven.exe` -> verify native Windows drive detection (`C:\`, `D:\`), `D:\HavenStorage` creation, native folder picker, system tray (`Open Haven`, `Quit Haven Completely`), close-to-tray behavior, and LAN QR pairing.
