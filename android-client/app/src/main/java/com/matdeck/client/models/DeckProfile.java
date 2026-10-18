package com.matdeck.client.models;

import org.json.JSONArray;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.List;

public class DeckProfile {
    public String id = "default";
    public String name = "Default";
    public int rows = 3;
    public int cols = 5;
    public boolean showHardwareHud = true;
    public List<KeyConfig> keys = new ArrayList<KeyConfig>();

    public static DeckProfile fromJson(JSONObject json) {
        DeckProfile profile = new DeckProfile();
        if (json == null) return profile;

        profile.id = json.optString("id", "default");
        profile.name = json.optString("name", "Default");
        profile.rows = json.optInt("rows", 3);
        profile.cols = json.optInt("cols", 5);
        profile.showHardwareHud = json.optBoolean("showHardwareHud", true);

        int totalKeys = profile.rows * profile.cols;
        for (int i = 0; i < totalKeys; i++) {
            profile.keys.add(new KeyConfig(i));
        }

        JSONArray keysArray = json.optJSONArray("keys");
        if (keysArray != null) {
            for (int i = 0; i < keysArray.length(); i++) {
                JSONObject keyObj = keysArray.optJSONObject(i);
                if (keyObj == null) continue;
                // Place the key by its own "index" field, falling back to the array position.
                int index = keyObj.optInt("index", i);
                if (index < 0 || index >= totalKeys) continue;
                profile.keys.set(index, KeyConfig.fromJson(index, keyObj));
            }
        }
        return profile;
    }
}
