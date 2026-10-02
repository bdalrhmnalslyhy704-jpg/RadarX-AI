package com.radarx.ai;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.Path;
import android.view.View;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

public final class CandleChartView extends View {
    private static final int MAX_CANDLES = 240;
    private final List<BinanceMarketEngine.Candle> candles = new ArrayList<>(MAX_CANDLES);
    private final Paint gridPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint upPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint downPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint volumePaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint textPaint = new Paint(Paint.ANTI_ALIAS_FLAG);

    public CandleChartView(Context context) {
        super(context);
        setLayerType(View.LAYER_TYPE_SOFTWARE, null);

        gridPaint.setColor(0x2236D399);
        gridPaint.setStrokeWidth(dp(1));

        upPaint.setColor(0xFF36D399);
        upPaint.setStyle(Paint.Style.STROKE);
        upPaint.setStrokeWidth(dp(1.5f));

        downPaint.setColor(0xFFFF6B7A);
        downPaint.setStyle(Paint.Style.STROKE);
        downPaint.setStrokeWidth(dp(1.5f));

        volumePaint.setStyle(Paint.Style.FILL);
        textPaint.setColor(0xFF8FA5B5);
        textPaint.setTextSize(dp(9));
    }

    public void setHistory(List<BinanceMarketEngine.Candle> history) {
        candles.clear();
        if (history != null) {
            int start = Math.max(0, history.size() - MAX_CANDLES);
            for (int i = start; i < history.size(); i++) {
                candles.add(history.get(i));
            }
        }
        invalidate();
    }

    public void updateCandle(BinanceMarketEngine.Candle candle) {
        if (candle == null) return;

        if (!candles.isEmpty()) {
            int last = candles.size() - 1;
            BinanceMarketEngine.Candle current = candles.get(last);

            if (current.openTimeMs == candle.openTimeMs) {
                candles.set(last, candle);
                invalidate();
                return;
            }

            if (candle.openTimeMs < current.openTimeMs) return;
        }

        if (candles.size() >= MAX_CANDLES) candles.remove(0);
        candles.add(candle);
        invalidate();
    }

    @Override protected void onDraw(Canvas canvas) {
        super.onDraw(canvas);
        canvas.drawColor(0xFF07131A);

        float left = dp(8);
        float right = getWidth() - dp(8);
        float top = dp(10);
        float bottom = getHeight() - dp(18);
        float volumeTop = bottom - (bottom - top) * 0.24f;
        float chartBottom = volumeTop - dp(5);

        drawGrid(canvas, left, right, top, bottom);

        if (candles.size() < 2) {
            canvas.drawText(
                    "تحميل شموع 1m الحقيقية من Binance…",
                    left,
                    getHeight() - dp(6),
                    textPaint
            );
            return;
        }

        double minPrice = Double.POSITIVE_INFINITY;
        double maxPrice = Double.NEGATIVE_INFINITY;
        double maxVolume = 0.0;

        int visible = Math.min(90, candles.size());
        int startIndex = candles.size() - visible;

        for (int i = startIndex; i < candles.size(); i++) {
            BinanceMarketEngine.Candle c = candles.get(i);
            if (c.low > 0) minPrice = Math.min(minPrice, c.low);
            if (c.high > 0) maxPrice = Math.max(maxPrice, c.high);
            maxVolume = Math.max(maxVolume, c.volume);
        }

        if (!Double.isFinite(minPrice) || !Double.isFinite(maxPrice) || maxPrice <= 0) return;

        double range = Math.max(maxPrice - minPrice, maxPrice * 0.000001);
        double pad = range * 0.08;
        minPrice -= pad;
        maxPrice += pad;
        range = maxPrice - minPrice;

        float slot = (right - left) / Math.max(1, visible);
        float bodyWidth = Math.max(dp(2.5f), slot * 0.54f);

        for (int i = 0; i < visible; i++) {
            BinanceMarketEngine.Candle c = candles.get(startIndex + i);

            float x = left + slot * i + slot * 0.5f;
            float openY = priceY(c.open, minPrice, range, top, chartBottom);
            float closeY = priceY(c.close, minPrice, range, top, chartBottom);
            float highY = priceY(c.high, minPrice, range, top, chartBottom);
            float lowY = priceY(c.low, minPrice, range, top, chartBottom);

            Paint paint = c.close >= c.open ? upPaint : downPaint;

            canvas.drawLine(x, highY, x, lowY, paint);

            float bodyTop = Math.min(openY, closeY);
            float bodyBottom = Math.max(openY, closeY);

            if (Math.abs(bodyBottom - bodyTop) < dp(1.5f)) {
                bodyBottom = bodyTop + dp(1.5f);
            }

            if (c.close >= c.open) {
                canvas.drawRect(
                        x - bodyWidth * 0.5f, bodyTop,
                        x + bodyWidth * 0.5f, bodyBottom,
                        paint
                );
            } else {
                canvas.drawRect(
                        x - bodyWidth * 0.5f, bodyTop,
                        x + bodyWidth * 0.5f, bodyBottom,
                        paint
                );
            }

            if (maxVolume > 0 && c.volume > 0) {
                float volumeHeight = (float)(c.volume / maxVolume) * (bottom - volumeTop);
                float barTop = bottom - volumeHeight;
                volumePaint.setColor(c.close >= c.open ? 0x4036D399 : 0x40FF6B7A);
                canvas.drawRect(
                        x - bodyWidth * 0.5f, barTop,
                        x + bodyWidth * 0.5f, bottom,
                        volumePaint
                );
            }
        }

        BinanceMarketEngine.Candle last = candles.get(candles.size() - 1);
        String text = String.format(
                Locale.US,
                "1m  O %.2f  H %.2f  L %.2f  C %.2f",
                last.open, last.high, last.low, last.close
        );
        canvas.drawText(text, left, getHeight() - dp(5), textPaint);
    }

    private void drawGrid(Canvas canvas, float left, float right, float top, float bottom) {
        for (int i = 1; i < 5; i++) {
            float y = top + ((bottom - top) * i / 5f);
            canvas.drawLine(left, y, right, y, gridPaint);
        }
        float separator = bottom - (bottom - top) * 0.24f;
        canvas.drawLine(left, separator, right, separator, gridPaint);
    }

    private float priceY(
            double price,
            double min,
            double range,
            float top,
            float bottom
    ) {
        return bottom - (float)(((price - min) / range) * (bottom - top));
    }

    private float dp(float value) {
        return value * getResources().getDisplayMetrics().density;
    }
}
