#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if [ -d "$HOME/.nvm/versions/node" ]; then
  NVM_LATEST="$(ls -1 "$HOME/.nvm/versions/node" | tail -n 1 || true)"
  if [ -n "${NVM_LATEST:-}" ]; then
    export PATH="$HOME/.nvm/versions/node/$NVM_LATEST/bin:$PATH"
  fi
fi

PORT="${PORT:-3000}"
OSC_HOST="${OSC_HOST:-127.0.0.1}"
OSC_PORT="${OSC_PORT:-9000}"
export PORT OSC_HOST OSC_PORT

echo "============================================================"
echo "  HAND-OSC - Lanzador WebApp + Puente OSC UDP (macOS)"
echo "============================================================"
echo

if ! command -v node >/dev/null 2>&1; then
  echo "[ERROR] No se encontro Node.js. Ejecuta primero \"instalar_mac.command\""
  echo "o instala Node.js desde https://nodejs.org/"
  read -r -p "Presiona Enter para cerrar..."
  exit 1
fi

if [ ! -d "node_modules" ]; then
  echo "[AVISO] Instalando dependencias iniciales..."
  npm install
fi

if [ ! -f "public/models/hand_landmarker.task" ]; then
  echo "[AVISO] Preparando WASM y modelo MediaPipe..."
  npm run setup:assets
fi

if [ ! -f "dist/index.html" ]; then
  echo "[AVISO] Compilando aplicacion web por primera vez..."
  npm run build
fi

if command -v curl >/dev/null 2>&1 && curl -sf "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
  echo "El servidor HAND-OSC ya esta en ejecucion en http://localhost:${PORT}"
  echo "Abriendo navegador..."
  open "http://localhost:${PORT}"
  exit 0
fi

echo "Iniciando servidor en: http://localhost:${PORT}"
echo "Puente OSC UDP por defecto: ${OSC_HOST}:${OSC_PORT}"
echo
echo "Presiona Ctrl+C o cierra esta ventana para detener el servidor."
echo

(sleep 2 && open "http://localhost:${PORT}") &
node server/index.mjs
