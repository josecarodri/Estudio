@echo off
chcp 65001 >nul
title Estudio - Configurar servidor TURN
cd /d "%~dp0"
if not exist node_modules\ws\ (
  echo  Instalando lo necesario la primera vez...
  call npm install
)
echo.
echo  Configurar Cloudflare TURN
echo  -------------------------
echo  Pega los dos valores que te dio Cloudflare. Para pegar: clic derecho en esta ventana.
echo.
set "ID="
set "TOKEN="
set /p "ID=Turn Token ID: "
set /p "TOKEN=API Token: "
if "%ID%"=="" goto falta
if "%TOKEN%"=="" goto falta
if exist .env (findstr /v /b "CLOUDFLARE_TURN_KEY_ID= CLOUDFLARE_TURN_API_TOKEN=" .env > .env.tmp) else (type nul > .env.tmp)
>>.env.tmp echo CLOUDFLARE_TURN_KEY_ID=%ID%
>>.env.tmp echo CLOUDFLARE_TURN_API_TOKEN=%TOKEN%
move /y .env.tmp .env >nul
echo.
echo  Guardado en el archivo .env. Comprobando con Cloudflare...
echo.
node tools\probar-turn.js
echo.
echo  Si pone OK (✓), cierra el estudio si estaba abierto y vuelve a abrirlo.
pause
exit /b 0
:falta
echo.
echo  Faltan datos: no se ha cambiado nada.
pause
exit /b 1
