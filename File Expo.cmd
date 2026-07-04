@echo off
rem Double-click launcher for File Expo
set ELECTRON_RUN_AS_NODE=
cd /d "%~dp0"
start "" ".\node_modules\electron\dist\electron.exe" .
