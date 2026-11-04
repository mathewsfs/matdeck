#!/usr/bin/env python3
"""Hook do Claude Code para o MatDeck: grava o estado da sessão atual em um arquivo por sessão.

Uso (configurado em ~/.claude/settings.json): python3 -I claude-code-hook.py <EVENTO>
Recebe o JSON do hook em stdin. Sem argumento, usa o `hook_event_name` do payload.
Depois de gravar, avisa o servidor do MatDeck (POST /api/claude/refresh). Nunca falha: sai sempre com código 0.
"""
import json
import os
import subprocess
import sys
import time
import urllib.request

DEFAULT_STATE_DIR = os.path.expanduser("~/.local/state/matdeck/claude-sessions")
DEFAULT_PORT_FILE = os.path.expanduser("~/.local/state/matdeck/port")
DEFAULT_PORT = 8888
NOTIFY_TIMEOUT = 0.3
MAX_TEXT = 80
MAX_PIDS = 8

EVENT_STATE = {
    "SessionStart": "idle",
    "UserPromptSubmit": "working",
    "PreToolUse": "working",
    "PostToolUse": "working",
    "Stop": "done",
    "Notification": "waiting",
}
CARRY_FIELDS = ("tool", "detail", "prompt", "turn_started", "notification_type")
# Eventos em que a cadeia de processos (janela do terminal) é recalculada; nos demais herda a do registro anterior.
WINDOW_EVENTS = ("SessionStart", "UserPromptSubmit")


def state_dir():
    return os.environ.get("MATDECK_CLAUDE_STATE_DIR") or DEFAULT_STATE_DIR


def valid_session_id(value):
    return bool(value) and all(c.isalnum() or c in "-_" for c in value)


def one_line(text):
    if not isinstance(text, str):
        return None
    text = " ".join(text.split())
    return text[:MAX_TEXT] if text else None


def tool_detail(tool, tool_input):
    """Resumo curto da entrada da ferramenta: comando do Bash, nome do arquivo, padrão de busca…"""
    if not isinstance(tool_input, dict):
        return None
    if tool == "Bash":
        return one_line(tool_input.get("description") or tool_input.get("command"))
    for key in ("file_path", "notebook_path", "path"):
        value = tool_input.get(key)
        if isinstance(value, str) and value:
            return os.path.basename(value.rstrip("/")) or value
    for key in ("pattern", "query", "url", "skill", "description", "prompt"):
        value = one_line(tool_input.get(key))
        if value:
            return value
    return None


def parent_pid(pid):
    """PID do pai de `pid`: /proc no Linux, `ps` nos demais sistemas (macOS). 0 se não achar."""
    try:
        with open("/proc/%d/stat" % pid, encoding="utf-8", errors="replace") as handle:
            stat = handle.read()
        # o nome do processo (campo 2) vem entre parênteses e pode ter espaços: o pai é o 2º campo depois do último ")"
        return int(stat[stat.rindex(")") + 1:].split()[1])
    except (OSError, ValueError, IndexError):
        pass
    try:
        out = subprocess.run(["ps", "-o", "ppid=", "-p", str(pid)], capture_output=True, text=True, timeout=1).stdout
        return int(out.strip())
    except Exception:
        return 0


def process_chain():
    """Cadeia de PIDs a partir do pai do hook (o Claude Code), subindo até o PID 1 ou MAX_PIDS níveis."""
    pids = []
    pid = os.getppid()
    while pid > 1 and len(pids) < MAX_PIDS:
        pids.append(pid)
        pid = parent_pid(pid)
    return pids


def window_info():
    return {
        "pids": process_chain(),
        "term_program": os.environ.get("TERM_PROGRAM") or None,
        "maestri_terminal_id": os.environ.get("MAESTRI_TERMINAL_ID") or None,
        "maestri_workspace_id": os.environ.get("MAESTRI_WORKSPACE_ID") or None,
    }


def record_for(event, payload, previous, now):
    state = EVENT_STATE.get(event)
    if event == "Notification" and payload.get("notification_type") == "idle_prompt":
        state = "done"
    if not state:
        return None
    record = {key: (previous or {}).get(key) for key in CARRY_FIELDS}
    record.update({
        "session_id": payload.get("session_id"),
        "state": state,
        "event": event,
        "ts": now,
        "cwd": payload.get("cwd") or (previous or {}).get("cwd"),
        "transcript_path": payload.get("transcript_path") or (previous or {}).get("transcript_path"),
        "window": window_info() if event in WINDOW_EVENTS else (previous or {}).get("window"),
    })
    if event == "SessionStart":
        for key in CARRY_FIELDS:
            record[key] = None
    elif event == "UserPromptSubmit":
        record.update(prompt=one_line(payload.get("prompt")), tool=None, detail=None, turn_started=now, notification_type=None)
    elif event in ("PreToolUse", "PostToolUse"):
        tool = payload.get("tool_name")
        if tool:
            record.update(tool=tool, detail=tool_detail(tool, payload.get("tool_input")))
        record["notification_type"] = None
        record["turn_started"] = record.get("turn_started") or now
    elif event == "Stop":
        record.update(tool=None, detail=None, turn_started=None, notification_type=None)
    elif event == "Notification":
        record["notification_type"] = payload.get("notification_type")
        if state == "done":
            record.update(tool=None, detail=None, turn_started=None)
    return record


def load_previous(path):
    try:
        with open(path, encoding="utf-8") as handle:
            data = json.load(handle)
        return data if isinstance(data, dict) else None
    except (OSError, ValueError):
        return None


def handle(event, payload, now=None):
    """Grava (ou apaga, no SessionEnd) o arquivo da sessão. Devolve True se algo mudou em disco."""
    session_id = str(payload.get("session_id") or "")
    if not valid_session_id(session_id):
        return False
    path = os.path.join(state_dir(), session_id + ".json")
    if event == "SessionEnd":
        try:
            os.remove(path)
        except FileNotFoundError:
            pass
        return True
    record = record_for(event, payload, load_previous(path), now or time.time())
    if record is None:
        return False
    os.makedirs(state_dir(), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as handle_:
        json.dump(record, handle_)
    os.replace(tmp, path)
    return True


def server_port():
    """Porta do MatDeck: MATDECK_PORT, senão o número no arquivo de porta, senão 8888."""
    try:
        return int(os.environ["MATDECK_PORT"])
    except (KeyError, ValueError):
        pass
    try:
        with open(os.environ.get("MATDECK_PORT_FILE") or DEFAULT_PORT_FILE, encoding="utf-8") as handle:
            return int(handle.read().strip())
    except (OSError, ValueError):
        return DEFAULT_PORT


def notify_matdeck():
    """Avisa o servidor que há estado novo. Best effort: qualquer erro é ignorado."""
    try:
        request = urllib.request.Request("http://127.0.0.1:%d/api/claude/refresh" % server_port(), data=b"", method="POST")
        urllib.request.urlopen(request, timeout=NOTIFY_TIMEOUT).close()
    except Exception:
        pass


def main(argv):
    try:
        payload = json.load(sys.stdin)
    except Exception:
        payload = {}
    if not isinstance(payload, dict):
        payload = {}
    try:
        event = argv[0] if argv else str(payload.get("hook_event_name") or "")
        if handle(event, payload):
            notify_matdeck()
    except Exception:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
