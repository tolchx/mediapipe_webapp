@echo off
setlocal EnableExtensions
chcp 65001 >nul
cd /d "%~dp0"

echo ============================================================
echo   HAND-OSC - Instalador de dependencias (Windows)
echo ============================================================
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] No se encontro Node.js en el sistema.
  echo Descarga e instala Node.js LTS ^(v20 o superior^) desde:
  echo   https://nodejs.org/
  echo.
  pause
  exit /b 1
)

where npm >nul 2>&1
if errorlevel 1 (
  echo [ERROR] No se encontro npm en el sistema.
  echo Reinstala Node.js desde https://nodejs.org/
  echo.
  pause
  exit /b 1
)

for /f "delims=" %%v in ('node -v') do set NODE_VER=%%v
for /f "delims=" %%v in ('npm -v') do set NPM_VER=%%v
echo Node.js detectado: %NODE_VER%
echo npm detectado:     %NPM_VER%
echo.

echo [1/3] Instalando dependencias npm...
call npm install
if errorlevel 1 (
  echo.
  echo [ERROR] Fallo "npm install". Revisa tu conexion o permisos.
  pause
  exit /b 1
)

echo.
echo [2/3] Preparando WASM y modelo MediaPipe HandLandmarker...
call npm run setup:assets
if errorlevel 1 (
  echo.
  echo [ERROR] Fallo la preparacion de activos de MediaPipe.
  pause
  exit /b 1
)

echo.
echo [3/3] Compilando aplicacion web para produccion...
call npm run build
if errorlevel 1 (
  echo.
  echo [ERROR] Fallo la compilacion de la aplicacion.
  pause
  exit /b 1
)

echo.
echo ============================================================
echo   Instalacion completada correctamente.
echo   Ahora ejecuta "abrir_webapp.bat" para iniciar la webapp.
echo ============================================================
echo.
pause
exit /b 0
