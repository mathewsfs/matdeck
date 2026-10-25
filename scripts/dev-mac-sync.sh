#!/bin/bash
# Sincroniza o repositório com um Mac (ou a VM de macOS) para desenvolvimento e testes da camada macOS.
# Instala o Node LTS em ~/node no destino se faltar (tarball oficial, sem sudo), faz rsync para ~/matdeck
# e instala as dependências do servidor lá. Uso: ./scripts/dev-mac-sync.sh [host-ssh]   (padrão: mac)
set -e
HOST="${1:-mac}"
BASE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_MAJOR="${NODE_MAJOR:-22}"

ssh "$HOST" "bash -s" <<EOF
set -e
if [ ! -x "\$HOME/node/bin/node" ]; then
    arch=\$(uname -m); [ "\$arch" = "arm64" ] && na=darwin-arm64 || na=darwin-x64
    file=\$(curl -fsSL "https://nodejs.org/dist/latest-v${NODE_MAJOR}.x/SHASUMS256.txt" | grep -o "node-v[0-9.]*-\$na.tar.gz" | head -1)
    echo "[mac-sync] Instalando \$file em ~/node (sem sudo)"
    curl -fsSL "https://nodejs.org/dist/latest-v${NODE_MAJOR}.x/\$file" -o "/tmp/\$file"
    rm -rf "\$HOME/node" && mkdir -p "\$HOME/node" && tar -xzf "/tmp/\$file" -C "\$HOME/node" --strip-components=1 && rm -f "/tmp/\$file"
fi
mkdir -p "\$HOME/matdeck"
EOF

rsync -az --delete \
    --exclude node_modules --exclude .git --exclude build --exclude dist --exclude .superpowers \
    --exclude 'server/data/*.json' --exclude 'server/data/media' --exclude 'macos/MatDeckHelper/.build' \
    "$BASE_DIR/" "$HOST:matdeck/"

ssh "$HOST" "bash -s" <<'EOF'
set -e
export PATH="$HOME/node/bin:$PATH"
cd "$HOME/matdeck/server" && npm ci --omit=dev --no-audit --no-fund >/dev/null 2>&1 || npm install --omit=dev --no-audit --no-fund >/dev/null
echo "[mac-sync] node $(node --version) | $(swift --version 2>&1 | head -1)"
EOF
