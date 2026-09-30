# RadarX — LOCAL_FOREGROUND_MODE

## الحالة الحالية

RadarX يعمل في هذه المرحلة بوضع:

```text
LOCAL_FOREGROUND_MODE
```

المعنى: التحليل وجلب السوق من Binance يحدثان أثناء فتح صفحة RadarX فقط. لا تُعرض هذه المرحلة على أنها مراقبة 24/7 ولا كخدمة Push في الخلفية.

الـAPI المحلي اختياريًا على:

```text
http://127.0.0.1:8787
```

وواجهة RadarX على:

```text
http://127.0.0.1:5500/app.html
```

## ما يعمل الآن

عند فتح التطبيق وتشغيله عبر static server:

- جلب Binance Public API الحقيقي.
- فحص BTCUSDT وETHUSDT أو الرموز المحددة.
- تشغيل الاستراتيجيات الثلاث الحالية:
  - Multi-Timeframe Trend
  - Confirmed Breakout
  - Filtered Mean Reversion
- حساب وعرض Data Quality.
- حساب وعرض Liquidity Quality.
- حساب وعرض Risk Filter.
- عرض Paper Signal فقط.
- إبقاء confidence_score = UNKNOWN.
- إبقاء real_order_execution = false.
- إبقاء paper_trading = true.

لا يحتاج هذا المسار إلى Binance API key أو Binance API secret.

## 1. تثبيت Node.js 24 LTS

استخدم Node.js 24 LTS من المصدر الرسمي:

https://nodejs.org/en/download/archive/v24.21.0

تحقق:

~~~bash
node --version
npm --version
~~~

## 2. الدخول إلى الفرع

~~~bash
git fetch origin
git switch phase2-provider-neutral-deployment
git pull --ff-only origin phase2-provider-neutral-deployment
git branch --show-current
~~~

المطلوب:

~~~text
phase2-provider-neutral-deployment
~~~

لا تعمل من main.

## 3. تثبيت الاعتمادات

~~~bash
npm ci
~~~

## 4. إعداد البيئة المحلية

انسخ:

~~~bash
cp phase2/deploy/local.env.example .env.local
~~~

Windows PowerShell:

~~~powershell
Copy-Item phase2/deploy/local.env.example .env.local
~~~

الإعداد المحلي الأساسي:

~~~text
RADARX_ENV=development
RADARX_HOST=127.0.0.1
RADARX_BACKGROUND_MONITOR_ENABLED=false
PORT=8787
RADARX_SYMBOLS=BTCUSDT,ETHUSDT
RADARX_PUSH_PROVIDER=none
RADARX_ALLOWED_ORIGINS=http://127.0.0.1:5500,http://localhost:5500
RADARX_PUBLIC_API_ORIGIN=http://127.0.0.1:8787
RADARX_DATA_DIR=./.radarx-data
RADARX_PAPER_TRADING=true
RADARX_REAL_ORDER_EXECUTION=false
RADARX_CONFIDENCE_MODE=UNKNOWN
RADARX_STAGING_TEST_PUSH_ENABLED=false
~~~

`.env.local` يبقى محليًا ولا يدخل Git.

## 5. تشغيل الـAPI المحلي

~~~bash
npm start
~~~

في وضع development مع:

~~~text
RADARX_BACKGROUND_MONITOR_ENABLED=false
~~~

لا يبدأ MarketMonitor الخلفي. الخادم المحلي يوفّر API وhealth/readiness، بينما تحليل السوق الأمامي يحدث من صفحة RadarX.

اترك النافذة مفتوحة.

## 6. فحص healthz وreadyz

~~~bash
curl -fsS http://127.0.0.1:8787/healthz
curl -fsS http://127.0.0.1:8787/readyz
~~~

في Local Foreground Mode، /readyz لا يحتاج تشغيل مراقب السوق الخلفي؛ يكفي أن تكون قاعدة البيانات المحلية جاهزة.

يجب أن ترى في health:

~~~text
background_monitor.enabled = false
background_monitor.mode = FOREGROUND_API_ONLY
~~~

هذا التمييز مهم حتى لا يُفهم تشغيل الـAPI المحلي على أنه خدمة مراقبة 24/7.

## 7. تشغيل الواجهة

في Terminal ثانية:

Linux/macOS:

~~~bash
python3 -m http.server 5500 --bind 127.0.0.1 --directory phase1
~~~

Windows:

~~~powershell
py -m http.server 5500 --bind 127.0.0.1 --directory phase1
~~~

افتح:

~~~text
http://127.0.0.1:5500/app.html
~~~

## 8. ربط الواجهة بالـBackend المحلي

الواجهة تملك API base URL قابلًا للتغيير في Local Storage.

عند تشغيلها من localhost/127.0.0.1 يكون الافتراضي:

~~~text
http://127.0.0.1:8787
~~~

ومن الإعدادات يمكنك تغييره مستقبلًا إلى عنوان خادم مختلف.

هذا يعني أن الانتقال لاحقًا إلى:

~~~text
https://radarx.example.com
~~~

لا يحتاج إعادة بناء واجهة التطبيق من الصفر؛ تتغير نقطة اتصال الـAPI والإعدادات.

## 9. بيانات السوق الحقيقية

اختبار مستقل:

~~~bash
curl -fsS "https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT"
~~~

ثم داخل RadarX اضغط:

~~~text
فحص السوق
~~~

الحالة المطلوبة:

~~~text
LIVE_DATA
~~~

وللتأكد من عدم وجود mock:

- راقب Network في أدوات المطور.
- يجب أن ترى طلبات Binance Public API مثل `/api/v3/klines` و`/api/v3/depth` و`/api/v3/ticker/24hr`.
- مصدر التحليل في الإشارة هو `BINANCE_PUBLIC_REST`.

الـService Worker لا يخزن ردود Binance أو backend على أنها بيانات سوق مباشرة.

## 10. حالة الواجهة

يجب أن تعرض الواجهة بوضوح:

~~~text
Local Foreground Mode
Live while app is open
Background monitoring: Not enabled
Push notifications: Not configured
Data source: Binance Public API
Paper Trading only
~~~

هذه العبارات تعني:

- Live while app is open: البيانات الحية أثناء نشاط الصفحة.
- Background monitoring: Not enabled: لا يوجد مراقب خادم 24/7 في الوضع المحلي.
- Push notifications: Not configured: لا توجد Push خلفية في هذه المرحلة.
- Data source: Binance Public API: مصدر السوق عام وبدون مفاتيح تداول.
- Paper Trading only: لا يوجد تنفيذ حقيقي.

## 11. الإيقاف الآمن

عند إخفاء الصفحة أو الانتقال منها أو إغلاقها:

- يتوقف مؤقت التحليل الأمامي.
- يتوقف مؤقت فحص حالة الـAPI من الواجهة.
- يتم مسح قيم العرض الحية.
- لا تُعتبر آخر نتيجة مخزنة أو آخر إشارة بيانات لحظية جديدة.
- يبقى آخر وقت اتصال ناجح ظاهرًا كبيان تاريخي فقط.

عند عودة الصفحة إلى الواجهة، يعاد تشغيل الفحص الأمامي ويُطلب snapshot جديد من Binance.

## 12. انقطاع الإنترنت أو إغلاق الكمبيوتر

عند فقد الإنترنت:

```text
Live market data = unavailable
```

ويجب عدم تفسير البيانات السابقة على أنها live.

توجد آليات REST fallback وWebSocket reconnect داخل المكونات المناسبة، لكن Local Foreground Mode نفسه لا يحول جهازك إلى خدمة 24/7.

عند إغلاق الكمبيوتر أو نومه أو إغلاق البرنامج:

```text
Foreground analysis = stopped
```

## 13. Paper Trading فقط

الإعدادات الثابتة:

~~~text
RADARX_PAPER_TRADING=true
RADARX_REAL_ORDER_EXECUTION=false
RADARX_CONFIDENCE_MODE=UNKNOWN
~~~

ولا تُستخدم:

~~~text
BINANCE_API_KEY
BINANCE_API_SECRET
~~~

ولا توجد أوامر شراء أو بيع أو سحب أو محافظ في هذا المسار.

## 14. TEST_PUSH_ONLY

لا يتم تفعيله محليًا.

~~~text
RADARX_STAGING_TEST_PUSH_ENABLED=false
RADARX_PUSH_PROVIDER=none
~~~

الاختبار المحلي المسموح فقط هو التأكد من الحجب:

~~~bash
curl -i -X POST http://127.0.0.1:8787/v1/push/test \
  -H "Content-Type: application/json" \
  -d '{"test_id":"local-safe-check"}'
~~~

المتوقع:

~~~text
404
{"error":"STAGING_ONLY"}
~~~

لا يُرسل هذا الاختبار أي إشعار.

## 15. الفرق عن الخادم المستقبلي

### الوضع الحالي — Local Foreground Mode

~~~text
Browser
  |
  +--> Binance Public REST
  |
  +--> Local Phase 2 API :8787
  |
  +--> Analysis in page
  |
  +--> Paper Signals
~~~

التحليل الأمامي يتوقف عندما تتوقف الصفحة.

### الوضع المستقبلي — Server Background Mode

~~~text
Internet
  |
  +--> HTTPS
  |
  +--> RadarX Server
          |
          +--> Binance Public REST
          +--> Binance Public WebSocket
          +--> Background MarketMonitor
          +--> Durable Store
          +--> Push Provider
          |
          +--> Browser/PWA
~~~

في هذا الوضع تكون المراقبة على الخادم، وليس داخل صفحة المتصفح، ويمكن أن يستمر الخادم حتى عند إغلاق التطبيق.

الخيار المستقبلي يستخدم:

~~~text
RADARX_BACKGROUND_MONITOR_ENABLED=true
~~~

ويحتفظ بنفس API contract وhealthz/readyz وطبقة Push المنفصلة.

## 16. HTTPS وWSS لاحقًا

الوضع المحلي الحالي يستخدم HTTP loopback:

~~~text
http://127.0.0.1:8787
~~~

الخادم المستقبلي يمكن أن يستخدم HTTPS للواجهة والـAPI، ومع الحاجة إلى WebSocket من العميل يمكن استخدام WSS.

لا يوجد أي DNS أو شهادة عامة في هذه المرحلة.

## 17. PWA والتثبيت المحلي

RadarX يملك manifest وService Worker بالفعل.

لتجربة PWA محليًا، يجب تقديم الملفات من `127.0.0.1` أو `localhost` عبر HTTP بدل فتحها كملف `file://`.

المتصفحات الحديثة تعتبر localhost/127.0.0.1 بيئة مناسبة لاختبار Service Worker وPWA installation، مع اختلاف واجهة التثبيت حسب المتصفح. urlMDN — Making PWAs installablehttps://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable

بعد تشغيل static server:

~~~text
http://127.0.0.1:5500/app.html
~~~

يمكنك تجربة خيار المتصفح مثل:

~~~text
Install app
Add to Home screen
Install RadarX
~~~

حسب المتصفح.

لكن:

~~~text
http://127.0.0.1:5500
~~~

ليس رابط تثبيت عام يمكن إرساله للآخرين؛ هو loopback على نفس الجهاز فقط.

وللتوزيع العام تحتاج لاحقًا استضافة عامة وHTTPS واسم نطاق.

## 18. الانتقال لاحقًا إلى خادم 24/7

لا تبدأ من جديد. المسار المقترح:

1. اختر خادم Linux لاحقًا.
2. انسخ نفس repository/branch أو Commit موثوق.
3. ثبت Node 24.
4. ضع `RADARX_BACKGROUND_MONITOR_ENABLED=true`.
5. ضع `RADARX_HOST=0.0.0.0` و`PORT` في environment.
6. اجعل `RADARX_DATA_DIR=/var/lib/radarx`.
7. شغّل العملية تحت مستخدم غير root.
8. استخدم systemd لإعادة التشغيل عند فشل العملية.
9. ضع Caddy أو reverse proxy أمام الخدمة للـHTTPS.
10. اجعل Push Provider طبقة مستقلة عن تحليل السوق.
11. تحقق من `/healthz` و`/readyz`.
12. اختبر TEST_PUSH_ONLY على staging فقط مع جهاز فعلي.
13. بعد validation، يمكن لاحقًا الانتقال إلى التشغيل الخلفي الفعلي وفق سياسة التطبيق.

لا يحتاج هذا الانتقال إلى إعادة كتابة الواجهة أو محرك الاستراتيجيات.

## 19. حدود الوضع الحالي

لا يعتبر النظام المحلي الحالي:

- مراقبة 24/7.
- خدمة Push مستمرة بعد إغلاق الصفحة.
- خادمًا عامًا.
- بديلًا عن systemd أو مدير عمليات.
- بديلًا عن HTTPS/DNS العام.
- ضمانًا لاستمرار الجهاز بعد انقطاع الكهرباء.
- ضمانًا لاستمرار البيانات عند انقطاع الإنترنت.

## 20. التحقق النهائي

~~~bash
node --version
npm --version
npm ci
npm test
npm audit --omit=dev --audit-level=critical
npm start
~~~

ثم:

~~~bash
curl -fsS http://127.0.0.1:8787/healthz
curl -fsS http://127.0.0.1:8787/readyz
~~~

وفي Terminal ثانية:

~~~bash
python3 -m http.server 5500 --bind 127.0.0.1 --directory phase1
~~~

ثم:

~~~text
http://127.0.0.1:5500/app.html
~~~

## النتيجة المطلوبة

~~~text
Mode                         = Local Foreground Mode
Live state                   = Live while app is open
Background monitoring        = Not enabled
Push notifications           = Not configured
Data source                  = Binance Public API
Trading                      = Paper only
real_order_execution         = false
confidence_score             = UNKNOWN
TEST_PUSH_ONLY               = disabled
~~~
