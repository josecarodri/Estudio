@echo off
chcp 65001 >nul
title Estudio - Elegir tipo de enlace
cd /d "%~dp0"
echo.
echo  ¿Qué enlace quieres darle a la otra persona?
echo.
echo    1 = Fijo, siempre el mismo (Tailscale Funnel; requiere tener Tailscale instalado)
echo    2 = Uno nuevo cada vez (Cloudflare; no requiere nada)
echo.
choice /c 12 /n /m "  Pulsa 1 o 2: "
if errorlevel 2 goto cloudflare

set "MODO=tailscale"
where tailscale >nul 2>nul && goto guardar
if exist "%ProgramFiles%\Tailscale\tailscale.exe" goto guardar
echo.
echo  Tailscale no está instalado. Se abre su página de descarga:
echo  instálalo, inicia sesión y vuelve a hacer doble clic en este archivo.
start "" https://tailscale.com/download/windows
pause
exit /b 1

:cloudflare
set "MODO=cloudflare"

:guardar
if exist .env (findstr /v /b "PUBLICO=" .env > .env.tmp) else (type nul > .env.tmp)
>>.env.tmp echo PUBLICO=%MODO%
move /y .env.tmp .env >nul
echo.
if "%MODO%"=="tailscale" goto msg_tailscale
echo  Listo: el estudio usará Cloudflare y el enlace cambiará cada vez.
goto fin
:msg_tailscale
echo  Listo: el estudio usará Tailscale y el enlace será siempre el mismo.
echo  La primera vez que lo abras, Tailscale pedirá en el navegador activar «Funnel»: acéptalo.
:fin
echo  Abre el estudio con el icono «Estudio» del escritorio.
echo.
pause
