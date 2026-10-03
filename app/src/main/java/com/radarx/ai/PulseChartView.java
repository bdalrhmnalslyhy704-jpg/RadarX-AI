package com.radarx.ai;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.RectF;
import android.view.View;

import java.util.ArrayDeque;
import java.util.Deque;

public final class PulseChartView extends View {
    private static final int MAX_POINTS = 120;

    private final Paint gridPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint linePaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint fillPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint textPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Path line = new Path();
    private final Path fill = new Path();
    private final Deque<Double> values = new ArrayDeque<>(MAX_POINTS);

    public PulseChartView(Context context) {
        super(context);
        setLayerType(View.LAYER_TYPE_SOFTWARE, null);

        gridPaint.setColor(0x2236D399);
        gridPaint.setStrokeWidth(dp(1));

        linePaint.setColor(0xFF36D399);
        linePaint.setStyle(Paint.Style.STROKE);
        linePaint.setStrokeWidth(dp(2));
        linePaint.setShadowLayer(dp(5), 0, 0, 0x6636D399);

        fillPaint.setColor(0x1536D399);
        fillPaint.setStyle(Paint.Style.FILL);

        textPaint.setColor(0xFF94A3B8);
        textPaint.setTextSize(dp(10));
    }

    public void addValue(double value) {
        if (!Double.isFinite(value) || value <= 0.0) return;
        if (values.size() >= MAX_POINTS) values.removeFirst();
        values.addLast(value);
        invalidate();
    }

    public void clearValues() {
        values.clear();
        invalidate();
    }

    @Override protected void onDraw(Canvas canvas) {
        super.onDraw(canvas);
        float left = dp(10);
        float right = getWidth() - dp(10);
        float top = dp(10);
        float bottom = getHeight() - dp(16);

        canvas.drawColor(0xFF07131A);

        for (int i = 1; i < 4; i++) {
            float y = top + ((bottom - top) * i / 4f);
            canvas.drawLine(left, y, right, y, gridPaint);
        }

        if (values.size() < 2) {
            canvas.drawText("في انتظار أول نبضة سعرية…", left, getHeight() - dp(6), textPaint);
            return;
        }

        double min = Double.POSITIVE_INFINITY;
        double max = Double.NEGATIVE_INFINITY;
        for (double value : values) {
            min = Math.min(min, value);
            max = Math.max(max, value);
        }
        double range = max - min;
        if (range <= 0.0) range = Math.max(0.00000001, max * 0.000001);
        double pad = range * 0.08;
        min -= pad;
        max += pad;
        range = max - min;

        line.reset();
        fill.reset();

        int n = values.size();
        int index = 0;
        for (double value : values) {
            float x = left + ((right - left) * index / (float)(n - 1));
            float y = bottom - (float)(((value - min) / range) * (bottom - top));
            if (index == 0) {
                line.moveTo(x, y);
                fill.moveTo(x, bottom);
                fill.lineTo(x, y);
            } else {
                line.lineTo(x, y);
                fill.lineTo(x, y);
            }
            if (index == n - 1) fill.lineTo(x, bottom);
            index++;
        }
        fill.close();

        canvas.drawPath(fill, fillPaint);
        canvas.drawPath(line, linePaint);
        canvas.drawText("LIVE", left, getHeight() - dp(6), textPaint);
    }

    private float dp(float value) {
        return value * getResources().getDisplayMetrics().density;
    }
}
