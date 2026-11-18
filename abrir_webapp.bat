@echo off
setlocal EnableExtensions
chcp 65001 >nul
cd /d "%~dp0"

if "%PORT%"=="" set PORT=3000
if "%OSC_HOST%"=="" set OSC_HOST=127.0.0.1
if "%OSC_PORT%"=="" set OSC_PORT=9000

echo ============================================================
echo   HAND-OSC - Lanzador WebApp + Puente OSC UDP (Windows)
echo ============================================================
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] No se encontro Node.js. Ejecuta primero "instalar.bat"
  echo o instala Node.js desde https://nodejs.org/
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo [AVISO] No se encontraron dependencias instaladas. Ejecutando instalacion inicial...
  call npm install
  if errorlevel 1 (
    echo [ERROR] No se pudieron instalar las dependencias.
    pause
    exit /b 1
  )
)

if not exist "public\models\hand_landmarker.task" (
  echo [AVISO] Descargando modelo y WASM de MediaPipe...
  call npm run setup:assets
  if errorlevel 1 (
    echo [ERROR] No se pudieron preparar los archivos de MediaPipe.
    pause
    exit /b 1
  )
)

if not exist "dist\index.html" (
  echo [AVISO] Compilando aplicacion web por primera vez...
  call npm run build
  if errorlevel 1 (
    echo [ERROR] Fallo la compilacion de la webapp.
    pause
    exit /b 1
  )
)

powershell -NoProfile -Command "try { $r = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:%PORT%/api/health' -TimeoutSec 1; if ($r.StatusCode -eq 200) { exit 0 } else { exit 1 } } catch { exit 1 }" >nul 2>&1
if not errorlevel 1 (
  echo El servidor HAND-OSC ya esta en ejecucion en http://localhost:%PORT%
  echo Abriendo navegador...
  start "" "http://localhost:%PORT%"
  timeout /t 2 /nobreak >nul
  exit /b 0
)

echo Iniciando servidor en: http://localhost:%PORT%
echo Puente OSC UDP por defecto: %OSC_HOST%:%OSC_PORT%
echo.
echo Presiona Ctrl+C o cierra esta ventana para detener el servidor.
echo.

start "" /b cmd /c "timeout /t 2 /nobreak >nul & start "" http://localhost:%PORT%"
node server/index.mjs

if errorlevel 1 (
  echo.
  echo [ERROR] El servidor se detuvo con errores.
  pause
  exit /b 1
)

exit /b 0
