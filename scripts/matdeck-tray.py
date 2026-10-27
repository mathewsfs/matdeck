#!/usr/bin/env python3
"""
Ícone do MatDeck na bandeja do sistema (StatusNotifierItem via Qt).

É iniciado pelo próprio servidor Node (server/src/tray.js) e encerra sozinho
quando o servidor cai: lê stdin e sai no EOF, além de vigiar o PID do servidor.

Estados do ponto no ícone:
  verde   servidor no ar e pelo menos um tablet conectado
  âmbar   servidor no ar, nenhum tablet conectado
  cinza   servidor ainda não responde (iniciando ou parado)

Variáveis de ambiente lidas:
  MATDECK_PORT        porta HTTP do servidor (padrão 8888)
  MATDECK_SERVER_PID  PID do processo Node (0 quando o servidor roda em Flatpak)
  MATDECK_LAN_IP      IP na rede local, só para o tooltip

O ícone base vem do próprio servidor (GET /matdeck.png) e "Parar servidor" chama
POST /api/shutdown, para funcionar igual com o servidor no host ou em Flatpak.
"""
import json
import os
import signal
import subprocess
import sys
import threading
import urllib.request
import webbrowser

try:
    from PySide6.QtCore import QObject, Qt, QTimer, Signal, QRectF, QPointF
    from PySide6.QtGui import QAction, QColor, QIcon, QPainter, QPixmap, QPen, QFont, QBrush
    from PySide6.QtWidgets import QApplication, QMenu, QSystemTrayIcon
except ImportError:
    # Código 3 = sem PySide6; o servidor loga uma dica de instalação.
    sys.exit(3)

PORT = int(os.environ.get('MATDECK_PORT') or 8888)
SERVER_PID = int(os.environ.get('MATDECK_SERVER_PID') or 0)
BASE_URL = f'http://127.0.0.1:{PORT}'
POLL_MS = 2000

COLOR_RUNNING = QColor('#22C55E')
COLOR_IDLE = QColor('#F59E0B')
COLOR_DOWN = QColor('#6B7280')


class StatusPoller(QObject):
    """Consulta /api/status numa thread separada para não travar o menu."""
    updated = Signal(object)  # dict ou None

    def start(self):
        self._timer = QTimer(self)
        self._timer.timeout.connect(self._spawn)
        self._timer.start(POLL_MS)
        self._spawn()

    def _spawn(self):
        threading.Thread(target=self._fetch, daemon=True).start()

    def _fetch(self):
        try:
            with urllib.request.urlopen(f'{BASE_URL}/api/status', timeout=1.5) as resp:
                status = json.loads(resp.read().decode('utf-8'))
        except Exception:
            status = None
        try:
            self.updated.emit(status)
        except RuntimeError:
            pass  # app já encerrou enquanto a requisição rodava


def host_env():
    """Ambiente para processos filhos (navegador): o bus real do host, não o proxy do sandbox.

    No Flatpak o servidor conecta este ícone ao D-Bus pelo proxy do sandbox (para o Plasma associar
    o ícone ao app), mas esse proxy só libera o que o manifesto permite; o navegador precisa dos
    portais, então o xdg-open falhava em silêncio.
    """
    env = dict(os.environ)
    bus = os.path.join(os.environ.get('XDG_RUNTIME_DIR') or f'/run/user/{os.getuid()}', 'bus')
    if os.path.exists(bus):
        env['DBUS_SESSION_BUS_ADDRESS'] = f'unix:path={bus}'
    else:
        env.pop('DBUS_SESSION_BUS_ADDRESS', None)
    return env


def open_url(url):
    try:
        subprocess.Popen(['xdg-open', url], env=host_env(), stdin=subprocess.DEVNULL,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    except Exception:
        webbrowser.open(url)


def fetch_base_icon():
    """PNG do app servido pelo próprio servidor; vazio se ele ainda não respondeu."""
    try:
        with urllib.request.urlopen(f'{BASE_URL}/matdeck.png', timeout=1.5) as resp:
            pix = QPixmap()
            pix.loadFromData(resp.read())
            return pix
    except Exception:
        return QPixmap()


def build_icon(dot_color, base, size=64):
    pix = QPixmap(size, size)
    pix.fill(Qt.transparent)
    painter = QPainter(pix)
    painter.setRenderHint(QPainter.Antialiasing)

    if base is not None and not base.isNull():
        painter.drawPixmap(0, 0, base.scaled(size, size, Qt.KeepAspectRatio, Qt.SmoothTransformation))
    else:
        # Fallback: quadrado arredondado com "M"
        painter.setPen(Qt.NoPen)
        painter.setBrush(QBrush(QColor('#1F2937')))
        painter.drawRoundedRect(QRectF(2, 2, size - 4, size - 4), size * 0.22, size * 0.22)
        painter.setPen(QPen(QColor('#E5E7EB')))
        font = QFont('Sans', int(size * 0.5), QFont.Bold)
        painter.setFont(font)
        painter.drawText(QRectF(0, 0, size, size), Qt.AlignCenter, 'M')

    # Ponto de estado no canto inferior direito, com borda escura para contraste
    r = size * 0.19
    center = QPointF(size - r - 2, size - r - 2)
    painter.setPen(QPen(QColor(0, 0, 0, 170), max(2, size * 0.05)))
    painter.setBrush(QBrush(dot_color))
    painter.drawEllipse(center, r, r)
    painter.end()
    return QIcon(pix)


class Tray(QObject):
    # Emitido pela thread do stdin; a conexão com app.quit vira enfileirada e roda na thread do Qt
    server_gone = Signal()

    def __init__(self, app):
        super().__init__()
        self.app = app
        self.status = None
        self.announced = False
        self.server_started_at = None
        self.server_gone.connect(self.app.quit)
        self.base_icon = fetch_base_icon()
        self.rebuild_icons()

        self.tray = QSystemTrayIcon(self.icons['down'])
        self.menu = QMenu()

        self.header = QAction('MatDeck · iniciando…')
        self.header.setEnabled(False)
        self.detail = QAction('')
        self.detail.setEnabled(False)
        self.menu.addAction(self.header)
        self.menu.addAction(self.detail)
        self.menu.addSeparator()

        act_manage = QAction('Abrir gerenciador')
        act_manage.triggered.connect(lambda: open_url(f'{BASE_URL}/manage'))
        act_deck = QAction('Abrir deck no navegador')
        act_deck.triggered.connect(lambda: open_url(f'{BASE_URL}/'))
        self.menu.addAction(act_manage)
        self.menu.addAction(act_deck)
        self.menu.addSeparator()

        self.act_restart = QAction('Reiniciar servidor')
        self.act_restart.triggered.connect(self.restart_server)
        self.menu.addAction(self.act_restart)
        self.act_stop = QAction('Parar servidor')
        self.act_stop.triggered.connect(self.stop_server)
        self.menu.addAction(self.act_stop)
        act_hide = QAction('Ocultar ícone')
        act_hide.triggered.connect(self.app.quit)
        self.menu.addAction(act_hide)

        # Mantém referências para o Qt não coletar as ações
        self._actions = [act_manage, act_deck, act_hide]

        self.tray.setContextMenu(self.menu)
        self.tray.activated.connect(self.on_activated)
        self.tray.setToolTip('MatDeck · iniciando…')
        self.tray.show()

        self.poller = StatusPoller()
        self.poller.updated.connect(self.apply_status)
        self.poller.start()

        # Encerra junto com o servidor
        threading.Thread(target=self.watch_stdin, daemon=True).start()
        self.pid_timer = QTimer(self)
        self.pid_timer.timeout.connect(self.check_server_alive)
        self.pid_timer.start(1500)

    def rebuild_icons(self):
        self.icons = {
            'running': build_icon(COLOR_RUNNING, self.base_icon),
            'idle': build_icon(COLOR_IDLE, self.base_icon),
            'down': build_icon(COLOR_DOWN, self.base_icon),
        }

    def on_activated(self, reason):
        if reason in (QSystemTrayIcon.Trigger, QSystemTrayIcon.DoubleClick):
            open_url(f'{BASE_URL}/manage')

    def apply_status(self, status):
        self.status = status
        if not status:
            self.tray.setIcon(self.icons['down'])
            self.header.setText('MatDeck · servidor não responde')
            self.detail.setText(f'porta {PORT}')
            self.tray.setToolTip(f'MatDeck · servidor não responde (porta {PORT})')
            return

        if self.base_icon.isNull():
            # O servidor acabou de subir: agora dá para buscar o PNG do app
            self.base_icon = fetch_base_icon()
            if not self.base_icon.isNull():
                self.rebuild_icons()

        # Outro servidor subiu no lugar (reinício): ele cria o próprio ícone, este sai
        started_at = status.get('startedAt')
        if started_at:
            if self.server_started_at is None:
                self.server_started_at = started_at
            elif started_at != self.server_started_at:
                self.app.quit()
                return

        clients = int(status.get('clientsConnected') or 0)
        ip = status.get('ip') or os.environ.get('MATDECK_LAN_IP') or '127.0.0.1'
        version = status.get('version') or ''
        ts = (status.get('integrations') or {}).get('teamspeak') or {}
        ts_text = 'TS conectado' if ts.get('connected') else 'TS desconectado'
        if ts.get('connected') and ts.get('serverConnected') and ts.get('channelName'):
            ts_text = f"TS: {ts.get('channelName')}"

        tablets = 'nenhum tablet' if clients == 0 else (f'{clients} tablet' if clients == 1 else f'{clients} tablets')
        self.tray.setIcon(self.icons['running' if clients > 0 else 'idle'])
        self.header.setText(f'MatDeck v{version} · rodando')
        self.detail.setText(f'{ip}:{status.get("port") or PORT} · {tablets} · {ts_text}')
        self.tray.setToolTip(f'MatDeck v{version}\nhttp://{ip}:{status.get("port") or PORT}\n{tablets} · {ts_text}')

        if not self.announced and QSystemTrayIcon.supportsMessages():
            self.announced = True
            self.tray.showMessage('MatDeck no ar', f'http://{ip}:{status.get("port") or PORT}', self.icons['running'], 3500)

    def restart_server(self):
        # O servidor sai com código 75 e o lançador (start-server.sh / Flatpak) sobe outro, que abre uma
        # bandeja nova; esta some junto com o servidor atual (stdin fechado).
        try:
            req = urllib.request.Request(f'{BASE_URL}/api/restart', data=b'{}', method='POST',
                                         headers={'Content-Type': 'application/json'})
            urllib.request.urlopen(req, timeout=2).read()
        except Exception:
            return
        self.act_restart.setEnabled(False)
        self.act_stop.setEnabled(False)
        self.header.setText('MatDeck · reiniciando…')
        QTimer.singleShot(4000, self.app.quit)

    def stop_server(self):
        try:
            req = urllib.request.Request(f'{BASE_URL}/api/shutdown', data=b'{}', method='POST',
                                         headers={'Content-Type': 'application/json'})
            urllib.request.urlopen(req, timeout=2).read()
        except Exception:
            if SERVER_PID > 0:
                try:
                    os.kill(SERVER_PID, signal.SIGTERM)
                except ProcessLookupError:
                    pass
        self.act_stop.setEnabled(False)
        self.header.setText('MatDeck · encerrando…')
        # O servidor fecha o stdin ao morrer, o que também encerra o ícone.
        QTimer.singleShot(4000, self.app.quit)

    def check_server_alive(self):
        if SERVER_PID <= 0:
            return
        try:
            os.kill(SERVER_PID, 0)
        except ProcessLookupError:
            self.app.quit()

    def watch_stdin(self):
        try:
            while sys.stdin.readline():
                pass
        except Exception:
            pass
        # Não usar QTimer aqui: esta thread não tem event loop e o timer nunca dispararia
        self.server_gone.emit()


def main():
    QApplication.setDesktopFileName('matdeck')
    app = QApplication(sys.argv)
    app.setApplicationName('MatDeck')
    app.setQuitOnLastWindowClosed(False)
    if not QSystemTrayIcon.isSystemTrayAvailable():
        # Código 4 = sem bandeja disponível na sessão
        sys.exit(4)
    tray = Tray(app)  # noqa: F841 (mantém referência viva)
    signal.signal(signal.SIGINT, signal.SIG_DFL)
    signal.signal(signal.SIGTERM, lambda *_: app.quit())
    sys.exit(app.exec())


if __name__ == '__main__':
    main()
