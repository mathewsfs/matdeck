#!/bin/bash
# Gera o Flatpak do servidor MatDeck, instala para o usuário atual e grava dist/MatDeck.flatpak.
# Requisitos: flatpak, flatpak-builder e os runtimes (instalados automaticamente se faltarem).
set -e
BASE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_ID="br.com.matdeck.MatDeck"
MANIFEST="${BASE_DIR}/flatpak/${APP_ID}.yml"
BUILD_DIR="${BASE_DIR}/build/flatpak"
REPO_DIR="${BASE_DIR}/build/flatpak-repo"
RUNTIME_VERSION="26.08"

command -v flatpak-builder >/dev/null || { echo "Instale o flatpak-builder: sudo dnf install flatpak-builder"; exit 1; }

# Dependências puras em JS; o pacote leva o node_modules pronto (o build roda offline)
if [ ! -d "${BASE_DIR}/server/node_modules" ]; then
    (cd "${BASE_DIR}/server" && npm install --no-audit --no-fund --omit=dev)
fi

# Deck para navegadores antigos (Safari 9 do iPad 2): regenera se o Babel estiver instalado;
# senão só avisa quando o arquivo gerado ficou para trás do app.js
LEGACY_DIR="${BASE_DIR}/scripts/legacy-build"
if [ -d "${LEGACY_DIR}/node_modules" ]; then
    (cd "${LEGACY_DIR}" && npm run --silent build)
elif [ "${BASE_DIR}/server/web/app.js" -nt "${BASE_DIR}/server/web/app.legacy.js" ]; then
    echo "[MatDeck] Aviso: server/web/app.legacy.js está mais antigo que app.js. Gere com: cd scripts/legacy-build && npm install && npm run build"
fi

flatpak remote-add --user --if-not-exists flathub https://dl.flathub.org/repo/flathub.flatpakrepo
flatpak install --user -y --noninteractive flathub \
    "org.freedesktop.Platform//${RUNTIME_VERSION}" \
    "org.freedesktop.Sdk//${RUNTIME_VERSION}" \
    "org.freedesktop.Sdk.Extension.node24//${RUNTIME_VERSION}" >/dev/null

echo "[MatDeck] Compilando ${APP_ID}..."
# FLATPAK_BUILDER_ARGS: opções extras (a CI passa --disable-rofiles-fuse)
flatpak-builder --user --install --force-clean ${FLATPAK_BUILDER_ARGS:-} --repo="${REPO_DIR}" "${BUILD_DIR}" "${MANIFEST}"

mkdir -p "${BASE_DIR}/dist"
flatpak build-bundle "${REPO_DIR}" "${BASE_DIR}/dist/MatDeck.flatpak" "${APP_ID}"
echo "[✔] Instalado para o usuário e gravado em dist/MatDeck.flatpak"
echo "    Rodar:     flatpak run ${APP_ID}"
echo "    Instalar em outro PC: flatpak install --user dist/MatDeck.flatpak"
