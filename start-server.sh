#!/bin/bash
# Inicia o servidor MatDeck (painel web + WebSocket para o tablet)
cd "$(dirname "$0")/server" || exit 1

if [ ! -d node_modules ]; then
    echo "[MatDeck] Instalando dependências (primeira execução)..."
    npm install --no-audit --no-fund || exit 1
fi

if [ "$XDG_SESSION_TYPE" = "wayland" ]; then
    if ! pgrep -x ydotoold >/dev/null 2>&1; then
        echo "[MatDeck] AVISO: ydotoold não está rodando. Envio de teclas (Discord/Meet) não vai funcionar."
        echo "          Ative com: sudo systemctl enable --now ydotool"
    fi
    if ! command -v kdotool >/dev/null 2>&1; then
        echo "[MatDeck] Opcional: 'kdotool' deixa o foco de janela mais rápido no KDE (a detecção do app ativo já funciona via script KWin)."
    fi
fi

echo "[MatDeck] Iniciando servidor..."
# Sai com 75 (/api/restart pela bandeja): sobe de novo; qualquer outro código encerra de vez
while :; do
    node src/index.js
    rc=$?
    [ "$rc" -eq 75 ] || exit "$rc"
    echo "[MatDeck] Reiniciando o servidor..."
    sleep 1
done
