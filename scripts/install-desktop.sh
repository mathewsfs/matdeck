#!/bin/bash
# Instala o atalho "MatDeck" no menu de aplicativos do usuário (sem sudo).
set -e
BASE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="$HOME/.local/share/applications"
ICON_DIR="$HOME/.local/share/icons/hicolor/128x128/apps"
mkdir -p "$APP_DIR" "$ICON_DIR"
cp "${BASE_DIR}/android-client/app/src/main/res/drawable/ic_launcher.png" "${ICON_DIR}/matdeck.png"
chmod +x "${BASE_DIR}/scripts/matdeck-launcher.sh" "${BASE_DIR}/start-server.sh"
cat > "${APP_DIR}/matdeck.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=MatDeck
Comment=Stream Deck para tablet Android (servidor + painel)
Exec=${BASE_DIR}/scripts/matdeck-launcher.sh
Icon=matdeck
Terminal=false
Categories=AudioVideo;Utility;
Keywords=streamdeck;obs;discord;teamspeak;meet;
DESKTOP
update-desktop-database "$APP_DIR" 2>/dev/null || true
echo "[✔] Atalho instalado: ${APP_DIR}/matdeck.desktop (procure por 'MatDeck' no menu)."
