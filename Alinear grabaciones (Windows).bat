@echo off
chcp 65001 >nul
title Estudio - Alinear grabaciones
cd /d "%~dp0"
where ffmpeg >nul 2>nul
if errorlevel 1 (
  echo  Falta ffmpeg. Instálalo abriendo PowerShell y escribiendo:
  echo    winget install Gyan.FFmpeg
  echo  Después cierra esta ventana y vuelve a hacer doble clic aquí.
  echo.
  pause
  exit /b 1
)
node tools\alinear.js
echo.
echo  Los archivos alineados están en la carpeta "alineados" de cada sesión dentro de "grabaciones".
start "" "%~dp0grabaciones"
pause
