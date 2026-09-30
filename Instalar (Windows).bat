@echo off
chcp 65001 >nul
title Estudio - Instalar
cd /d "%~dp0"
echo.
echo  Instalando Estudio...
echo.
where node >nul 2>nul
if errorlevel 1 (
  echo  No se encuentra Node.js. Se abrirá su página de descarga:
  echo  instala la versión LTS y vuelve a hacer doble clic en este archivo.
  start "" https://nodejs.org/es/download
  echo.
  pause
  exit /b 1
)
call npm install
if errorlevel 1 (
  echo.
  echo  Algo falló durante la instalación. Revisa el mensaje de arriba.
  pause
  exit /b 1
)
echo.
echo  Listo. Para grabar, haz doble clic en:
echo    "Estudio por internet (Windows).bat"  si la otra persona está en otro lugar
echo    "Estudio misma wifi (Windows).bat"    si estáis en la misma red
echo.
pause
