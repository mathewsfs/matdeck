package com.matdeck.client;

import android.content.Context;
import android.content.res.Resources;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.os.Handler;
import android.os.Looper;
import android.os.Vibrator;
import android.view.View;
import android.widget.TextView;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * Top overlay banner for server notifications ({event:'notify'}).
 * At most one banner is visible; the rest wait in a small FIFO queue.
 * A "poke" replaces whatever is on screen and vibrates.
 */
public class NotifyBanner {

    private static final long DEFAULT_TTL_MS = 5000;
    private static final long MIN_TTL_MS = 1000;
    private static final long MAX_TTL_MS = 30000;
    private static final int MAX_QUEUE = 8;
    private static final long FADE_IN_MS = 160;
    private static final long FADE_OUT_MS = 220;

    private static class Notification {
        final String id;
        final String title;
        final String text;
        final String level;
        final long ttlMs;

        Notification(String id, String title, String text, String level, long ttlMs) {
            this.id = id;
            this.title = title;
            this.text = text;
            this.level = level;
            this.ttlMs = ttlMs;
        }
    }

    private final View root;
    private final View iconView;
    private final TextView titleView;
    private final TextView textView;
    private final Vibrator vibrator;
    private final Resources res;
    private final float density;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final List<Notification> queue = new ArrayList<Notification>();
    private Notification current = null;
    private boolean hiding = false;

    private final Runnable autoHide = new Runnable() {
        @Override
        public void run() {
            hide();
        }
    };

    public NotifyBanner(Context context, View root, View iconView, TextView titleView, TextView textView) {
        this.root = root;
        this.iconView = iconView;
        this.titleView = titleView;
        this.textView = textView;
        this.res = context.getResources();
        this.density = res.getDisplayMetrics().density;
        this.vibrator = (Vibrator) context.getSystemService(Context.VIBRATOR_SERVICE);

        root.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                hide();
            }
        });
    }

    /** Entry point for a {event:'notify'} message. Safe to call from the main thread only. */
    public void handle(JSONObject msg) {
        if (msg == null) return;
        String title = optString(msg, "title");
        String text = optString(msg, "text");
        if (title.isEmpty() && text.isEmpty()) return;

        String id = optString(msg, "id");
        String level = optString(msg, "level");
        if (!"poke".equals(level) && !"warn".equals(level) && !"success".equals(level)) {
            level = "info";
        }
        long ttl = msg.optLong("ttlMs", DEFAULT_TTL_MS);
        if (ttl <= 0) ttl = DEFAULT_TTL_MS;
        ttl = Math.max(MIN_TTL_MS, Math.min(MAX_TTL_MS, ttl));

        Notification n = new Notification(id, title, text, level, ttl);

        // Ignore duplicates (same id already visible or queued).
        if (!id.isEmpty()) {
            if (current != null && id.equals(current.id)) return;
            for (int i = 0; i < queue.size(); i++) {
                if (id.equals(queue.get(i).id)) return;
            }
        }

        if ("poke".equals(level)) {
            vibratePoke();
            // A poke jumps the queue and replaces whatever is on screen.
            handler.removeCallbacks(autoHide);
            root.animate().cancel();
            hiding = false;
            current = null;
            show(n);
            return;
        }

        if (current == null && !hiding) {
            show(n);
        } else {
            if (queue.size() >= MAX_QUEUE) queue.remove(0);
            queue.add(n);
        }
    }

    private void show(Notification n) {
        current = n;
        applyStyle(n.level);

        titleView.setText(n.title);
        titleView.setVisibility(n.title.isEmpty() ? View.GONE : View.VISIBLE);
        textView.setText(n.text);
        textView.setVisibility(n.text.isEmpty() ? View.GONE : View.VISIBLE);

        boolean alreadyVisible = root.getVisibility() == View.VISIBLE && root.getAlpha() > 0.5f;
        if (!alreadyVisible) {
            root.setAlpha(0f);
            root.setVisibility(View.VISIBLE);
            root.animate().alpha(1f).setDuration(FADE_IN_MS).setListener(null).start();
        } else {
            root.setAlpha(1f);
        }

        handler.removeCallbacks(autoHide);
        handler.postDelayed(autoHide, n.ttlMs);
    }

    private void hide() {
        if (current == null || hiding) return;
        hiding = true;
        handler.removeCallbacks(autoHide);
        root.animate().cancel();
        root.animate().alpha(0f).setDuration(FADE_OUT_MS).withEndAction(new Runnable() {
            @Override
            public void run() {
                root.setVisibility(View.GONE);
                hiding = false;
                current = null;
                showNext();
            }
        }).start();
    }

    private void showNext() {
        if (queue.isEmpty()) return;
        show(queue.remove(0));
    }

    private void applyStyle(String level) {
        int bg;
        int stroke;
        int titleColor;
        int textColor;
        int iconColor;

        if ("poke".equals(level)) {
            bg = res.getColor(R.color.accent);
            stroke = bg;
            titleColor = Color.WHITE;
            textColor = withAlpha(Color.WHITE, 0.85f);
            iconColor = Color.WHITE;
        } else if ("warn".equals(level)) {
            bg = res.getColor(R.color.warn);
            stroke = bg;
            titleColor = Color.parseColor("#1A1300");
            textColor = withAlpha(Color.parseColor("#1A1300"), 0.8f);
            iconColor = Color.parseColor("#1A1300");
        } else if ("success".equals(level)) {
            bg = res.getColor(R.color.success);
            stroke = bg;
            titleColor = Color.parseColor("#07200F");
            textColor = withAlpha(Color.parseColor("#07200F"), 0.8f);
            iconColor = Color.parseColor("#07200F");
        } else {
            bg = res.getColor(R.color.surface2);
            stroke = res.getColor(R.color.border);
            titleColor = res.getColor(R.color.text);
            textColor = res.getColor(R.color.muted);
            iconColor = res.getColor(R.color.accent);
        }

        GradientDrawable shape = new GradientDrawable();
        shape.setShape(GradientDrawable.RECTANGLE);
        shape.setCornerRadius(12f * density);
        shape.setColor(bg);
        shape.setStroke(Math.max(1, (int) density), stroke);
        root.setBackgroundDrawable(shape);

        GradientDrawable dot = new GradientDrawable();
        dot.setShape(GradientDrawable.OVAL);
        dot.setColor(iconColor);
        iconView.setBackgroundDrawable(dot);

        titleView.setTextColor(titleColor);
        textView.setTextColor(textColor);
    }

    private void vibratePoke() {
        if (vibrator == null) return;
        try {
            vibrator.vibrate(new long[]{0, 70, 90, 70}, -1);
        } catch (Exception ignored) {}
    }

    private static int withAlpha(int color, float alpha) {
        return Color.argb(Math.round(255 * alpha), Color.red(color), Color.green(color), Color.blue(color));
    }

    private static String optString(JSONObject json, String key) {
        if (json == null || !json.has(key) || json.isNull(key)) return "";
        Object value = json.opt(key);
        return value == null ? "" : String.valueOf(value);
    }
}
