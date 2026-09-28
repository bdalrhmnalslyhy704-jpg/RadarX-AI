package com.radarx.ai;

import android.app.Activity;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

public final class MainActivity extends Activity implements BinanceMarketEngine.Listener {
    private static final int BG = 0xFF050A0F;
    private static final int PANEL = 0xFF0A151C;
    private static final int PANEL_2 = 0xFF0D1B23;
    private static final int TEXT = 0xFFE6EDF3;
    private static final int MUTED = 0xFF8FA5B5;
    private static final int LIVE = 0xFF36D399;
    private static final int WARN = 0xFFF6C85F;
    private static final int ERROR = 0xFFFF6B6B;
    private static final int DOWN = 0xFFFF7A88;

    private final Handler main = new Handler(Looper.getMainLooper());
    private final BinanceMarketEngine engine = new BinanceMarketEngine();
    private final Map<String, BinanceMarketEngine.Snapshot> latestBySymbol =
            new ConcurrentHashMap<>();
    private final Map<String, TextView> priceRows = new ConcurrentHashMap<>();
    private final Map<String, TextView> changeRows = new ConcurrentHashMap<>();

    private NetworkMonitor networkMonitor;

    private TextView connectionView;
    private TextView connectionDetailView;
    private TextView priceView;
    private TextView changeView;
    private TextView bidView;
    private TextView askView;
    private TextView spreadView;
    private TextView latencyView;
    private TextView updatesView;
    private TextView reconnectView;
    private TextView volumeView;
    private TextView updateTimeView;
    private TextView cacheView;
    private TextView selectedSymbolView;
    private Button actionButton;
    private CandleChartView chartView;

    private String selectedSymbol = "BTCUSDT";
    private boolean renderQueued;
    private boolean userStopped;
    private boolean destroyed;

    @Override protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(BG);
        getWindow().setNavigationBarColor(BG);

        networkMonitor = new NetworkMonitor(this, available -> {
            engine.setNetworkAvailable(available);
            main.post(() -> {
                if (destroyed) return;
                if (!available) {
                    cacheView.setText("الشبكة غير متاحة • البيانات الحية متوقفة مؤقتًا");
                    cacheView.setTextColor(WARN);
                }
            });
        });

        engine.setListener(this);
        setContentView(buildScreen());
    }

    private View buildScreen() {
        ScrollView scroll = new ScrollView(this);
        scroll.setBackgroundColor(BG);
        scroll.setFillViewport(true);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(14), dp(12), dp(14), dp(24));
        root.setLayoutDirection(View.LAYOUT_DIRECTION_RTL);
        scroll.addView(root);

        LinearLayout header = new LinearLayout(this);
        header.setGravity(Gravity.CENTER_VERTICAL);
        header.setOrientation(LinearLayout.HORIZONTAL);

        TextView brand = text("RadarX", 26, TEXT, true);
        brand.setGravity(Gravity.START | Gravity.CENTER_VERTICAL);
        header.addView(brand, new LinearLayout.LayoutParams(0, dp(48), 1));

        TextView badge = text("NATIVE 6.4", 10, LIVE, true);
        badge.setGravity(Gravity.CENTER);
        badge.setPadding(dp(10), dp(6), dp(10), dp(6));
        badge.setBackground(round(PANEL_2, dp(14)));
        header.addView(badge, new LinearLayout.LayoutParams(dp(96), dp(34)));
        root.addView(header);

        root.addView(text("Live Trading Core • Binance Spot", 12, MUTED, false),
                new LinearLayout.LayoutParams(-1, dp(24)));

        LinearLayout statusCard = panel(PANEL);
        statusCard.setPadding(dp(14), dp(10), dp(14), dp(10));
        connectionView = text("● جاري التهيئة", 13, WARN, true);
        connectionDetailView = text("بناء قناة السوق الحية…", 11, MUTED, false);
        statusCard.addView(connectionView, new LinearLayout.LayoutParams(-1, dp(24)));
        statusCard.addView(connectionDetailView, new LinearLayout.LayoutParams(-1, dp(22)));
        root.addView(statusCard, marginTop(10));

        cacheView = text("12 زوجًا • WebSocket واحد • REST bootstrap واحد", 10, MUTED, false);
        cacheView.setPadding(dp(4), dp(6), dp(4), dp(2));
        root.addView(cacheView);

        LinearLayout selectedCard = panel(PANEL_2);
        selectedCard.setPadding(dp(16), dp(14), dp(16), dp(14));

        selectedSymbolView = text("BTC / USDT", 14, MUTED, true);
        selectedSymbolView.setGravity(Gravity.CENTER_HORIZONTAL);
        selectedCard.addView(selectedSymbolView, new LinearLayout.LayoutParams(-1, dp(24)));

        priceView = text("--", 34, TEXT, true);
        priceView.setTypeface(Typeface.create(Typeface.MONOSPACE, Typeface.BOLD));
        priceView.setGravity(Gravity.CENTER_HORIZONTAL);
        selectedCard.addView(priceView, new LinearLayout.LayoutParams(-1, dp(54)));

        TextView lastLabel = text("آخر صفقة • Live", 10, MUTED, false);
        lastLabel.setGravity(Gravity.CENTER_HORIZONTAL);
        selectedCard.addView(lastLabel, new LinearLayout.LayoutParams(-1, dp(20)));

        changeView = text("تغير 24س: --", 12, MUTED, true);
        changeView.setGravity(Gravity.CENTER_HORIZONTAL);
        selectedCard.addView(changeView, new LinearLayout.LayoutParams(-1, dp(24)));
        root.addView(selectedCard, marginTop(10));

        LinearLayout quotes = new LinearLayout(this);
        quotes.setOrientation(LinearLayout.HORIZONTAL);
        quotes.setWeightSum(2f);
        bidView = quoteCard(quotes, "BID", LIVE);
        askView = quoteCard(quotes, "ASK", DOWN);
        root.addView(quotes, marginTop(10));

        LinearLayout chartHeader = panel(PANEL);
        chartHeader.setPadding(dp(12), dp(8), dp(12), dp(8));
        TextView chartTitle = text("PRICE CHART", 12, LIVE, true);
        TextView chartInfo = text("شموع 1m حقيقية • التاريخ من REST • التحديث من WebSocket", 10, MUTED, false);
        chartHeader.addView(chartTitle, new LinearLayout.LayoutParams(-1, dp(20)));
        chartHeader.addView(chartInfo, new LinearLayout.LayoutParams(-1, dp(20)));
        root.addView(chartHeader, marginTop(10));

        chartView = new CandleChartView(this);
        root.addView(chartView, marginTop(4, -1, dp(250)));

        LinearLayout metricsRow1 = new LinearLayout(this);
        metricsRow1.setOrientation(LinearLayout.HORIZONTAL);
        metricsRow1.setWeightSum(3f);
        latencyView = metricCard(metricsRow1, "LATENCY", "--");
        updatesView = metricCard(metricsRow1, "UPDATES", "0");
        reconnectView = metricCard(metricsRow1, "RECONNECTS", "0");
        root.addView(metricsRow1, marginTop(10));

        LinearLayout metricsRow2 = new LinearLayout(this);
        metricsRow2.setOrientation(LinearLayout.HORIZONTAL);
        metricsRow2.setWeightSum(2f);
        spreadView = metricCard(metricsRow2, "SPREAD", "--");
        volumeView = metricCard(metricsRow2, "24H QUOTE VOL", "--");
        root.addView(metricsRow2, marginTop(8));

        updateTimeView = text("آخر تحديث: --", 10, MUTED, false);
        updateTimeView.setGravity(Gravity.CENTER);
        root.addView(updateTimeView, marginTop(8));

        LinearLayout radarHeader = panel(PANEL);
        radarHeader.setPadding(dp(12), dp(10), dp(12), dp(10));
        TextView radarTitle = text("LIVE RADAR", 13, LIVE, true);
        TextView radarSub = text("12 أزواج • قناة واحدة • اضغط للتبديل", 10, MUTED, false);
        radarHeader.addView(radarTitle, new LinearLayout.LayoutParams(-1, dp(22)));
        radarHeader.addView(radarSub, new LinearLayout.LayoutParams(-1, dp(20)));
        root.addView(radarHeader, marginTop(12));

        LinearLayout list = new LinearLayout(this);
        list.setOrientation(LinearLayout.VERTICAL);
        for (String symbol : BinanceMarketEngine.SYMBOLS) {
            list.addView(createRadarRow(symbol));
        }
        root.addView(list, marginTop(8));

        actionButton = new Button(this);
        actionButton.setText("إيقاف البث");
        actionButton.setTextColor(TEXT);
        actionButton.setTextSize(12);
        actionButton.setAllCaps(false);
        actionButton.setBackground(round(PANEL_2, dp(12)));
        actionButton.setOnClickListener(v -> {
            userStopped = !userStopped;
            if (userStopped) {
                engine.stop();
                actionButton.setText("تشغيل البث");
            } else {
                startEngine();
                actionButton.setText("إيقاف البث");
            }
        });
        root.addView(actionButton, marginTop(12, -1, dp(48)));

        TextView source = text(
                "السوق: Binance Spot فقط • لا Futures ولا Leverage • لا أسعار وهمية. "
                        + "النواة مفصولة عن واجهة التحليل لتبقى الاستجابة مستقرة.",
                10, MUTED, false
        );
        source.setGravity(Gravity.CENTER);
        source.setPadding(dp(5), dp(12), dp(5), 0);
        root.addView(source);

        return scroll;
    }

    private View createRadarRow(String symbol) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(dp(12), dp(7), dp(12), dp(7));
        row.setBackground(round(PANEL, dp(12)));

        TextView pair = text(displaySymbol(symbol), 13, TEXT, true);
        row.addView(pair, new LinearLayout.LayoutParams(dp(86), dp(42)));

        LinearLayout values = new LinearLayout(this);
        values.setOrientation(LinearLayout.VERTICAL);
        values.setGravity(Gravity.CENTER_VERTICAL);

        TextView price = text("--", 13, TEXT, true);
        price.setTypeface(Typeface.create(Typeface.MONOSPACE, Typeface.BOLD));
        TextView change = text("--", 10, MUTED, true);

        values.addView(price, new LinearLayout.LayoutParams(-1, dp(22)));
        values.addView(change, new LinearLayout.LayoutParams(-1, dp(18)));

        row.addView(values, new LinearLayout.LayoutParams(0, dp(42), 1f));
        TextView arrow = text("›", 20, MUTED, true);
        arrow.setGravity(Gravity.CENTER);
        row.addView(arrow, new LinearLayout.LayoutParams(dp(28), dp(42)));

        priceRows.put(symbol, price);
        changeRows.put(symbol, change);

        row.setOnClickListener(v -> selectSymbol(symbol));
        row.setOnLongClickListener(v -> {
            selectSymbol(symbol);
            return true;
        });

        LinearLayout wrapper = new LinearLayout(this);
        wrapper.setOrientation(LinearLayout.VERTICAL);
        wrapper.addView(row);
        wrapper.setPadding(0, 0, 0, dp(6));
        return wrapper;
    }

    private void selectSymbol(String symbol) {
        selectedSymbol = symbol;
        selectedSymbolView.setText(displaySymbol(symbol));
        chartView.setHistory(null);
        engine.setSelectedSymbol(symbol);

        BinanceMarketEngine.Snapshot s = latestBySymbol.get(symbol);
        if (s != null) renderFocus(s);
    }

    private TextView quoteCard(LinearLayout parent, String title, int accent) {
        LinearLayout card = panel(PANEL);
        card.setPadding(dp(12), dp(10), dp(12), dp(10));

        TextView t = text(title, 10, accent, true);
        TextView v = text("--", 17, TEXT, true);
        v.setTypeface(Typeface.create(Typeface.MONOSPACE, Typeface.BOLD));

        card.addView(t);
        card.addView(v, new LinearLayout.LayoutParams(-1, dp(30)));

        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(0, dp(72), 1f);
        lp.setMargins(0, 0, dp(5), 0);
        parent.addView(card, lp);
        return v;
    }

    private TextView metricCard(LinearLayout parent, String title, String value) {
        LinearLayout card = panel(PANEL);
        card.setPadding(dp(10), dp(8), dp(10), dp(8));

        TextView t = text(title, 9, MUTED, true);
        TextView v = text(value, 13, TEXT, true);
        v.setTypeface(Typeface.create(Typeface.MONOSPACE, Typeface.BOLD));

        card.addView(t);
        card.addView(v, new LinearLayout.LayoutParams(-1, dp(26)));

        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(0, dp(60), 1f);
        lp.setMargins(0, 0, dp(6), 0);
        parent.addView(card, lp);
        return v;
    }

    private void startEngine() {
        if (destroyed) return;
        engine.setNetworkAvailable(networkMonitor.isAvailable());
        engine.start();
    }

    @Override protected void onResume() {
        super.onResume();
        networkMonitor.start();
        if (!userStopped) startEngine();
    }

    @Override protected void onPause() {
        engine.stop();
        networkMonitor.stop();
        super.onPause();
    }

    @Override protected void onDestroy() {
        destroyed = true;
        main.removeCallbacksAndMessages(null);
        engine.destroy();
        networkMonitor.stop();
        super.onDestroy();
    }

    @Override public void onSnapshot(BinanceMarketEngine.Snapshot snapshot) {
        latestBySymbol.put(snapshot.symbol, snapshot);

        if (renderQueued) return;
        renderQueued = true;

        main.postDelayed(() -> {
            renderQueued = false;
            if (destroyed) return;
            renderAll();
        }, 120L);
    }

    @Override public void onCandleHistory(String symbol, List<BinanceMarketEngine.Candle> candles) {
        main.post(() -> {
            if (destroyed || !selectedSymbol.equals(symbol)) return;
            chartView.setHistory(candles);
        });
    }

    @Override public void onCandle(BinanceMarketEngine.Candle candle) {
        main.post(() -> {
            if (destroyed || !selectedSymbol.equals(candle.symbol)) return;
            chartView.updateCandle(candle);
        });
    }

    private void renderAll() {
        for (String symbol : BinanceMarketEngine.SYMBOLS) {
            BinanceMarketEngine.Snapshot s = latestBySymbol.get(symbol);
            TextView p = priceRows.get(symbol);
            TextView c = changeRows.get(symbol);

            if (s == null) {
                if (p != null) p.setText("--");
                if (c != null) c.setText("--");
                continue;
            }

            if (p != null && s.lastTrade > 0.0) {
                p.setText(formatPrice(s.lastTrade));
            }

            if (c != null) {
                c.setText(String.format(Locale.US, "%+.2f%%", s.dayChangePercent));
                c.setTextColor(s.dayChangePercent >= 0.0 ? LIVE : DOWN);
            }
        }

        BinanceMarketEngine.Snapshot selected = latestBySymbol.get(selectedSymbol);
        if (selected != null) renderFocus(selected);
    }

    private void renderFocus(BinanceMarketEngine.Snapshot s) {
        selectedSymbolView.setText(displaySymbol(s.symbol));

        if (s.lastTrade > 0.0) {
            priceView.setText(formatPrice(s.lastTrade));
        }

        changeView.setText(String.format(
                Locale.US, "تغير 24س: %+.2f%%", s.dayChangePercent
        ));
        changeView.setTextColor(s.dayChangePercent >= 0.0 ? LIVE : DOWN);

        if (s.bid > 0.0) bidView.setText(formatPrice(s.bid));
        if (s.ask > 0.0) askView.setText(formatPrice(s.ask));
        if (s.spread() > 0.0) spreadView.setText(formatPrice(s.spread()));
        if (s.latencyMs() >= 0L) latencyView.setText(s.latencyMs() + " ms");
        updatesView.setText(Long.toString(s.updateCount));
        reconnectView.setText(Integer.toString(s.reconnectCount));
        if (s.quoteVolume > 0.0) volumeView.setText(compact(s.quoteVolume));
        updateTimeView.setText("آخر تحديث: " + time(s.receivedAtMs));
    }

    @Override public void onState(BinanceMarketEngine.State state, String detail) {
        main.post(() -> {
            if (destroyed) return;

            String title;
            int accent;
            switch (state) {
                case LIVE:
                    title = "● متصل مباشر";
                    accent = LIVE;
                    break;
                case CONNECTING:
                    title = "● جاري الاتصال";
                    accent = WARN;
                    break;
                case DEGRADED:
                    title = "● الاتصال يتعافى";
                    accent = WARN;
                    break;
                case OFFLINE:
                    title = "● بلا شبكة";
                    accent = ERROR;
                    break;
                default:
                    title = "● متوقف";
                    accent = MUTED;
                    break;
            }

            connectionView.setText(title);
            connectionView.setTextColor(accent);
            connectionDetailView.setText(detail == null ? "" : detail);

            if (state == BinanceMarketEngine.State.LIVE) {
                cacheView.setText("12 زوجًا • WebSocket واحد • 1m kline للعملة المختارة");
                cacheView.setTextColor(LIVE);
            } else if (state == BinanceMarketEngine.State.OFFLINE) {
                cacheView.setText("بلا شبكة • لن نعرض سعرًا مصطنعًا");
                cacheView.setTextColor(WARN);
            }
        });
    }

    private String displaySymbol(String symbol) {
        if (symbol != null && symbol.endsWith("USDT")) {
            return symbol.substring(0, symbol.length() - 4) + " / USDT";
        }
        return symbol == null ? "--" : symbol;
    }

    private String formatPrice(double value) {
        if (value >= 1000.0) return String.format(Locale.US, "%,.2f", value);
        if (value >= 1.0) return String.format(Locale.US, "%,.4f", value);
        if (value >= 0.01) return String.format(Locale.US, "%,.5f", value);
        return String.format(Locale.US, "%,.8f", value);
    }

    private String compact(double value) {
        if (value >= 1_000_000_000.0) {
            return String.format(Locale.US, "%.2fB", value / 1_000_000_000.0);
        }
        if (value >= 1_000_000.0) {
            return String.format(Locale.US, "%.2fM", value / 1_000_000.0);
        }
        if (value >= 1_000.0) {
            return String.format(Locale.US, "%.2fK", value / 1_000.0);
        }
        return String.format(Locale.US, "%.0f", value);
    }

    private String time(long millis) {
        if (millis <= 0L) return "--";
        return new SimpleDateFormat("HH:mm:ss.SSS", Locale.US)
                .format(new Date(millis));
    }

    private TextView text(String value, float sizeSp, int color, boolean bold) {
        TextView v = new TextView(this);
        v.setText(value);
        v.setTextSize(sizeSp);
        v.setTextColor(color);
        v.setGravity(Gravity.CENTER_VERTICAL);
        if (bold) {
            v.setTypeface(Typeface.create(Typeface.DEFAULT, Typeface.BOLD));
        }
        return v;
    }

    private LinearLayout panel(int color) {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setBackground(round(color, dp(14)));
        return box;
    }

    private GradientDrawable round(int color, int radius) {
        GradientDrawable d = new GradientDrawable();
        d.setColor(color);
        d.setCornerRadius(radius);
        d.setStroke(dp(1), 0x1836D399);
        return d;
    }

    private LinearLayout.LayoutParams marginTop(int top) {
        return marginTop(top, -1, -2);
    }

    private LinearLayout.LayoutParams marginTop(int top, int width, int height) {
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(width, height);
        lp.topMargin = dp(top);
        return lp;
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}
