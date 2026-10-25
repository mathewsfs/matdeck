// Tradução entre os "class hints" dos perfis (nomes de classe de janela do Linux) e bundle ids do macOS,
// e dos bundle ids para os perfis do Auto-Perfil.
// A CONFIRMAR no Mac físico: ids do TeamSpeak 6 e do Nextcloud Talk (a VM não tem esses apps).
const CLASS_TO_BUNDLE = {
    discord: 'com.hnc.Discord', 'com.discordapp.discord': 'com.hnc.Discord', 'discord-canary': 'com.hnc.DiscordCanary', 'discord-ptb': 'com.hnc.DiscordPTB',
    'brave-browser': 'com.brave.Browser', 'google-chrome': 'com.google.Chrome', chromium: 'org.chromium.Chromium',
    firefox: 'org.mozilla.firefox', 'org.mozilla.firefox': 'org.mozilla.firefox', 'microsoft-edge': 'com.microsoft.edgemac',
    safari: 'com.apple.Safari',
    obs: 'com.obsproject.obs-studio', obs64: 'com.obsproject.obs-studio', 'obs-studio': 'com.obsproject.obs-studio', 'com.obsproject.studio': 'com.obsproject.obs-studio',
    spotify: 'com.spotify.client', 'com.spotify.client': 'com.spotify.client',
    teamspeak: 'com.teamspeak.TeamSpeak', teamspeak3: 'com.teamspeak.TeamSpeak', ts3client: 'com.teamspeak.TeamSpeak', 'com.teamspeak.teamspeak': 'com.teamspeak.TeamSpeak',
    'com.nextcloud.talk': 'com.nextcloud.talk.mac', 'nextcloud-talk': 'com.nextcloud.talk.mac'
};

const BUNDLE_TO_PROFILE = {
    'com.hnc.Discord': 'discord', 'com.hnc.DiscordCanary': 'discord', 'com.hnc.DiscordPTB': 'discord',
    'com.obsproject.obs-studio': 'obs',
    'com.spotify.client': 'spotify',
    'com.teamspeak.TeamSpeak': 'teamspeak',
    'com.nextcloud.talk.mac': 'nextcloud'
};

// Navegadores cujas abas o helper consegue trocar por AppleScript (Firefox não oferece isso)
const SCRIPTABLE_BROWSERS = ['com.apple.Safari', 'com.google.Chrome', 'com.brave.Browser', 'com.microsoft.edgemac', 'org.chromium.Chromium', 'com.vivaldi.Vivaldi'];

module.exports = { CLASS_TO_BUNDLE, BUNDLE_TO_PROFILE, SCRIPTABLE_BROWSERS };
