@echo off
chcp 65001 >nul
title Estudio (misma wifi) - no cierres esta ventana mientras grabáis
cd /d "%~dp0"
if not exist node_modules\ws\ call npm install
node server.js --abrir
echo.
pause
