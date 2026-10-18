package com.matdeck.client.models;

import org.json.JSONObject;

public class KeyConfig {
    private static final String SLIDER_PREFIX = "vol_slider:";

    public int index;
    public String title = "";
    public String titleColor = "#E6E8EF";
    public int titleSize = 12;
    public String iconBase64 = null;
    public String badge = null;
    public String badgeColor = "#EF4444";
    public String actionId = "";
    public int state = 0;
    public boolean active = false;
    public String backgroundColor = "#15171E";
    public String borderColor = "#262A36";
    public boolean isSlider = false;
    public int sliderValue = 100;
    public String sliderApp = "";

    public KeyConfig(int index) {
        this.index = index;
    }

    /**
     * Builds a full config from a complete key object (loadProfile).
     * Fields absent from the JSON fall back to defaults.
     */
    public static KeyConfig fromJson(int index, JSONObject json) {
        KeyConfig key = new KeyConfig(index);
        if (json == null) return key;
        key.mergeFrom(json);
        return key;
    }

    /**
     * Merges a partial key object (updateKey) into this config.
     * Only fields present in the JSON are changed. A JSON null for
     * "icon" or "badge" clears the field; a JSON null for other string
     * fields is ignored and keeps the current value.
     */
    public void mergeFrom(JSONObject json) {
        if (json == null) return;

        if (json.has("title")) {
            String v = optStringOrNull(json, "title");
            title = v != null ? v : "";
        }
        if (json.has("titleColor")) {
            String v = optStringOrNull(json, "titleColor");
            if (v != null) titleColor = v;
        }
        if (json.has("titleSize")) {
            titleSize = json.optInt("titleSize", titleSize);
        }
        if (json.has("icon")) {
            String v = optStringOrNull(json, "icon");
            iconBase64 = (v == null || v.isEmpty()) ? null : v;
        }
        if (json.has("badge")) {
            String v = optStringOrNull(json, "badge");
            badge = (v == null || v.isEmpty()) ? null : v;
        }
        if (json.has("badgeColor")) {
            String v = optStringOrNull(json, "badgeColor");
            if (v != null) badgeColor = v;
        }
        if (json.has("actionId")) {
            String v = optStringOrNull(json, "actionId");
            actionId = v != null ? v : "";
        }
        if (json.has("state")) {
            state = json.optInt("state", state);
        }
        if (json.has("active")) {
            active = json.optBoolean("active", active);
        }
        if (json.has("bgColor")) {
            String v = optStringOrNull(json, "bgColor");
            if (v != null) backgroundColor = v;
        }
        if (json.has("borderColor")) {
            String v = optStringOrNull(json, "borderColor");
            if (v != null) borderColor = v;
        }
        if (json.has("isSlider")) {
            isSlider = json.optBoolean("isSlider", isSlider);
        }
        if (json.has("sliderApp")) {
            String v = optStringOrNull(json, "sliderApp");
            if (v != null) sliderApp = v;
        }
        if (actionId != null && actionId.startsWith(SLIDER_PREFIX)) {
            isSlider = true;
            if (sliderApp == null || sliderApp.isEmpty()) {
                sliderApp = actionId.substring(SLIDER_PREFIX.length());
            }
        }
        if (json.has("sliderValue")) {
            sliderValue = json.optInt("sliderValue", sliderValue);
        }
    }

    /**
     * Returns the string value for the key, or null when the key is absent
     * or holds a JSON null. Works around Android's optString returning the
     * literal "null" string for JSON null values.
     */
    private static String optStringOrNull(JSONObject json, String key) {
        if (json == null || !json.has(key) || json.isNull(key)) return null;
        Object value = json.opt(key);
        if (value == null) return null;
        return String.valueOf(value);
    }
}
