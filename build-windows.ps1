$ErrorActionPreference = "Stop"

Write-Host "========================================================" -ForegroundColor Cyan
Write-Host "  Haven Personal Storage Hub - Windows .exe Builder" -ForegroundColor Cyan
Write-Host "========================================================" -ForegroundColor Cyan

foreach ($cmd in @("node", "npm", "cargo", "rustc")) {
    if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
        Write-Error "$cmd is not installed or not in PATH. Install Node.js 20+ (nodejs.org), Rust (rustup.rs), and VS C++ Build Tools."
    }
}

Write-Host "`n[1/4] Installing npm dependencies..." -ForegroundColor Yellow
npm install

Write-Host "`n[2/4] Building frontend bundle..." -ForegroundColor Yellow
npm run build

Write-Host "`n[3/4] Building Windows executable & NSIS installer..." -ForegroundColor Yellow
npx tauri build

Write-Host "`n[4/4] Collecting binaries into .\release\ ..." -ForegroundColor Yellow
New-Item -ItemType Directory -Force -Path "release" | Out-Null

$portable = "src-tauri\target\release\haven.exe"
$installer = "src-tauri\target\release\bundle\nsis\Haven_0.1.0_x64-setup.exe"

if (Test-Path $portable) {
    Copy-Item $portable "release\haven-windows-x64-portable.exe" -Force
}
if (Test-Path $installer) {
    Copy-Item $installer "release\Haven_0.1.0_x64-setup.exe" -Force
}

Write-Host "`nBUILD SUCCEEDED!" -ForegroundColor Green
if (Test-Path "release\Haven_0.1.0_x64-setup.exe") {
    Write-Host "  Installer : $((Resolve-Path 'release\Haven_0.1.0_x64-setup.exe').Path)"
}
if (Test-Path "release\haven-windows-x64-portable.exe") {
    Write-Host "  Portable  : $((Resolve-Path 'release\haven-windows-x64-portable.exe').Path)"
}
