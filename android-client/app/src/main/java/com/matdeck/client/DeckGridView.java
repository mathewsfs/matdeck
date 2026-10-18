package com.matdeck.client;

import android.content.Context;
import android.view.ViewGroup;

import com.matdeck.client.models.DeckProfile;
import com.matdeck.client.models.KeyConfig;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

public class DeckGridView extends ViewGroup {

    private int rows = 3;
    private int cols = 5;
    private List<DeckKeyView> keyViews = new ArrayList<DeckKeyView>();
    private DeckKeyView.OnKeyEventListener keyEventListener;

    public DeckGridView(Context context, DeckKeyView.OnKeyEventListener listener) {
        super(context);
        this.keyEventListener = listener;
        setupGrid(3, 5);
    }

    public void setupGrid(int newRows, int newCols) {
        if (this.rows == newRows && this.cols == newCols && keyViews.size() == (newRows * newCols)) {
            return;
        }

        this.rows = newRows;
        this.cols = newCols;
        removeAllViews();
        keyViews.clear();

        int totalKeys = rows * cols;
        for (int i = 0; i < totalKeys; i++) {
            DeckKeyView keyView = new DeckKeyView(getContext(), i, keyEventListener);
            keyViews.add(keyView);
            addView(keyView);
        }
        requestLayout();
    }

    public void applyProfile(DeckProfile profile) {
        setupGrid(profile.rows, profile.cols);
        for (int i = 0; i < keyViews.size(); i++) {
            if (i < profile.keys.size()) {
                keyViews.get(i).updateConfig(profile.keys.get(i));
            } else {
                keyViews.get(i).updateConfig(new KeyConfig(i));
            }
        }
    }

    /**
     * Merges a partial key update into the existing config of the key
     * (only fields present in the JSON change) and re-renders it.
     */
    public void updateKey(int keyIndex, JSONObject partial) {
        if (partial == null || keyIndex < 0 || keyIndex >= keyViews.size()) return;
        DeckKeyView keyView = keyViews.get(keyIndex);
        KeyConfig config = keyView.getConfig();
        if (config == null) {
            config = new KeyConfig(keyIndex);
        }
        config.mergeFrom(partial);
        keyView.updateConfig(config);
    }

    @Override
    protected void onMeasure(int widthMeasureSpec, int heightMeasureSpec) {
        int width = MeasureSpec.getSize(widthMeasureSpec);
        int height = MeasureSpec.getSize(heightMeasureSpec);

        // Adaptive spacing: 4px on narrow screens, 8px on large 10.1" screens
        int spacing = (height <= 550 || width <= 1024) ? 4 : 8;

        int totalHorizontalSpacing = spacing * Math.max(0, cols - 1);
        int totalVerticalSpacing = spacing * Math.max(0, rows - 1);

        int cellWidth = (cols > 0) ? Math.max(0, (width - totalHorizontalSpacing) / cols) : 0;
        int cellHeight = (rows > 0) ? Math.max(0, (height - totalVerticalSpacing) / rows) : 0;

        for (int i = 0; i < getChildCount(); i++) {
            DeckKeyView child = (DeckKeyView) getChildAt(i);
            int childWidthSpec = MeasureSpec.makeMeasureSpec(cellWidth, MeasureSpec.EXACTLY);
            int childHeightSpec = MeasureSpec.makeMeasureSpec(cellHeight, MeasureSpec.EXACTLY);
            child.measure(childWidthSpec, childHeightSpec);
        }

        setMeasuredDimension(width, height);
    }

    @Override
    protected void onLayout(boolean changed, int l, int t, int r, int b) {
        int width = r - l;
        int height = b - t;

        int spacing = (height <= 550 || width <= 1024) ? 4 : 8;

        int totalHorizontalSpacing = spacing * Math.max(0, cols - 1);
        int totalVerticalSpacing = spacing * Math.max(0, rows - 1);

        int cellWidth = (cols > 0) ? Math.max(0, (width - totalHorizontalSpacing) / cols) : 0;
        int cellHeight = (rows > 0) ? Math.max(0, (height - totalVerticalSpacing) / rows) : 0;

        // Center entire grid within available bounds
        int usedW = (cellWidth * cols) + totalHorizontalSpacing;
        int usedH = (cellHeight * rows) + totalVerticalSpacing;
        int offsetX = Math.max(0, (width - usedW) / 2);
        int offsetY = Math.max(0, (height - usedH) / 2);

        for (int i = 0; i < getChildCount(); i++) {
            int row = i / cols;
            int col = i % cols;

            int left = offsetX + (col * (cellWidth + spacing));
            int top = offsetY + (row * (cellHeight + spacing));
            int right = left + cellWidth;
            int bottom = top + cellHeight;

            getChildAt(i).layout(left, top, right, bottom);
        }
    }
}
