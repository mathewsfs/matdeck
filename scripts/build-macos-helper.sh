#!/bin/bash
# Compila o helper nativo do macOS e monta "MatDeck Helper.app" (sem Dock, assinado ad hoc com identificador
# fixo, para a permissão de Acessibilidade ficar amarrada ao bundle). Requer as Command Line Tools do Xcode.
# Uso: ./scripts/build-macos-helper.sh [--debug]     → imprime o caminho do .app
set -e
BASE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PKG="$BASE_DIR/macos/MatDeckHelper"
CONFIG=release
[ "${1:-}" = "--debug" ] && CONFIG=debug
APP="$PKG/dist/MatDeck Helper.app"

command -v swift >/dev/null || { echo "Instale as Command Line Tools: xcode-select --install"; exit 1; }
cd "$PKG"
swift build -c "$CONFIG" 2>&1 | grep -v -E '^\[|^Compiling|^Emitting|^Linking|^Build complete' || true
BIN="$PKG/.build/$CONFIG/matdeck-helper"
[ -x "$BIN" ] || { echo "Binário não encontrado em $BIN"; exit 1; }

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/matdeck-helper"
cp "$PKG/Resources/Info.plist" "$APP/Contents/Info.plist"
for f in "$PKG"/Resources/*; do [ "$(basename "$f")" = "Info.plist" ] || cp -R "$f" "$APP/Contents/Resources/"; done
printf 'APPL????' > "$APP/Contents/PkgInfo"
codesign --force --sign - --identifier br.com.matdeck.helper "$APP" >/dev/null
echo "$APP"
