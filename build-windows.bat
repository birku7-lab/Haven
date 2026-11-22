@echo off
setlocal enabledelayedexpansion
title Haven Windows Builder

echo ========================================================
echo   Haven Personal Storage Hub - Windows .exe Builder
echo ========================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js is not installed or not in PATH.
    echo Install Node.js 20 LTS or newer from https://nodejs.org/
    exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
    echo [ERROR] npm is not available in PATH.
    exit /b 1
)

where cargo >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Rust/Cargo is not installed or not in PATH.
    echo Install Rustup from https://rustup.rs/ and restart your terminal.
    exit /b 1
)

echo [1/4] Installing npm dependencies...
call npm install
if errorlevel 1 (
    echo [ERROR] npm install failed.
    exit /b 1
)

echo.
echo [2/4] Building React + TypeScript frontend (dist/)...
call npm run build
if errorlevel 1 (
    echo [ERROR] Frontend build failed.
    exit /b 1
)

echo.
echo [3/4] Compiling Tauri Rust backend + NSIS Windows installer...
call npx tauri build
if errorlevel 1 (
    echo [ERROR] Tauri Windows build failed.
    echo Make sure Microsoft Visual Studio C++ Build Tools (Desktop development with C++^) and WebView2 Runtime are installed.
    exit /b 1
)

echo.
echo [4/4] Copying release executables to .\release\ ...
if not exist "release" mkdir "release"
if exist "src-tauri\target\release\haven.exe" (
    copy /Y "src-tauri\target\release\haven.exe" "release\haven-windows-x64-portable.exe" >nul
)
if exist "src-tauri\target\release\bundle\nsis\Haven_0.1.0_x64-setup.exe" (
    copy /Y "src-tauri\target\release\bundle\nsis\Haven_0.1.0_x64-setup.exe" "release\Haven_0.1.0_x64-setup.exe" >nul
)

echo.
echo ========================================================
echo   BUILD SUCCEEDED!
echo   Installer : release\Haven_0.1.0_x64-setup.exe
echo   Portable  : release\haven-windows-x64-portable.exe
echo ========================================================
pause
