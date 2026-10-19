@echo off
title AI_SCOPE
cd /d "%~dp0"
rem Dev launcher: auto-restarts on file changes. Open to the network so phones on the Wi-Fi can reach it.
set AI_SCOPE_HOST=0.0.0.0
npm start
