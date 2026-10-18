#!/bin/sh
# Ponto de entrada do Flatpak: sobe o servidor MatDeck ou, se ele já estiver no ar, abre o gerenciador.
#   matdeck          sobe o servidor (ou abre o gerenciador se já estiver rodando)
#   matdeck open     só abre o gerenciador no navegador
#   matdeck server   só sobe o servidor (sem abrir navegador)
PORT="${PORT:-8888}"
export MATDECK_DATA_DIR="${MATDECK_DATA_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/matdeck}"
mkdir -p "$MATDECK_DATA_DIR"

is_running() {
    node -e "fetch('http://127.0.0.1:${PORT}/api/status').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))" 2>/dev/null
}

open_manager() {
    xdg-open "http://localhost:${PORT}/manage" >/dev/null 2>&1 &
}

case "${1:-}" in
    open)
        open_manager
        exit 0
        ;;
    server)
        ;;
    *)
        if is_running; then
            open_manager
            exit 0
        fi
        ;;
esac

cd /app/share/matdeck/server || exit 1
exec node src/index.js
