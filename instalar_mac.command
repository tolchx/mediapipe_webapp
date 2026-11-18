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

echo "============================================================"
echo "  HAND-OSC - Instalador de dependencias (macOS)"
echo "============================================================"
echo

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "[ERROR] No se encontro Node.js / npm."
  echo "Instala Node.js LTS desde https://nodejs.org/ o con Homebrew:"
  echo "  brew install node"
  echo
  read -r -p "Presiona Enter para cerrar..."
  exit 1
fi

echo "Node.js detectado: $(node -v)"
echo "npm detectado:     $(npm -v)"
echo

echo "[1/3] Instalando dependencias npm..."
npm install

echo
echo "[2/3] Preparando WASM y modelo MediaPipe HandLandmarker..."
npm run setup:assets

echo
echo "[3/3] Compilando aplicacion web para produccion..."
npm run build

chmod +x abrir_webapp_mac.command instalar_mac.command 2>/dev/null || true

echo
echo "============================================================"
echo "  Instalacion completada correctamente."
echo "  Ahora ejecuta \"abrir_webapp_mac.command\" para iniciar."
echo "============================================================"
echo
read -r -p "Presiona Enter para cerrar..."
