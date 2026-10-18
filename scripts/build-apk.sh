#!/bin/bash
set -e

BASE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUTPUT_DIR="${BASE_DIR}/dist"
mkdir -p "${OUTPUT_DIR}"

echo "=========================================================="
echo "          Compilador do MatDeck APK (Android 4.4.4)       "
echo "=========================================================="

if command -v podman &>/dev/null; then
    CONTAINER_ENGINE="podman"
elif command -v docker &>/dev/null; then
    CONTAINER_ENGINE="docker"
else
    CONTAINER_ENGINE=""
fi

if [ -n "${CONTAINER_ENGINE}" ]; then
    echo "[+] Usando ${CONTAINER_ENGINE} para compilar o APK em ambiente isolado..."
    IMAGE_NAME="matdeck-builder"

    echo "[+] Construindo imagem de build..."
    ${CONTAINER_ENGINE} build -t ${IMAGE_NAME} -f "${BASE_DIR}/android-client/Dockerfile" "${BASE_DIR}/android-client"

    echo "[+] Compilando APK..."
    ${CONTAINER_ENGINE} run --rm -v "${BASE_DIR}/android-client:/app:z" ${IMAGE_NAME} ./gradlew assembleDebug --no-daemon

    APK_SOURCE="${BASE_DIR}/android-client/app/build/outputs/apk/debug/app-debug.apk"
    if [ -f "${APK_SOURCE}" ]; then
        cp "${APK_SOURCE}" "${OUTPUT_DIR}/MatDeck-debug.apk"
        echo "=========================================================="
        echo "[✔] APK gerado com SUCESSO!"
        echo "    Localização: ${OUTPUT_DIR}/MatDeck-debug.apk"
        echo "=========================================================="
        exit 0
    fi
fi

if [ -f "${BASE_DIR}/android-client/gradlew" ]; then
    echo "[!] Tentando compilação direta via gradlew local..."
    cd "${BASE_DIR}/android-client"
    ./gradlew assembleDebug --no-daemon
    APK_SOURCE="${BASE_DIR}/android-client/app/build/outputs/apk/debug/app-debug.apk"
    if [ -f "${APK_SOURCE}" ]; then
        cp "${APK_SOURCE}" "${OUTPUT_DIR}/MatDeck-debug.apk"
        echo "[✔] APK gerado em: ${OUTPUT_DIR}/MatDeck-debug.apk"
        exit 0
    fi
fi

echo "[-] Não foi possível compilar automaticamente. Abra a pasta 'android-client' no Android Studio ou instale o SDK."
exit 1
