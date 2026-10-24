package com.matdeck.client;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.content.DialogInterface;
import android.content.SharedPreferences;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Bundle;
import android.text.InputFilter;
import android.text.InputType;
import android.util.DisplayMetrics;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import com.matdeck.client.models.DeckProfile;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

public class MainActivity extends Activity implements
        DeckKeyView.OnKeyEventListener,
        DeckSocketClient.SocketListener,
        NetworkDiscovery.OnDiscoveryListener {

    private static final String PREFS_NAME = "MatDeckPrefs";
    private static final String KEY_SERVER_IP = "server_ip";
    private static final String KEY_SERVER_PORT = "server_port";
    private static final String KEY_DEVICE_TOKEN = "device_token";
    private static final long PAIRING_RETRY_MS = 5000;

    private View headerBar;
    private View statusDot;
    private TextView statusText;
    private TextView profileTitleView;
    private TextView autoBadge;
    private FrameLayout gridContainer;

    // Hardware HUD Frame
    private View hardwareHud;
    private TextView hudCpuText;
    private TextView hudGpuText;
    private TextView hudRamText;
    private TextView btnToggleHud;
    private boolean isHudUserVisible = true;

    private NotifyBanner notifyBanner;

    private DeckGridView gridView;
    private DeckSocketClient socketClient;
    // Emparelhamento por PIN (o PIN aparece no gerenciador do PC)
    private String deviceToken = "";
    private boolean pairingActive = false;
    private String pairingSessionId;
    private AlertDialog pinDialog;
    private NetworkDiscovery discovery;
    private SharedPreferences prefs;

    private String currentServerIp = "192.168.1.100";
    private int currentServerPort = 8888;
    private String currentProfileId = "obs";
    private boolean isHeaderVisible = true;
    private boolean isAutoDetectActive = true;

    /** Profiles advertised by the server via the profileList event (id + display name). */
    private final List<ProfileEntry> availableProfiles = new ArrayList<ProfileEntry>();

    private static class ProfileEntry {
        final String id;
        final String name;

        ProfileEntry(String id, String name) {
            this.id = id;
            this.name = name;
        }
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        // Keep screen alive during Stream Deck usage
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        enableImmersiveMode();

        prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        currentServerIp = prefs.getString(KEY_SERVER_IP, "");
        currentServerPort = prefs.getInt(KEY_SERVER_PORT, 8888);
        deviceToken = prefs.getString(KEY_DEVICE_TOKEN, "");

        initViews();
        applyAdaptiveScreenMetrics();

        // Start UDP Auto-discovery
        discovery = new NetworkDiscovery(this, this);
        discovery.start();

        // If IP already saved, attempt immediate connection
        if (!currentServerIp.isEmpty()) {
            connectToServer(currentServerIp, currentServerPort);
        }
    }

    private void applyAdaptiveScreenMetrics() {
        DisplayMetrics dm = getResources().getDisplayMetrics();
        int screenWidth = dm.widthPixels;
        int screenHeight = dm.heightPixels;

        // Detect 7" TFT LCD (1024 x 600) vs 10.1" (1280x800 or 1920x1200)
        boolean isCompact7Inch = (screenHeight <= 600 || screenWidth <= 1024);

        if (isCompact7Inch) {
            // Compress header & HUD so buttons get the maximum possible screen area on 1024x600
            findViewById(R.id.root_layout).setPadding(2, 2, 2, 2);

            ViewGroup.LayoutParams headerLp = headerBar.getLayoutParams();
            if (headerLp != null) {
                headerLp.height = (int)(28 * dm.density);
                headerBar.setLayoutParams(headerLp);
            }

            ViewGroup.LayoutParams hudLp = hardwareHud.getLayoutParams();
            if (hudLp != null) {
                hudLp.height = (int)(20 * dm.density);
                hardwareHud.setLayoutParams(hudLp);
            }

            hudCpuText.setTextSize(9);
            hudGpuText.setTextSize(9);
            hudRamText.setTextSize(9);
            profileTitleView.setTextSize(12);
        }
    }

    private void enableImmersiveMode() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT) {
            getWindow().getDecorView().setSystemUiVisibility(
                    View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                    | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                    | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                    | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                    | View.SYSTEM_UI_FLAG_FULLSCREEN
                    | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
            );
        }
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) {
            enableImmersiveMode();
        }
    }

    private void initViews() {
        headerBar = findViewById(R.id.header_bar);
        statusDot = findViewById(R.id.status_dot);
        statusText = (TextView) findViewById(R.id.status_text);
        profileTitleView = (TextView) findViewById(R.id.profile_title);
        autoBadge = (TextView) findViewById(R.id.badge_auto);
        gridContainer = (FrameLayout) findViewById(R.id.grid_container);

        // Hardware HUD Views
        hardwareHud = findViewById(R.id.hardware_hud);
        hudCpuText = (TextView) findViewById(R.id.hud_cpu_text);
        hudGpuText = (TextView) findViewById(R.id.hud_gpu_text);
        hudRamText = (TextView) findViewById(R.id.hud_ram_text);
        btnToggleHud = (TextView) findViewById(R.id.btn_toggle_hud);

        // Index 0 keeps the grid below the notification banner declared in the layout.
        gridView = new DeckGridView(this, this);
        gridContainer.addView(gridView, 0);

        notifyBanner = new NotifyBanner(
                this,
                findViewById(R.id.notify_banner),
                findViewById(R.id.notify_icon),
                (TextView) findViewById(R.id.notify_title),
                (TextView) findViewById(R.id.notify_text));

        // Prev Profile Button
        findViewById(R.id.btn_prev_profile).setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                cycleProfile(-1);
            }
        });

        // Next Profile Button
        findViewById(R.id.btn_next_profile).setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                cycleProfile(1);
            }
        });

        // Settings Button (Manual IP Dialog)
        findViewById(R.id.btn_settings).setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                showSettingsDialog();
            }
        });

        // HUD Toggle Button
        btnToggleHud.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                isHudUserVisible = !isHudUserVisible;
                hardwareHud.setVisibility(isHudUserVisible ? View.VISIBLE : View.GONE);
                btnToggleHud.setTextColor(getResources().getColor(isHudUserVisible ? R.color.accent : R.color.muted));
            }
        });

        // Fullscreen Toggle
        findViewById(R.id.btn_fullscreen_toggle).setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                toggleHeaderBar();
            }
        });

        updateStatus(false, "Procurando Servidor...");
    }

    private void toggleHeaderBar() {
        isHeaderVisible = !isHeaderVisible;
        headerBar.setVisibility(isHeaderVisible ? View.VISIBLE : View.GONE);
        if (!isHeaderVisible) {
            hardwareHud.setVisibility(View.GONE);
            Toast.makeText(this, "Toque na borda superior para exibir a barra", Toast.LENGTH_SHORT).show();
        } else {
            hardwareHud.setVisibility(isHudUserVisible ? View.VISIBLE : View.GONE);
        }
        enableImmersiveMode();
    }

    private void cycleProfile(int delta) {
        if (availableProfiles.isEmpty()) {
            Toast.makeText(this, "Nenhum perfil recebido do servidor", Toast.LENGTH_SHORT).show();
            return;
        }
        int currentIndex = indexOfProfile(currentProfileId);
        int size = availableProfiles.size();
        int nextIndex = currentIndex < 0
                ? (delta > 0 ? 0 : size - 1)
                : ((currentIndex + delta) % size + size) % size;
        requestProfileSwitch(availableProfiles.get(nextIndex).id);
    }

    private int indexOfProfile(String profileId) {
        for (int i = 0; i < availableProfiles.size(); i++) {
            if (availableProfiles.get(i).id.equals(profileId)) return i;
        }
        return -1;
    }

    private String displayNameFor(String profileId) {
        int idx = indexOfProfile(profileId);
        if (idx >= 0) {
            String name = availableProfiles.get(idx).name;
            if (name != null && !name.isEmpty()) return name;
        }
        return formatProfileName(profileId);
    }

    /**
     * Asks the server to switch profile. The local state is NOT changed here:
     * only the server's loadProfile confirms the switch, so key events keep
     * carrying the profile id the server actually has active.
     */
    private void requestProfileSwitch(String profileId) {
        if (socketClient == null || !socketClient.isConnected()) {
            Toast.makeText(this, "Sem conexão com o servidor", Toast.LENGTH_SHORT).show();
            return;
        }
        try {
            JSONObject msg = new JSONObject();
            msg.put("event", "switchProfile");
            msg.put("profile", profileId);
            socketClient.sendText(msg.toString());
        } catch (Exception ignored) {}
    }

    private void applyProfileList(JSONObject msg) {
        JSONArray profiles = msg.optJSONArray("profiles");
        if (profiles == null) return;

        availableProfiles.clear();
        for (int i = 0; i < profiles.length(); i++) {
            JSONObject p = profiles.optJSONObject(i);
            if (p == null) continue;
            String id = p.optString("id", "");
            if (id.isEmpty() || "null".equals(id)) continue;
            String name = p.isNull("name") ? "" : p.optString("name", "");
            availableProfiles.add(new ProfileEntry(id, name.isEmpty() ? formatProfileName(id) : name));
        }

        String current = msg.optString("current", "");
        if (!current.isEmpty() && !"null".equals(current)) {
            currentProfileId = current;
        }
        profileTitleView.setText(displayNameFor(currentProfileId));
    }

    private String formatProfileName(String id) {
        if (id == null || id.isEmpty()) return "";
        return id.substring(0, 1).toUpperCase() + id.substring(1);
    }

    private void updateStatus(boolean connected, String message) {
        statusText.setText(message);
        GradientDrawable dotBg = new GradientDrawable();
        dotBg.setShape(GradientDrawable.OVAL);
        dotBg.setColor(getResources().getColor(connected ? R.color.success : R.color.danger));
        statusDot.setBackgroundDrawable(dotBg);
    }

    private synchronized void connectToServer(String ip, int port) {
        this.currentServerIp = ip;
        this.currentServerPort = port;

        updateStatus(false, "Conectando: " + ip);

        if (socketClient != null) {
            socketClient.disconnect();
        }
        socketClient = new DeckSocketClient(ip, port, deviceToken.isEmpty() ? null : deviceToken, this);
        socketClient.connect();
    }

    private void showSettingsDialog() {
        AlertDialog.Builder builder = new AlertDialog.Builder(this);
        builder.setTitle("Configurar Conexão PC");

        final EditText inputIp = new EditText(this);
        inputIp.setHint("IP do PC (ex: 192.168.1.100)");
        inputIp.setText(currentServerIp);

        final EditText inputPort = new EditText(this);
        inputPort.setHint("Porta (padrão: 8888)");
        inputPort.setText(String.valueOf(currentServerPort));

        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        layout.setPadding(30, 20, 30, 20);
        layout.addView(inputIp);
        layout.addView(inputPort);
        builder.setView(layout);

        builder.setPositiveButton("Conectar", new DialogInterface.OnClickListener() {
            @Override
            public void onClick(DialogInterface dialog, int which) {
                String ip = inputIp.getText().toString().trim();
                int port = 8888;
                try {
                    port = Integer.parseInt(inputPort.getText().toString().trim());
                } catch (Exception ignored) {}

                if (!ip.isEmpty()) {
                    prefs.edit()
                            .putString(KEY_SERVER_IP, ip)
                            .putInt(KEY_SERVER_PORT, port)
                            .commit();
                    connectToServer(ip, port);
                }
            }
        });

        builder.setNegativeButton("Cancelar", null);
        builder.show();
    }

    // --- OnKeyEventListener ---
    @Override
    public void onKeyDown(int keyIndex) {
        sendKeyEvent("keyDown", keyIndex);
    }

    @Override
    public void onKeyUp(int keyIndex) {
        sendKeyEvent("keyUp", keyIndex);
    }

    @Override
    public void onSliderMoved(int keyIndex, String app, int value) {
        if (socketClient != null && socketClient.isConnected()) {
            try {
                JSONObject payload = new JSONObject();
                payload.put("event", "setVolume");
                payload.put("app", app != null ? app : "master");
                payload.put("value", value);
                socketClient.sendText(payload.toString());
            } catch (Exception e) {
                e.printStackTrace();
            }
        }
    }

    private void sendKeyEvent(String eventType, int keyIndex) {
        if (socketClient != null && socketClient.isConnected()) {
            try {
                JSONObject payload = new JSONObject();
                payload.put("event", eventType);
                payload.put("keyIndex", keyIndex);
                payload.put("profile", currentProfileId);
                socketClient.sendText(payload.toString());
            } catch (Exception e) {
                e.printStackTrace();
            }
        }
    }

    // --- NetworkDiscovery.OnDiscoveryListener ---
    @Override
    public void onServerFound(String ip, int port, String serverName) {
        // Already connected (or still connecting with backoff) to this exact target: nothing to do.
        if (socketClient != null && socketClient.isActive()
                && ip.equals(socketClient.getHost()) && port == socketClient.getPort()) {
            return;
        }
        // Connected somewhere else: keep the working connection.
        if (socketClient != null && socketClient.isConnected()) {
            return;
        }

        Toast.makeText(this, "PC encontrado: " + serverName + " (" + ip + ")", Toast.LENGTH_SHORT).show();
        prefs.edit()
                .putString(KEY_SERVER_IP, ip)
                .putInt(KEY_SERVER_PORT, port)
                .commit();
        connectToServer(ip, port);
    }

    // --- DeckSocketClient.SocketListener ---
    @Override
    public void onConnected() {
        updateStatus(true, "Conectado (" + currentServerIp + ")");

        try {
            DisplayMetrics dm = getResources().getDisplayMetrics();
            JSONObject hello = new JSONObject();
            hello.put("event", "clientHello");
            hello.put("device", Build.MODEL);
            hello.put("version", "Android 4.4.4");
            hello.put("width", dm.widthPixels);
            hello.put("height", dm.heightPixels);
            socketClient.sendText(hello.toString());
        } catch (Exception ignored) {}
    }

    @Override
    public void onMessage(String text) {
        try {
            JSONObject msg = new JSONObject(text);
            String event = msg.optString("event");

            if ("loadProfile".equals(event)) {
                DeckProfile profile = DeckProfile.fromJson(msg);
                this.currentProfileId = profile.id;
                String title = (profile.name != null && !profile.name.isEmpty() && !"null".equals(profile.name))
                        ? profile.name : displayNameFor(profile.id);
                this.profileTitleView.setText(title);

                if (!profile.showHardwareHud) {
                    hardwareHud.setVisibility(View.GONE);
                } else if (isHudUserVisible) {
                    hardwareHud.setVisibility(View.VISIBLE);
                }

                gridView.applyProfile(profile);

            } else if ("updateKey".equals(event)) {
                int keyIndex = msg.optInt("keyIndex", -1);
                String targetProfile = msg.optString("profile", "");
                boolean forCurrent = targetProfile.isEmpty() || "null".equals(targetProfile)
                        || targetProfile.equals(currentProfileId);
                if (keyIndex >= 0 && forCurrent) {
                    JSONObject keyObj = msg.optJSONObject("key");
                    if (keyObj != null) {
                        gridView.updateKey(keyIndex, keyObj);
                    }
                }

            } else if ("profileList".equals(event)) {
                applyProfileList(msg);

            } else if ("hardwareStats".equals(event)) {
                JSONObject stats = msg.optJSONObject("stats");
                if (stats != null) {
                    updateHardwareUi(stats);
                }

            } else if ("autoDetectStatus".equals(event)) {
                boolean active = msg.optBoolean("active", true);
                isAutoDetectActive = active;
                autoBadge.setVisibility(active ? View.VISIBLE : View.GONE);

            } else if ("notify".equals(event)) {
                if (notifyBanner != null) {
                    notifyBanner.handle(msg);
                }

            }
        } catch (Exception e) {
            e.printStackTrace();
        }
    }

    private void updateHardwareUi(JSONObject stats) {
        JSONObject cpu = stats.optJSONObject("cpu");
        JSONObject gpu = stats.optJSONObject("gpu");
        JSONObject ram = stats.optJSONObject("ram");

        int textColor = getResources().getColor(R.color.text);
        int dangerColor = getResources().getColor(R.color.danger);

        if (cpu != null && hudCpuText != null) {
            int usage = cpu.optInt("usage", 0);
            int temp = cpu.optInt("temp", 0);
            hudCpuText.setText(usage + "% | " + temp + "°C");
            hudCpuText.setTextColor(temp >= 75 ? dangerColor : textColor);
        }

        if (gpu != null && hudGpuText != null) {
            int usage = gpu.optInt("usage", 0);
            int temp = gpu.optInt("temp", 0);
            hudGpuText.setText(usage + "% | " + temp + "°C");
            hudGpuText.setTextColor(temp >= 75 ? dangerColor : textColor);
        }

        if (ram != null && hudRamText != null) {
            int pct = ram.optInt("percent", 0);
            String used = ram.optString("usedGB", "0.0");
            hudRamText.setText(pct + "% | " + used + "G");
        }
    }

    @Override
    public void onDisconnected(String reason) {
        updateStatus(false, "Desconectado");
    }

    @Override
    public void onError(Throwable error) {
        updateStatus(false, "Erro de Conexão");
    }

    @Override
    public void onUnauthorized() {
        // Sem token, ou o acesso foi removido no gerenciador: esquece o token e pede um PIN novo
        deviceToken = "";
        prefs.edit().remove(KEY_DEVICE_TOKEN).commit();
        updateStatus(false, "Aguardando PIN do PC");
        requestPairingPin();
    }

    // --- Emparelhamento por PIN ---

    private void requestPairingPin() {
        if (pinDialog != null && pinDialog.isShowing()) return;
        pairingActive = true;
        final String host = currentServerIp;
        final int port = currentServerPort;
        PairingClient.start(host, port, Build.MODEL, new PairingClient.Callback() {
            @Override
            public void onResult(int status, JSONObject body) {
                if (!pairingActive || !host.equals(currentServerIp)) return;
                if (status == 200 && body.has("id")) {
                    pairingSessionId = body.optString("id");
                    showPinDialog(host, port);
                } else if (status == 429) {
                    long wait = Math.max(1000, body.optLong("retryAfterMs", 30000));
                    updateStatus(false, "Muitas tentativas; novo PIN em " + Math.round(wait / 1000.0) + " s");
                    schedulePairingRetry(wait + 300);
                } else {
                    updateStatus(false, "PC não deu um PIN (" + status + "); tentando de novo");
                    schedulePairingRetry(PAIRING_RETRY_MS);
                }
            }

            @Override
            public void onFailure(Exception error) {
                if (!pairingActive) return;
                updateStatus(false, "Sem resposta do PC para o PIN; tentando de novo");
                schedulePairingRetry(PAIRING_RETRY_MS);
            }
        });
    }

    private void schedulePairingRetry(long delayMs) {
        statusText.postDelayed(new Runnable() {
            @Override
            public void run() {
                if (pairingActive) requestPairingPin();
            }
        }, delayMs);
    }

    private void showPinDialog(final String host, final int port) {
        if (pinDialog != null && pinDialog.isShowing()) return;

        final EditText input = new EditText(this);
        input.setInputType(InputType.TYPE_CLASS_NUMBER);
        input.setFilters(new InputFilter[]{ new InputFilter.LengthFilter(4) });
        input.setHint("PIN de 4 dígitos");
        input.setGravity(Gravity.CENTER);
        input.setTextSize(28);

        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        layout.setPadding(30, 20, 30, 20);
        layout.addView(input);

        AlertDialog.Builder builder = new AlertDialog.Builder(this);
        builder.setTitle("Conectar ao PC");
        builder.setMessage("Abra o gerenciador do MatDeck no computador: o PIN deste aparelho aparece lá. Ele vale por 2 minutos.");
        builder.setView(layout);
        builder.setCancelable(false);
        builder.setPositiveButton("Conectar", null); // listener abaixo, para o diálogo não fechar com PIN errado
        builder.setNegativeButton("Cancelar", new DialogInterface.OnClickListener() {
            @Override
            public void onClick(DialogInterface dialog, int which) {
                pairingActive = false;
                pinDialog = null;
                updateStatus(false, "Sem acesso: toque em ⚙ para conectar de novo");
            }
        });
        pinDialog = builder.create();
        pinDialog.setOnShowListener(new DialogInterface.OnShowListener() {
            @Override
            public void onShow(DialogInterface dialog) {
                pinDialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(new View.OnClickListener() {
                    @Override
                    public void onClick(View v) {
                        submitPin(host, port, input);
                    }
                });
            }
        });
        pinDialog.show();
    }

    private void submitPin(final String host, final int port, final EditText input) {
        final String pin = input.getText().toString().trim();
        if (pin.length() != 4) {
            Toast.makeText(this, "Digite os 4 dígitos do PIN", Toast.LENGTH_SHORT).show();
            return;
        }
        final Button button = pinDialog != null ? pinDialog.getButton(AlertDialog.BUTTON_POSITIVE) : null;
        if (button != null) button.setEnabled(false);
        PairingClient.verify(host, port, pairingSessionId, pin, new PairingClient.Callback() {
            @Override
            public void onResult(int status, JSONObject body) {
                if (button != null) button.setEnabled(true);
                if (status == 200 && body.has("token")) {
                    deviceToken = body.optString("token");
                    prefs.edit().putString(KEY_DEVICE_TOKEN, deviceToken).commit();
                    pairingActive = false;
                    dismissPinDialog();
                    Toast.makeText(MainActivity.this, "Aparelho emparelhado", Toast.LENGTH_SHORT).show();
                    connectToServer(host, port);
                } else if (status == 401) {
                    input.setText("");
                    Toast.makeText(MainActivity.this, "PIN incorreto (" + body.optInt("attemptsLeft", 0) + " tentativa(s) restante(s))", Toast.LENGTH_SHORT).show();
                } else if (status == 410) {
                    dismissPinDialog();
                    Toast.makeText(MainActivity.this, "Esse PIN venceu; pedindo outro", Toast.LENGTH_SHORT).show();
                    requestPairingPin();
                } else if (status == 429) {
                    dismissPinDialog();
                    long wait = Math.max(1000, body.optLong("retryAfterMs", 30000));
                    updateStatus(false, "Muitas tentativas; novo PIN em " + Math.round(wait / 1000.0) + " s");
                    schedulePairingRetry(wait + 300);
                } else {
                    Toast.makeText(MainActivity.this, body.optString("error", "Não foi possível conferir o PIN"), Toast.LENGTH_SHORT).show();
                }
            }

            @Override
            public void onFailure(Exception error) {
                if (button != null) button.setEnabled(true);
                Toast.makeText(MainActivity.this, "Sem resposta do PC", Toast.LENGTH_SHORT).show();
            }
        });
    }

    private void dismissPinDialog() {
        if (pinDialog != null) {
            try {
                pinDialog.dismiss();
            } catch (Exception ignored) {}
            pinDialog = null;
        }
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        if (discovery != null) {
            discovery.stop();
        }
        if (socketClient != null) {
            socketClient.disconnect();
        }
        pairingActive = false;
        dismissPinDialog();
    }
}
