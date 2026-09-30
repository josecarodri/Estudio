@echo off
chcp 65001 >nul
title Estudio (por internet) - no cierres esta ventana mientras grabáis
cd /d "%~dp0"
if not exist node_modules\ws\ call npm install
node server.js --internet --abrir
echo.
pause
