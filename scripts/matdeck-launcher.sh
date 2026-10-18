#!/bin/bash
# Lançador de desktop: sobe o servidor (se ainda não estiver rodando) e abre o painel.
BASE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PORT:-8888}"

if ! curl -fs "http://localhost:${PORT}/api/status" >/dev/null 2>&1; then
    mkdir -p "$HOME/.local/state/matdeck"
    nohup "${BASE_DIR}/start-server.sh" >"$HOME/.local/state/matdeck/server.log" 2>&1 &
    for _ in $(seq 1 30); do
        sleep 0.3
        curl -fs "http://localhost:${PORT}/api/status" >/dev/null 2>&1 && break
    done
fi

xdg-open "http://localhost:${PORT}/manage" >/dev/null 2>&1 &
