package com.matdeck.client;

import android.content.Context;
import android.net.wifi.WifiManager;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import org.json.JSONObject;

import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;
import java.net.InetSocketAddress;

public class NetworkDiscovery {
    private static final String TAG = "MatDeck_Discovery";
    public static final int DISCOVERY_PORT = 8889;

    public interface OnDiscoveryListener {
        void onServerFound(String ip, int port, String serverName);
    }

    private Context context;
    private OnDiscoveryListener listener;
    private WifiManager.MulticastLock multicastLock;
    private Thread listenThread;
    private DatagramSocket socket;
    private volatile boolean isRunning = false;
    private Handler mainHandler = new Handler(Looper.getMainLooper());

    public NetworkDiscovery(Context context, OnDiscoveryListener listener) {
        this.context = context;
        this.listener = listener;
    }

    public synchronized void start() {
        if (isRunning) return;
        isRunning = true;

        try {
            WifiManager wifi = (WifiManager) context.getSystemService(Context.WIFI_SERVICE);
            if (wifi != null) {
                multicastLock = wifi.createMulticastLock("matdeck_multicast_lock");
                multicastLock.setReferenceCounted(true);
                multicastLock.acquire();
            }
        } catch (Exception e) {
            Log.w(TAG, "MulticastLock failed: " + e.getMessage());
        }

        listenThread = new Thread(new Runnable() {
            @Override
            public void run() {
                listenLoop();
            }
        }, "MatDeck-DiscoveryThread");
        listenThread.start();
    }

    private void listenLoop() {
        byte[] buffer = new byte[2048];
        try {
            socket = new DatagramSocket(null);
            socket.setReuseAddress(true);
            socket.setBroadcast(true);
            socket.bind(new InetSocketAddress(DISCOVERY_PORT));

            while (isRunning) {
                DatagramPacket packet = new DatagramPacket(buffer, buffer.length);
                socket.receive(packet);

                String msg = new String(packet.getData(), 0, packet.getLength(), "UTF-8");
                try {
                    JSONObject json = new JSONObject(msg);
                    if ("matdeck-server".equals(json.optString("type"))) {
                        final String ip = resolveServerIp(packet, json);
                        final int port = json.optInt("port", 8888);
                        final String name = json.optString("name", "MatDeck Server");

                        mainHandler.post(new Runnable() {
                            @Override
                            public void run() {
                                if (listener != null) {
                                    listener.onServerFound(ip, port, name);
                                }
                            }
                        });
                    }
                } catch (Exception ignored) {}
            }
        } catch (Exception e) {
            if (isRunning) {
                Log.e(TAG, "Discovery socket error: " + e.getMessage());
            }
        } finally {
            closeSocket();
        }
    }

    /**
     * Prefers the packet's source address: it is the one that actually reached
     * this device. The advertised "ip" field is only used when the packet came
     * from loopback (e.g. server running on the same device/emulator).
     */
    private static String resolveServerIp(DatagramPacket packet, JSONObject json) {
        InetAddress source = packet.getAddress();
        String advertised = json.optString("ip", "");
        if (source == null || source.isLoopbackAddress() || source.isAnyLocalAddress()) {
            if (!advertised.isEmpty() && !"null".equals(advertised)) {
                return advertised;
            }
        }
        if (source != null) {
            return source.getHostAddress();
        }
        return advertised;
    }

    public synchronized void stop() {
        isRunning = false;
        closeSocket();
        if (listenThread != null) {
            listenThread.interrupt();
            listenThread = null;
        }
        if (multicastLock != null && multicastLock.isHeld()) {
            try {
                multicastLock.release();
            } catch (Exception ignored) {}
        }
    }

    private void closeSocket() {
        if (socket != null && !socket.isClosed()) {
            try {
                socket.close();
            } catch (Exception ignored) {}
        }
    }
}
