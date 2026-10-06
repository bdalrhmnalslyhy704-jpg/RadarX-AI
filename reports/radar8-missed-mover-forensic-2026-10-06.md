# Radar 8 — Missed-Mover Forensic 2026-10-06

هذا التقرير مبني على شموع Binance Spot USDT المغلقة (1m/5m) مع نافذة مستقبلية للاختبار التاريخي فقط، وليس جزءًا من قرار Radar 8 الحي.

## RLCUSDT
- 5m قبل الحركة: -2.38% خلال 15m و-5.26% خلال 60m.
- 1m: +1.17% خلال آخر 5m، Taker Buy 0.786، المسافة للمقاومة ~2.00%.
- القراءة: انعكاس سريع/تحول ضغط مع سيولة غير واضحة على 5m؛ لا يصلح الاعتماد على 24h ranking وحده.

## RADUSDT
- 1m RVOL 2.71x، Trade RVOL 3.51x، EMA stack صاعد، ADX 45.1، RSI 69.0، قرب المقاومة ~1.67%.
- القراءة: مشاركة متسارعة + اتجاه قصير قوي قبل التوسع.

## ORCAUSDT
- 5m: EMA stack صاعد، Higher-Lows = 100، RSI 60.6، قرب المقاومة ~1.24%، قوة نسبية مقابل BTC ~+1.09%.
- القراءة: بناء هادئ منظم مع ضغط على مقاومة، حتى بدون RVOL انفجاري.

## API3USDT
- 1m RVOL 6.45x، Trade RVOL 4.19x، Bollinger width ratio ~0.30، قرب المقاومة ~1.80%.
- Taker Buy منخفض ~0.25.
- القراءة: انفجار مشاركة مع ضغط بيعي ظاهري/امتصاص، لذلك لا يجب أن يشترط الرادار Taker Buy مرتفعًا دائمًا.

## DIAUSDT
- 5m RVOL 1.27x، 1m EMA stack صاعد، Bollinger ratio ~0.52، قرب المقاومة ~0.72%.
- Taker Buy منخفض ~0.16.
- القراءة: squeeze + هيكل + ضغط على مقاومة مع امتصاص؛ النوع الذي تفوته قواعد الحجم الساذجة.

## OGNUSDT
- 1m RVOL 2.65x، Trade RVOL 3.03x، EMA stack صاعد، Bollinger ratio ~0.40، قرب المقاومة ~0.41%.
- القراءة: مشاركة مبكرة قوية + انكماش + مقاومة قريبة.

## C98USDT
- 1m RVOL 18.60x، Trade RVOL 8.73x، Bollinger ratio ~0.82، ADX 47.6، قرب المقاومة ~1.85%.
- Taker Buy منخفض جدًا ~0.012.
- القراءة: مشاركة شديدة مع توازن ضغط غير تقليدي؛ يجب كشفها كـ absorption/ignition بدل إسقاطها بسبب Taker Buy.

## ما تغير في Radar 8 V2
1. ALL eligible Spot USDT ticker scan كل دورة.
2. Rotating 1m/5m micro-scan يغطي المرشحين بترتيب دوري عادل، وليس فقط أعلى 10.
3. Quiet reserve + rotation reserve حتى لا تفلت العملات الهادئة أو غير الظاهرة في ترتيب 24h.
4. بصمة متعددة العائلات: price acceleration, RVOL, trade count, ATR/Bollinger, VWAP/EMA, ADX/MACD/RSI/OBV, higher lows, resistance, BTC relative strength, taker divergence, absorption/reversal.
5. Hard fail-closed لـfuture/stale/gap.
6. منع التكرار عبر cooldown + cross-radar notification gate.
7. لا توجد أي بيانات مستقبلية في live gate، وكل التنفيذ ورقي فقط.

## حدود الاختبار
هذه العينة سبع عملات في جلسة واحدة. نجاحها لا يعني ضمان اكتشاف كل حركة مستقبلية؛ الاختبار يستخدمها كـregression benchmark ضد النوع نفسه من الحركات.
