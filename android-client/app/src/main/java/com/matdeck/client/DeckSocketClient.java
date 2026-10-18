package com.matdeck.client;

import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import android.util.Log;

import java.io.ByteArrayOutputStream;
import java.io.EOFException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.security.SecureRandom;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;

public class DeckSocketClient {
    private static final String TAG = "MatDeck_Socket";

    /** Server pings every 25s; anything beyond this without data means a zombie connection. */
    private static final int READ_TIMEOUT_MS = 60000;
    private static final int CONNECT_TIMEOUT_MS = 5000;
    private static final long RECONNECT_BACKOFF_MS = 3000;

    public interface SocketListener {
        void onConnected();
        void onMessage(String text);
        void onDisconnected(String reason);
        void onError(Throwable error);
    }

    private final String host;
    private final int port;
    private final SocketListener listener;
    private Socket socket;
    private OutputStream out;
    private InputStream in;

    private Thread workerThread;
    private ExecutorService sendExecutor;
    private volatile boolean isConnected = false;
    private volatile boolean shouldRun = false;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final SecureRandom random = new SecureRandom();

    public DeckSocketClient(String host, int port, SocketListener listener) {
        this.host = host;
        this.port = port;
        this.listener = listener;
    }

    public String getHost() {
        return host;
    }

    public int getPort() {
        return port;
    }

    public synchronized void connect() {
        if (shouldRun) return;
        shouldRun = true;

        sendExecutor = Executors.newSingleThreadExecutor();

        workerThread = new Thread(new Runnable() {
            @Override
            public void run() {
                connectionLoop();
            }
        }, "MatDeck-SocketThread");
        workerThread.start();
    }

    public synchronized void disconnect() {
        shouldRun = false;
        isConnected = false;
        closeQuietly();
        if (sendExecutor != null) {
            sendExecutor.shutdownNow();
            sendExecutor = null;
        }
        if (workerThread != null) {
            workerThread.interrupt();
            workerThread = null;
        }
    }

    public boolean isConnected() {
        return isConnected;
    }

    /** True while this client is still trying to reach (or is connected to) its target. */
    public boolean isActive() {
        return shouldRun;
    }

    private void connectionLoop() {
        while (shouldRun) {
            try {
                Log.d(TAG, "Connecting to " + host + ":" + port + "...");
                Socket s = new Socket();
                s.setTcpNoDelay(true); // Low latency for instant button feedback
                s.setSoTimeout(READ_TIMEOUT_MS);
                s.connect(new InetSocketAddress(host, port), CONNECT_TIMEOUT_MS);
                socket = s;

                out = s.getOutputStream();
                in = s.getInputStream();

                if (performHandshake()) {
                    isConnected = true;
                    notifyConnected();
                    readFrames();
                } else {
                    Log.w(TAG, "WebSocket handshake rejected by server");
                }
            } catch (SocketTimeoutException e) {
                if (shouldRun) {
                    Log.w(TAG, "Read timeout: no data for " + READ_TIMEOUT_MS + "ms, treating as dropped");
                }
            } catch (Exception e) {
                if (shouldRun) {
                    Log.w(TAG, "Connection error: " + e.getMessage());
                    notifyError(e);
                }
            } finally {
                boolean wasConnected = isConnected;
                isConnected = false;
                closeQuietly();
                if (wasConnected && shouldRun) {
                    notifyDisconnected("Connection dropped");
                }
            }

            if (shouldRun) {
                try {
                    Thread.sleep(RECONNECT_BACKOFF_MS); // Reconnect backoff
                } catch (InterruptedException e) {
                    break;
                }
            }
        }
    }

    private boolean performHandshake() throws Exception {
        byte[] keyBytes = new byte[16];
        random.nextBytes(keyBytes);
        String secKey = Base64.encodeToString(keyBytes, Base64.NO_WRAP);

        String request = "GET /deck HTTP/1.1\r\n"
                + "Host: " + host + ":" + port + "\r\n"
                + "Upgrade: websocket\r\n"
                + "Connection: Upgrade\r\n"
                + "Sec-WebSocket-Key: " + secKey + "\r\n"
                + "Sec-WebSocket-Version: 13\r\n\r\n";

        out.write(request.getBytes("UTF-8"));
        out.flush();

        // Read response headers
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        int b;
        int state = 0;
        while ((b = in.read()) != -1) {
            buffer.write(b);
            if (state == 0 && b == '\r') state = 1;
            else if (state == 1 && b == '\n') state = 2;
            else if (state == 2 && b == '\r') state = 3;
            else if (state == 3 && b == '\n') {
                break; // End of HTTP headers
            } else {
                state = 0;
            }
        }

        String responseHeaders = new String(buffer.toByteArray(), "UTF-8");
        return responseHeaders.startsWith("HTTP/1.1 101") || responseHeaders.contains(" 101 ");
    }

    private void readFrames() throws Exception {
        while (shouldRun && isConnected) {
            int b1 = in.read();
            if (b1 == -1) break;

            int b2 = in.read();
            if (b2 == -1) break;

            int opcode = b1 & 0x0F;
            boolean masked = (b2 & 0x80) != 0;
            long payloadLen = b2 & 0x7F;

            if (payloadLen == 126) {
                byte[] lenBuf = new byte[2];
                readFully(lenBuf);
                payloadLen = ((lenBuf[0] & 0xFF) << 8) | (lenBuf[1] & 0xFF);
            } else if (payloadLen == 127) {
                byte[] lenBuf = new byte[8];
                readFully(lenBuf);
                payloadLen = 0;
                for (int i = 0; i < 8; i++) {
                    payloadLen = (payloadLen << 8) | (lenBuf[i] & 0xFF);
                }
            }

            if (payloadLen < 0 || payloadLen > Integer.MAX_VALUE) {
                throw new Exception("Frame too large: " + payloadLen);
            }

            byte[] mask = null;
            if (masked) {
                mask = new byte[4];
                readFully(mask);
            }

            byte[] payload = new byte[(int) payloadLen];
            readFully(payload);

            if (masked) {
                for (int i = 0; i < payload.length; i++) {
                    payload[i] ^= mask[i % 4];
                }
            }

            if (opcode == 0x1) { // Text Frame
                String text = new String(payload, "UTF-8");
                notifyMessage(text);
            } else if (opcode == 0x9) { // Ping
                sendFrame(0xA, payload); // Respond Pong
            } else if (opcode == 0x8) { // Close
                break;
            }
            // Binary (0x2), Pong (0xA) and continuation frames are ignored.
        }
    }

    /** Reads exactly buf.length bytes or throws EOFException if the stream ends first. */
    private void readFully(byte[] buf) throws Exception {
        int total = 0;
        while (total < buf.length) {
            int r = in.read(buf, total, buf.length - total);
            if (r == -1) {
                throw new EOFException("Stream closed while reading frame");
            }
            total += r;
        }
    }

    /**
     * Queues a text frame to be sent on the single-thread sender, preserving
     * message order (keyDown before keyUp) and never touching the main thread.
     */
    public void sendText(final String text) {
        if (!isConnected || text == null) return;
        ExecutorService executor = sendExecutor;
        if (executor == null) return;
        try {
            executor.execute(new Runnable() {
                @Override
                public void run() {
                    try {
                        byte[] data = text.getBytes("UTF-8");
                        sendFrame(0x1, data);
                    } catch (Exception e) {
                        Log.e(TAG, "Error sending text: " + e.getMessage());
                    }
                }
            });
        } catch (RejectedExecutionException e) {
            Log.w(TAG, "Send rejected, client is shutting down");
        }
    }

    private void sendFrame(int opcode, byte[] payload) throws Exception {
        OutputStream stream = out;
        if (stream == null || !isConnected) return;

        ByteArrayOutputStream frame = new ByteArrayOutputStream();
        frame.write(0x80 | (opcode & 0x0F)); // FIN + opcode

        int len = payload != null ? payload.length : 0;
        byte[] mask = new byte[4];
        random.nextBytes(mask);

        if (len <= 125) {
            frame.write(0x80 | len);
        } else if (len <= 65535) {
            frame.write(0x80 | 126);
            frame.write((len >> 8) & 0xFF);
            frame.write(len & 0xFF);
        } else {
            frame.write(0x80 | 127);
            for (int i = 7; i >= 0; i--) {
                frame.write((int) (((long) len >> (i * 8)) & 0xFF));
            }
        }

        frame.write(mask);

        if (payload != null) {
            byte[] maskedData = new byte[len];
            for (int i = 0; i < len; i++) {
                maskedData[i] = (byte) (payload[i] ^ mask[i % 4]);
            }
            frame.write(maskedData);
        }

        // Serialize writes: pong from the reader thread vs. text from the sender thread.
        synchronized (stream) {
            stream.write(frame.toByteArray());
            stream.flush();
        }
    }

    private void closeQuietly() {
        try {
            Socket s = socket;
            if (s != null && !s.isClosed()) s.close();
        } catch (Exception ignored) {}
    }

    private void notifyConnected() {
        mainHandler.post(new Runnable() {
            @Override
            public void run() {
                if (listener != null) listener.onConnected();
            }
        });
    }

    private void notifyMessage(final String msg) {
        mainHandler.post(new Runnable() {
            @Override
            public void run() {
                if (listener != null) listener.onMessage(msg);
            }
        });
    }

    private void notifyDisconnected(final String reason) {
        mainHandler.post(new Runnable() {
            @Override
            public void run() {
                if (listener != null) listener.onDisconnected(reason);
            }
        });
    }

    private void notifyError(final Throwable t) {
        mainHandler.post(new Runnable() {
            @Override
            public void run() {
                if (listener != null) listener.onError(t);
            }
        });
    }
}
