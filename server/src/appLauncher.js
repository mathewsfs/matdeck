/**
 * Aplicativos instalados (arquivos .desktop) para teclas "abrir aplicativo".
 *
 * Tudo é lido pelo host via hostExec (funciona igual dentro do Flatpak): a lista de
 * .desktop, a resolução do ícone no tema e o conteúdo do ícone. A lista fica em cache
 * e é recarregada sob demanda (POST /api/apps/refresh) ou após CACHE_TTL_MS.
 */
const { exec, execFile } = require('./hostExec');

const CACHE_TTL_MS = 10 * 60 * 1000;
const LIST_TIMEOUT_MS = 8000;
const ICON_TIMEOUT_MS = 20000;

// Ordem = precedência (o primeiro .desktop com o mesmo id vence)
const DESKTOP_DIRS = [
    '$HOME/.local/share/applications',
    '$HOME/.local/share/flatpak/exports/share/applications',
    '/var/lib/flatpak/exports/share/applications',
    '/usr/local/share/applications',
    '/usr/share/applications'
];

const LIST_SCRIPT = `
for d in ${DESKTOP_DIRS.map(d => `"${d}"`).join(' ')}; do
  [ -d "$d" ] || continue
  for f in "$d"/*.desktop; do
    [ -f "$f" ] || continue
    printf '\\n@@FILE %s\\n' "$f"
    sed -n '/^\\[Desktop Entry\\]/,/^\\[/p' "$f" | head -150
  done
done
`;

function shellQuote(s) {
    return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/** Script que imprime "@@ICON <nome>\\t<mime>" seguido do base64 do arquivo, para cada nome de ícone. */
function iconScript(names) {
    return `
find_icon() {
  n="$1"
  case "$n" in /*) [ -f "$n" ] && { echo "$n"; return 0; }; return 1 ;; esac
  n="\${n%.png}"; n="\${n%.svg}"
  for base in "$HOME/.local/share/icons" "$HOME/.local/share/flatpak/exports/share/icons" "/var/lib/flatpak/exports/share/icons" "/usr/share/icons"; do
    for theme in hicolor breeze breeze-dark Papirus Adwaita; do
      [ -d "$base/$theme" ] || continue
      for sz in 128x128 96x96 64x64 48x48 256x256 scalable 512x512 32x32; do
        for ext in png svg; do f="$base/$theme/$sz/apps/$n.$ext"; [ -f "$f" ] && { echo "$f"; return 0; }; done
      done
      for sz in 48 64 32 22; do f="$base/$theme/apps/$sz/$n.svg"; [ -f "$f" ] && { echo "$f"; return 0; }; done
    done
  done
  for ext in png svg; do f="/usr/share/pixmaps/$n.$ext"; [ -f "$f" ] && { echo "$f"; return 0; }; done
  return 1
}
for n in ${names.map(shellQuote).join(' ')}; do
  f="$(find_icon "$n")" || continue
  case "$f" in *.svg) m="image/svg+xml" ;; *) m="image/png" ;; esac
  printf '@@ICON %s\\t%s\\n' "$n" "$m"
  base64 -w0 "$f"; echo
done
`;
}

function parseDesktopEntries(output) {
    const apps = new Map();
    const blocks = output.split(/\n@@FILE /).slice(1);
    for (const block of blocks) {
        const nl = block.indexOf('\n');
        const file = block.slice(0, nl).trim();
        const body = block.slice(nl + 1);
        const id = file.replace(/^.*\//, '').replace(/\.desktop$/, '');
        if (apps.has(id)) continue; // precedência pela ordem das pastas

        const entry = {};
        for (const line of body.split('\n')) {
            const m = /^([A-Za-z0-9-]+)(\[[^\]]+\])?\s*=\s*(.*)$/.exec(line);
            if (!m) continue;
            const key = m[1] + (m[2] || '');
            if (!(key in entry)) entry[key] = m[3].trim();
        }
        if ((entry.Type || 'Application') !== 'Application') continue;
        if (entry.NoDisplay === 'true' || entry.Hidden === 'true') continue;
        if (!entry.Exec && !entry.DBusActivatable) continue;
        if (entry.OnlyShowIn && !/KDE/i.test(entry.OnlyShowIn) && process.env.XDG_CURRENT_DESKTOP && !entry.OnlyShowIn.includes(process.env.XDG_CURRENT_DESKTOP)) continue;

        const name = entry['Name[pt_BR]'] || entry['Name[pt]'] || entry.Name || id;
        apps.set(id, {
            id,
            name,
            comment: entry['Comment[pt_BR]'] || entry['Comment[pt]'] || entry.Comment || entry['GenericName[pt_BR]'] || entry.GenericName || '',
            icon: entry.Icon || '',
            exec: entry.Exec || '',
            file,
            flatpak: /flatpak\/exports/.test(file) || /^flatpak run/.test(entry.Exec || ''),
            terminal: entry.Terminal === 'true'
        });
    }
    return apps;
}

class AppLauncher {
    constructor() {
        this.apps = new Map();      // id -> app
        this.icons = new Map();     // icon name -> { mime, base64 }
        this.loadedAt = 0;
        this.loading = null;
    }

    /** Lista de apps (com cache). force=true recarrega. */
    async list(force = false) {
        if (!force && this.apps.size && (Date.now() - this.loadedAt) < CACHE_TTL_MS) return this.summaries();
        if (!this.loading) {
            this.loading = this.reload().finally(() => { this.loading = null; });
        }
        await this.loading;
        return this.summaries();
    }

    summaries() {
        return Array.from(this.apps.values())
            .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR', { sensitivity: 'base' }))
            .map(a => ({ id: a.id, name: a.name, comment: a.comment, flatpak: a.flatpak, iconUrl: this.icons.has(a.icon) ? `/api/apps/${encodeURIComponent(a.id)}/icon` : null }));
    }

    /** Ícone como { mime, buffer } ou null. */
    iconOf(id) {
        const app = this.apps.get(id);
        const ic = app && this.icons.get(app.icon);
        return ic ? { mime: ic.mime, buffer: Buffer.from(ic.base64, 'base64') } : null;
    }

    /** Ícone como data URL (para gravar na tecla do preset). */
    iconDataUrl(id) {
        const app = this.apps.get(id);
        const ic = app && this.icons.get(app.icon);
        return ic ? `data:${ic.mime};base64,${ic.base64}` : null;
    }

    async reload() {
        const listing = await new Promise((resolve) => {
            exec(LIST_SCRIPT, { timeout: LIST_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
                if (err) console.warn(`[Apps] Falha ao listar aplicativos: ${String(stderr || err.message).trim().split('\n')[0]}`);
                resolve(err && !stdout ? '' : String(stdout || ''));
            });
        });
        const apps = parseDesktopEntries(listing);
        const names = Array.from(new Set(Array.from(apps.values()).map(a => a.icon).filter(Boolean)));
        const icons = new Map();
        if (names.length) {
            const out = await new Promise((resolve) => {
                exec(iconScript(names), { timeout: ICON_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
                    if (err) console.warn(`[Apps] Falha ao ler ícones: ${String(stderr || err.message).trim().split('\n')[0]}`);
                    resolve(String(stdout || ''));
                });
            });
            const lines = out.split('\n');
            for (let i = 0; i < lines.length; i++) {
                if (!lines[i].startsWith('@@ICON ')) continue;
                const [name, mime] = lines[i].slice(7).split('\t');
                const base64 = (lines[i + 1] || '').trim();
                if (name && base64) icons.set(name, { mime: mime || 'image/png', base64 });
            }
        }
        this.apps = apps;
        this.icons = icons;
        this.loadedAt = Date.now();
        console.log(`[Apps] ${apps.size} aplicativos encontrados (${icons.size} ícones).`);
    }

    /** Abre o app pelo .desktop (gio respeita Exec, flatpak run, Terminal, DBusActivatable). */
    launch(id) {
        const app = this.apps.get(id);
        if (!app) {
            console.warn(`[Apps] Aplicativo desconhecido: ${id}`);
            return false;
        }
        console.log(`[Apps] Abrindo ${app.name} (${app.file})`);
        execFile('gio', ['launch', app.file], { timeout: 15000 }, (err) => {
            if (!err) return;
            // Fallbacks: gtk-launch pelo id; por último o Exec sem códigos de campo (%f, %u...)
            execFile('gtk-launch', [id], { timeout: 15000 }, (err2) => {
                if (!err2) return;
                const cmd = app.exec.replace(/%[fFuUdDnNickvm]/g, '').trim();
                if (cmd) exec(`${cmd} >/dev/null 2>&1 &`, { timeout: 5000 }, () => {});
            });
        });
        return true;
    }
}

module.exports = AppLauncher;
