# RadarX — LOCAL FOREGROUND MODE

## الحالة الحالية
RadarX يعمل في هذه المرحلة بوضع Local Foreground Mode: التحليل وجلب السوق من Binance يحدثان أثناء فتح صفحة RadarX فقط. لا تُعرض هذه المرحلة على أنها مراقبة 24/7 ولا كخدمة Push في الخلفية.

- Live while app is open
- Background monitoring: Not enabled
- Push notifications: Not configured
- Data source: Binance Public API
- Paper Trading only
- real_order_execution=false
- confidence_score=UNKNOWN
- TEST_PUSH_ONLY=false محليًا.

## التشغيل المحلي
```bash
git switch phase2-provider-neutral-deployment
npm ci
cp phase2/deploy/local.env.example .env.local
npm start
```

Windows PowerShell:
```powershell
Copy-Item phase2/deploy/local.env.example .env.local
npm start
```

يجب أن يحتوي .env.local على RADARX_ENV=development وRADARX_HOST=127.0.0.1 وPORT=8787 وRADARX_BACKGROUND_MONITOR_ENABLED=false، مع RADARX_PAPER_TRADING=true وRADARX_REAL_ORDER_EXECUTION=false وRADARX_CONFIDENCE_MODE=UNKNOWN وRADARX_STAGING_TEST_PUSH_ENABLED=false.

لا تضع Binance API key أو Binance API secret في الملف.

## فتح الواجهة
Linux/macOS:
```bash
python3 -m http.server 5500 --bind 127.0.0.1 --directory phase1
```
Windows:
```powershell
py -m http.server 5500 --bind 127.0.0.1 --directory phase1
```
افتح: http://127.0.0.1:5500/app.html

عنوان Phase 2 القابل للتغيير من الإعدادات: http://127.0.0.1:8787

## ما يعمل أثناء فتح الصفحة
1. يجلب RadarX بيانات Binance Public API.
2. يجلب 4H و1H و15m وdepth و24h ticker.
3. يشغل Multi-Timeframe Trend وConfirmed Breakout وFiltered Mean Reversion.
4. يعرض Data Quality وLiquidity Quality وRisk Filter.
5. يعرض Paper Signals فقط.
6. يعيد الفحص دوريًا أثناء بقاء الصفحة مرئية.
7. يعرض وقت آخر اتصال حي.

## عند إخفاء الصفحة أو إغلاقها
- يتوقف مؤقت الفحص المحلي.
- تلغى نتائج الفحص المتأخرة.
- تمسح بطاقات بيانات السوق الحية حتى لا تعرض بيانات قديمة على أنها LIVE.
- يبقى آخر وقت اتصال ظاهرًا.
- تظهر الحالة Paused/Disconnected.
- لا يبدأ background monitor بديل.
- إغلاق الكمبيوتر يوقف Node والواجهة المحلية.

## healthz وreadyz
افتح:
```text
http://127.0.0.1:8787/healthz
http://127.0.0.1:8787/readyz
```
أو:
```bash
curl -fsS http://127.0.0.1:8787/healthz
curl -fsS http://127.0.0.1:8787/readyz
```
في Local Foreground Mode تظهر background_monitor.enabled=false وbackground_monitor.mode=FOREGROUND_API_ONLY. وجود readyz لا يعني وجود مراقب 24/7.

## التأكد من LIVE_DATA
تحقق من طلبات Binance في Developer Tools > Network، ويجب أن تنجح klines وdepth وticker. الواجهة تعرض LIVE_DATA فقط بعد نجاح جلب البيانات الحالية.

اختبار مباشر:
```bash
curl -fsS "https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT"
```
لا تحتاج البيانات العامة إلى API key أو secret.

## Paper Trading فقط
```text
RADARX_PAPER_TRADING=true
RADARX_REAL_ORDER_EXECUTION=false
RADARX_CONFIDENCE_MODE=UNKNOWN
```
لا توجد أوامر شراء/بيع حقيقية أو محافظ أو سحب أو مفاتيح تداول.

## TEST_PUSH_ONLY
لا يتم تفعيله محليًا: RADARX_STAGING_TEST_PUSH_ENABLED=false. واجهة الإعدادات تمنع تشغيل اختبار Push في development. الاختبار الميداني مخصص لـstaging مع جهاز فعلي.

## الفرق عن Future Server Background Mode
Local Foreground Mode الآن: Browser → Binance Public API → Strategies → Quality/Risk → Paper Signal. يتوقف التحليل عند إغلاق الصفحة.

Future Server Background Mode لاحقًا: Binance REST/WebSocket → Server Background Monitor 24/7 → Strategies/Risk/Quality → Paper Signal + Push Layer → Browser/Phone.

الخادم المستقبلي هو الذي سيبقى يعمل عند إغلاق التطبيق ويرسل Push. API base URL وhealth/readiness وطبقة Push منفصلة، لذلك لا يلزم إعادة بناء الواجهة من الصفر.

## الانتقال لاحقًا إلى خادم 24/7
1. تثبيت Ubuntu وNode 24.
2. إنشاء مستخدم خدمة غير root.
3. نشر نفس إصدار RadarX.
4. وضع البيانات الدائمة في /var/lib/radarx.
5. وضع الأسرار في /etc/radarx/radarx.env خارج Git.
6. ضبط RADARX_HOST=0.0.0.0 وPORT من البيئة.
7. تفعيل RADARX_BACKGROUND_MONITOR_ENABLED=true.
8. تشغيل backend عبر systemd.
9. وضع Caddy أو reverse proxy أمامه.
10. استخدام HTTPS/WSS على النطاق العام.
11. اختبار healthz وreadyz.
12. في staging فقط، تجهيز Push وTEST_PUSH_ONLY والتحقق من الاستلام الفعلي.
13. لا حاجة للارتباط بـRender؛ البنية provider-neutral.

## PWA والتثبيت
http://127.0.0.1 ليس رابط تثبيت عامًا. التثبيت العام يحتاج استضافة ونطاقًا وHTTPS.

لا يتم الآن إنشاء استضافة أو DNS أو شهادة HTTPS عامة أو Oracle أو Hetzner أو Render أو حساب دفع.

للاختبار المحلي: شغّل static server على 127.0.0.1:5500، افتح app.html، وتحقق من manifest وService Worker. إذا ظهر Install app أو Add to Home screen في المتصفح، يمكن تثبيتها محليًا على نفس الجهاز. هذا لا يجعلها متاحة للعامة.

## حدود التشغيل المحلي
يختبر الوضع المحلي بيانات Binance العامة والفحص والاستراتيجيات الثلاث وData Quality وLiquidity Quality وRisk Filter وPaper Signals وhealthz/readyz وفصل foreground/background وPWA محليًا.

ولا يختبر مراقبة 24/7 بعد إغلاق التطبيق أو Push عند الإغلاق أو DNS/HTTPS/WSS العام أو تحمل خادم خارجي.

## الإيقاف
في كل نافذة تشغيل: Ctrl+C.

## بوابة الأمان
```text
paper_trading=true
real_order_execution=false
confidence_score=UNKNOWN
TEST_PUSH_ONLY=false
```
ولا يستخدم هذا المسار Binance API key أو secret، ولا يرسل تداولًا حقيقيًا.