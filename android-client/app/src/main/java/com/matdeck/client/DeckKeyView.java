package com.matdeck.client;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.RectF;
import android.graphics.drawable.GradientDrawable;
import android.os.Vibrator;
import android.text.TextUtils;
import android.util.Base64;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.TextView;

import com.matdeck.client.models.KeyConfig;

public class DeckKeyView extends FrameLayout {

    public interface OnKeyEventListener {
        void onKeyDown(int keyIndex);
        void onKeyUp(int keyIndex);
        void onSliderMoved(int keyIndex, String app, int value);
    }

    // Design tokens (same as the web panel)
    private static final int COLOR_SURFACE = Color.parseColor("#15171E");
    private static final int COLOR_SURFACE2 = Color.parseColor("#1B1E27");
    private static final int COLOR_BORDER = Color.parseColor("#262A36");
    private static final int COLOR_TEXT = Color.parseColor("#E6E8EF");
    private static final int COLOR_ACCENT = Color.parseColor("#4F8CFF");
    private static final int COLOR_DANGER = Color.parseColor("#EF4444");
    private static final int COLOR_DANGER_PRESSED = Color.parseColor("#DC2626");
    private static final int COLOR_DANGER_BORDER = Color.parseColor("#FCA5A5");

    private int keyIndex;
    private KeyConfig config;
    private OnKeyEventListener listener;
    private Vibrator vibrator;
    private final float density;

    private ImageView iconView;
    private TextView titleView;
    private TextView badgeView;
    private FrameLayout keyContent;

    // Slider & Touch Drag state
    private boolean isPressedState = false;
    private float touchStartY = 0f;
    private float touchStartX = 0f;
    private boolean isDraggingSlider = false;
    private int currentSliderValue = 100;

    // Level meter paint
    private Paint sliderMeterPaint;
    private RectF sliderRect = new RectF();

    public DeckKeyView(Context context, int keyIndex, OnKeyEventListener listener) {
        super(context);
        this.keyIndex = keyIndex;
        this.listener = listener;
        this.vibrator = (Vibrator) context.getSystemService(Context.VIBRATOR_SERVICE);
        this.config = new KeyConfig(keyIndex);
        this.density = context.getResources().getDisplayMetrics().density;

        setWillNotDraw(false);

        sliderMeterPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
        sliderMeterPaint.setColor(COLOR_ACCENT);
        sliderMeterPaint.setAlpha(64); // accent at 25%

        initView(context);
    }

    private int dp(float value) {
        return Math.round(value * density);
    }

    private void initView(Context context) {
        int outer = dp(2);
        setPadding(outer, outer, outer, outer);

        keyContent = new FrameLayout(context);
        LayoutParams contentParams = new LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
        );
        keyContent.setLayoutParams(contentParams);
        int inner = dp(6);
        keyContent.setPadding(inner, inner, inner, inner);
        updateBackground(false);

        // Icon View
        iconView = new ImageView(context);
        LayoutParams iconParams = new LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
        );
        iconParams.gravity = Gravity.CENTER;
        iconParams.setMargins(dp(8), dp(4), dp(8), dp(18));
        iconView.setLayoutParams(iconParams);
        iconView.setScaleType(ImageView.ScaleType.FIT_CENTER);
        keyContent.addView(iconView);

        // Title View
        titleView = new TextView(context);
        LayoutParams titleParams = new LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
        );
        titleParams.gravity = Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL;
        titleView.setLayoutParams(titleParams);
        titleView.setGravity(Gravity.CENTER);
        titleView.setTextSize(11);
        titleView.setTextColor(COLOR_TEXT);
        titleView.setSingleLine(true);
        titleView.setEllipsize(TextUtils.TruncateAt.END);
        keyContent.addView(titleView);

        // Badge View
        badgeView = new TextView(context);
        LayoutParams badgeParams = new LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
        );
        badgeParams.gravity = Gravity.TOP | Gravity.RIGHT;
        badgeView.setLayoutParams(badgeParams);
        badgeView.setPadding(dp(4), dp(1), dp(4), dp(1));
        badgeView.setTextSize(8.5f);
        badgeView.setTextColor(Color.WHITE);
        badgeView.setSingleLine(true);
        badgeView.setVisibility(View.GONE);
        keyContent.addView(badgeView);

        addView(keyContent);

        // Touch handling with slider gesture
        setOnTouchListener(new OnTouchListener() {
            @Override
            public boolean onTouch(View v, MotionEvent event) {
                switch (event.getAction()) {
                    case MotionEvent.ACTION_DOWN:
                        touchStartY = event.getY();
                        touchStartX = event.getX();
                        isDraggingSlider = false;
                        setPressedInternal(true);
                        vibrate(15);
                        return true;

                    case MotionEvent.ACTION_MOVE:
                        if (config != null && config.isSlider) {
                            float deltaY = Math.abs(event.getY() - touchStartY);
                            if (deltaY > 8 || isDraggingSlider) {
                                isDraggingSlider = true;
                                int height = getHeight();
                                if (height > 0) {
                                    float percent = (1.0f - (event.getY() / (float) height)) * 100f;
                                    int newVol = Math.max(0, Math.min(100, Math.round(percent)));
                                    if (newVol != currentSliderValue) {
                                        currentSliderValue = newVol;
                                        config.sliderValue = newVol;
                                        badgeView.setText(newVol + "%");
                                        badgeView.setVisibility(View.VISIBLE);
                                        postInvalidate();

                                        if (listener != null) {
                                            listener.onSliderMoved(keyIndex, config.sliderApp, newVol);
                                        }
                                    }
                                }
                                return true;
                            }
                        }
                        break;

                    case MotionEvent.ACTION_UP:
                    case MotionEvent.ACTION_CANCEL:
                        setPressedInternal(false);
                        if (!isDraggingSlider) {
                            if (listener != null) {
                                listener.onKeyDown(keyIndex);
                                listener.onKeyUp(keyIndex);
                            }
                        }
                        isDraggingSlider = false;
                        return true;
                }
                return false;
            }
        });
    }

    @Override
    protected void onDraw(Canvas canvas) {
        super.onDraw(canvas);

        // If it's a volume slider, draw live level meter fill inside
        if (config != null && config.isSlider) {
            int w = getWidth();
            int h = getHeight();
            if (w > 0 && h > 0) {
                int inset = dp(3);
                float fillHeight = (currentSliderValue / 100f) * (h - inset * 2);
                sliderRect.set(inset, h - inset - fillHeight, w - inset, h - inset);
                float r = cornerRadiusFor(h) - dp(1);
                canvas.drawRoundRect(sliderRect, r, r, sliderMeterPaint);
            }
        }
    }

    private void vibrate(int ms) {
        if (vibrator != null) {
            try {
                vibrator.vibrate(ms);
            } catch (Exception ignored) {}
        }
    }

    private void setPressedInternal(boolean pressed) {
        if (this.isPressedState != pressed) {
            this.isPressedState = pressed;
            updateBackground(pressed);
            if (pressed) {
                keyContent.setScaleX(0.97f);
                keyContent.setScaleY(0.97f);
            } else {
                keyContent.setScaleX(1.0f);
                keyContent.setScaleY(1.0f);
            }
        }
    }

    /** 12dp radius on normal keys, shrinking proportionally on very short keys. */
    private float cornerRadiusFor(int h) {
        float max = dp(12);
        if (h <= 0) return max;
        return Math.max(dp(6), Math.min(max, h * 0.10f));
    }

    /** True for the legacy default colors the server still sends when nothing custom is set. */
    private static boolean isLegacyDefault(String color) {
        if (color == null) return true;
        String c = color.trim().toUpperCase();
        return c.isEmpty()
                || "#1C1D25".equals(c) || "#2D303E".equals(c)
                || "#15171E".equals(c) || "#262A36".equals(c);
    }

    private static boolean isDefaultTitleColor(String color) {
        if (color == null) return true;
        String c = color.trim().toUpperCase();
        return c.isEmpty() || "#FFFFFF".equals(c) || "#FFF".equals(c) || "#E6E8EF".equals(c);
    }

    private void updateBackground(boolean pressed) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setShape(GradientDrawable.RECTANGLE);
        drawable.setCornerRadius(cornerRadiusFor(getHeight()));

        int bgColor = COLOR_SURFACE;
        int strokeColor = COLOR_BORDER;
        int strokeWidth = Math.max(1, dp(1));

        boolean isMuted = false;

        if (config != null) {
            // Muted heuristic: solid red background from server, or MUDO/MUTADO badge/title.
            if ("#DC2626".equalsIgnoreCase(config.backgroundColor) ||
                "MUDO".equalsIgnoreCase(config.badge) ||
                "MUTADO".equalsIgnoreCase(config.badge) ||
                (config.title != null && config.title.toUpperCase().contains("MUTADO"))) {
                isMuted = true;
            }

            if (isMuted) {
                bgColor = COLOR_DANGER;
                strokeColor = COLOR_DANGER;
            } else {
                if (!isLegacyDefault(config.backgroundColor)) {
                    try {
                        bgColor = Color.parseColor(config.backgroundColor);
                    } catch (Exception ignored) {}
                }
                if (!isLegacyDefault(config.borderColor)) {
                    try {
                        strokeColor = Color.parseColor(config.borderColor);
                    } catch (Exception ignored) {}
                }
                if (config.active) {
                    strokeColor = COLOR_ACCENT;
                    strokeWidth = dp(2);
                }
            }
        }

        if (pressed) {
            if (isMuted) {
                bgColor = COLOR_DANGER_PRESSED;
                strokeColor = COLOR_DANGER_BORDER;
            } else {
                bgColor = COLOR_SURFACE2;
                strokeColor = COLOR_ACCENT;
            }
            strokeWidth = dp(2);
        }

        drawable.setColor(bgColor);
        drawable.setStroke(strokeWidth, strokeColor);
        keyContent.setBackgroundDrawable(drawable);
    }

    public void updateConfig(KeyConfig newConfig) {
        this.config = newConfig;
        this.currentSliderValue = config.sliderValue;

        // Dynamic Text Size based on screen & height
        int h = getHeight();
        if (h > 0) {
            titleView.setTextSize(titleSizeFor(h));
        }

        // Title
        if (config.title != null && !config.title.isEmpty()) {
            titleView.setText(config.title);
            titleView.setVisibility(View.VISIBLE);
            if (isDefaultTitleColor(config.titleColor)) {
                titleView.setTextColor(COLOR_TEXT);
            } else {
                try {
                    titleView.setTextColor(Color.parseColor(config.titleColor));
                } catch (Exception e) {
                    titleView.setTextColor(COLOR_TEXT);
                }
            }
        } else {
            titleView.setText("");
        }

        // Icon
        if (config.iconBase64 != null && !config.iconBase64.isEmpty()) {
            try {
                String cleanBase64 = config.iconBase64;
                if (cleanBase64.contains(",")) {
                    cleanBase64 = cleanBase64.substring(cleanBase64.indexOf(",") + 1);
                }
                byte[] decoded = Base64.decode(cleanBase64, Base64.DEFAULT);
                Bitmap bitmap = BitmapFactory.decodeByteArray(decoded, 0, decoded.length);
                if (bitmap != null) {
                    iconView.setImageBitmap(bitmap);
                    iconView.setVisibility(View.VISIBLE);
                } else {
                    iconView.setImageDrawable(null);
                }
            } catch (Exception e) {
                iconView.setImageDrawable(null);
            }
        } else {
            iconView.setImageDrawable(null);
        }

        // Badge
        if (config.badge != null && !config.badge.isEmpty()) {
            badgeView.setText(config.badge);
            badgeView.setVisibility(View.VISIBLE);

            GradientDrawable badgeBg = new GradientDrawable();
            badgeBg.setShape(GradientDrawable.RECTANGLE);
            badgeBg.setCornerRadius(dp(6));
            try {
                badgeBg.setColor(Color.parseColor(config.badgeColor));
            } catch (Exception e) {
                badgeBg.setColor(COLOR_DANGER);
            }
            badgeView.setBackgroundDrawable(badgeBg);
        } else {
            badgeView.setVisibility(View.GONE);
        }

        updateBackground(isPressedState);
        postInvalidate();
    }

    private float titleSizeFor(int h) {
        // h is in px; keep the title readable on 7" (1024x600) and 10.1" screens
        float sp = (h / density) * 0.11f;
        return Math.max(9.5f, Math.min(14f, sp));
    }

    @Override
    protected void onSizeChanged(int w, int h, int oldw, int oldh) {
        super.onSizeChanged(w, h, oldw, oldh);
        if (h > 0) {
            titleView.setTextSize(titleSizeFor(h));

            // Icon margins proportional to the key size
            LayoutParams lp = (LayoutParams) iconView.getLayoutParams();
            if (lp != null) {
                int side = Math.max(dp(6), (int) (w * 0.12f));
                int top = Math.max(dp(4), (int) (h * 0.08f));
                int bottom = Math.max(dp(16), (int) (h * 0.22f));
                lp.setMargins(side, top, side, bottom);
                iconView.setLayoutParams(lp);
            }
            updateBackground(isPressedState);
        }
    }

    public int getKeyIndex() {
        return keyIndex;
    }

    public KeyConfig getConfig() {
        return config;
    }
}
