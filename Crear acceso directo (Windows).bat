@echo off
chcp 65001 >nul
title Estudio - Crear acceso directo
cd /d "%~dp0"
echo.
echo  Creando el icono «Estudio» en el escritorio y en el menú Inicio...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\crear-acceso-directo.ps1"
if errorlevel 1 (
  echo.
  echo  No se pudo crear. Alternativa: clic derecho en «Estudio por internet ^(Windows^).bat»
  echo  → Mostrar más opciones → Enviar a → Escritorio ^(crear acceso directo^).
  pause
  exit /b 1
)
echo.
echo  Listo. A partir de ahora abre el estudio con el icono «Estudio» del escritorio.
echo  Si lo mueves de carpeta, vuelve a ejecutar este archivo.
echo.
pause
