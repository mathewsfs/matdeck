package com.matdeck.client;

import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Emparelhamento por PIN com o servidor MatDeck: POST /api/pair/start pede um PIN (ele aparece no
 * gerenciador, no PC) e POST /api/pair/verify troca o PIN digitado por um token de dispositivo.
 * As chamadas rodam numa thread própria e os callbacks voltam na thread principal.
 */
public class PairingClient {
    private static final String TAG = "MatDeck_Pairing";
    private static final int CONNECT_TIMEOUT_MS = 5000;
    private static final int READ_TIMEOUT_MS = 8000;
    private static final Handler MAIN = new Handler(Looper.getMainLooper());

    public interface Callback {
        /** status HTTP e corpo JSON (vazio se o servidor não mandou JSON). */
        void onResult(int status, JSONObject body);
        void onFailure(Exception error);
    }

    public static void start(String host, int port, String deviceName, Callback callback) {
        JSONObject body = new JSONObject();
        try {
            body.put("name", deviceName);
        } catch (Exception ignored) {}
        post(baseUrl(host, port) + "/api/pair/start", body, callback);
    }

    public static void verify(String host, int port, String sessionId, String pin, Callback callback) {
        JSONObject body = new JSONObject();
        try {
            body.put("id", sessionId);
            body.put("pin", pin);
        } catch (Exception ignored) {}
        post(baseUrl(host, port) + "/api/pair/verify", body, callback);
    }

    private static String baseUrl(String host, int port) {
        return "http://" + host + ":" + port;
    }

    private static void post(final String url, final JSONObject body, final Callback callback) {
        new Thread(new Runnable() {
            @Override
            public void run() {
                HttpURLConnection conn = null;
                try {
                    conn = (HttpURLConnection) new URL(url).openConnection();
                    conn.setConnectTimeout(CONNECT_TIMEOUT_MS);
                    conn.setReadTimeout(READ_TIMEOUT_MS);
                    conn.setRequestMethod("POST");
                    conn.setDoOutput(true);
                    conn.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                    conn.setRequestProperty("Accept", "application/json");

                    byte[] data = body.toString().getBytes("UTF-8");
                    conn.setFixedLengthStreamingMode(data.length);
                    OutputStream out = conn.getOutputStream();
                    out.write(data);
                    out.flush();
                    out.close();

                    final int status = conn.getResponseCode();
                    InputStream in = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
                    String text = in != null ? readAll(in) : "";
                    JSONObject parsed;
                    try {
                        parsed = text.isEmpty() ? new JSONObject() : new JSONObject(text);
                    } catch (Exception e) {
                        parsed = new JSONObject();
                    }
                    final JSONObject result = parsed;
                    MAIN.post(new Runnable() {
                        @Override
                        public void run() {
                            callback.onResult(status, result);
                        }
                    });
                } catch (final Exception e) {
                    Log.w(TAG, "Pairing request failed: " + e.getMessage());
                    MAIN.post(new Runnable() {
                        @Override
                        public void run() {
                            callback.onFailure(e);
                        }
                    });
                } finally {
                    if (conn != null) conn.disconnect();
                }
            }
        }, "MatDeck-Pairing").start();
    }

    private static String readAll(InputStream in) throws IOException {
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        byte[] chunk = new byte[4096];
        int n;
        while ((n = in.read(chunk)) != -1) {
            buffer.write(chunk, 0, n);
        }
        in.close();
        return new String(buffer.toByteArray(), "UTF-8");
    }
}
