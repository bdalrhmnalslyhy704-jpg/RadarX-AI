# RadarX — Local Free Development & Verification

## الهدف

هذا الدليل مخصص لتشغيل RadarX محليًا على جهازك فقط، بدون Oracle أو Hetzner أو Render أو DNS أو HTTPS عام أو بطاقة أو أسرار تداول.

الفرع المستهدف:

~~~text
phase2-provider-neutral-deployment
~~~

المنفذ المحلي للـbackend:

~~~text
http://127.0.0.1:8787
~~~

واجهة RadarX المحلية:

~~~text
http://127.0.0.1:5500/app.html
~~~

## 1) تثبيت Node.js 24 LTS

الإصدار المرجعي الحالي لخط 24.x هو Node.js v24.21.0 LTS. استخدم صفحة التنزيل الرسمية واختَر المثبت المناسب لنظامك:

https://nodejs.org/en/download/archive/v24.21.0

بعد التثبيت:

~~~bash
node --version
npm --version
~~~

المطلوب أن يظهر إصدار Node يبدأ بـ v24.

Node 24 يدعم خيار --env-file-if-exists، لذلك npm start في هذا الفرع يحمّل ملف .env.local إن كان موجودًا، من دون أن يفشل إذا لم يكن موجودًا.

## 2) الحصول على الفرع

إذا كان المستودع موجودًا محليًا:

~~~bash
git fetch origin
git switch phase2-provider-neutral-deployment
git pull --ff-only origin phase2-provider-neutral-deployment
git status
~~~

إذا لم يكن موجودًا:

~~~bash
git clone <REPOSITORY_URL> RadarX-AI
cd RadarX-AI
git switch phase2-provider-neutral-deployment
~~~

قبل المتابعة:

~~~bash
git branch --show-current
~~~

يجب أن يظهر:

~~~text
phase2-provider-neutral-deployment
~~~

لا تعدّل main.

## 3) تثبيت الاعتمادات

من جذر المستودع:

~~~bash
npm ci
~~~

هذا يستخدم package-lock.json لتثبيت الاعتمادات المتطابقة مع المشروع.

## 4) إنشاء ملف البيئة المحلي — بدون أسرار تداول

انسخ المثال:

### Linux / macOS

~~~bash
cp phase2/deploy/local.env.example .env.local
~~~

### Windows PowerShell

~~~powershell
Copy-Item phase2/deploy/local.env.example .env.local
~~~

المحتوى المحلي الآمن:

~~~text
RADARX_ENV=development
RADARX_HOST=127.0.0.1
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

لا تضف Binance API key أو Binance API secret أو مفاتيح سحب أو مفاتيح تنفيذ أوامر أو VAPID private key.

ملف .env.local مستثنى من Git، ولا يجب رفعه إلى المستودع.

## 5) تشغيل خدمة RadarX

من جذر المستودع:

~~~bash
npm start
~~~

في هذا الفرع ينفذ npm start:

~~~text
node --env-file-if-exists=.env.local phase2/server.mjs
~~~

والخدمة تستمع صراحة على:

~~~text
127.0.0.1:8787
~~~

اترك هذه النافذة مفتوحة.

## 6) فحص health و readiness

افتح:

~~~text
http://127.0.0.1:8787/healthz
http://127.0.0.1:8787/readyz
~~~

أو استخدم الطرفية:

### Linux / macOS

~~~bash
curl -fsS http://127.0.0.1:8787/healthz
curl -fsS http://127.0.0.1:8787/readyz
~~~

### Windows

~~~powershell
curl.exe -fsS http://127.0.0.1:8787/healthz
curl.exe -fsS http://127.0.0.1:8787/readyz
~~~

التفسير:

- /healthz يعرض حالة المراقبة وDurableStore وREST/WebSocket.
- /readyz يصبح 200 عندما تكون قاعدة البيانات LIVE ويكون Binance WebSocket أو REST في حالة LIVE.
- عند التشغيل الأول قد تحتاج بضع ثوانٍ حتى يكتمل الاتصال بالسوق.

إذا كان ready=false، تحقق من الإنترنت ثم راجع نافذة npm start.

## 7) فتح واجهة RadarX محليًا

خدمة Node هي backend فقط؛ واجهة phase1 تحتاج static server منفصلًا.

افتح نافذة طرفية ثانية:

### Linux / macOS

~~~bash
python3 -m http.server 5500 --bind 127.0.0.1 --directory phase1
~~~

### Windows PowerShell

~~~powershell
py -m http.server 5500 --bind 127.0.0.1 --directory phase1
~~~

ثم افتح:

~~~text
http://127.0.0.1:5500/app.html
~~~

أو:

~~~text
http://localhost:5500/app.html
~~~

### ربط الواجهة بالـbackend المحلي

من الإعدادات داخل RadarX، ضع عنوان خدمة Phase 2:

~~~text
http://127.0.0.1:8787
~~~

لا تحتاج إلى Session Token لكي تعمل /healthz و/readyz أو فحص السوق العام.

من دون Session Token ستبقى السجلات الخاصة بالحساب غير متاحة، وهذا متعمد في الاختبار المحلي المجاني ولا يحتاج إلى إنشاء سر جديد.

## 8) التأكد من وصول بيانات السوق العامة من Binance

هناك مساران مستقلان للبيانات:

1. واجهة RadarX تستخدم Binance Public REST مباشرة لفحص الشموع والعمق و24h ticker.
2. Backend يستخدم Binance Public REST + Public WebSocket للمراقبة الخلفية.

لا تُستخدم مفاتيح Binance في هذا المسار.

### اختبار مباشر من الطرفية

Linux / macOS:

~~~bash
curl -fsS "https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT"
~~~

Windows:

~~~powershell
curl.exe -fsS "https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT"
~~~

يجب أن يعيد Binance JSON يحتوي على symbol=BTCUSDT وسعر حالي.

### اختبار داخل RadarX

1. افتح app.html.
2. اترك الرمز BTCUSDT.
3. اضغط فحص السوق.
4. يجب أن يتحول المؤشر إلى LIVE_DATA عندما تنجح طلبات السوق.
5. افتح أدوات المطور > Network، وتحقق من طلبات مثل:
   - https://api.binance.com/api/v3/klines
   - https://api.binance.com/api/v3/depth
   - https://api.binance.com/api/v3/ticker/24hr

### اختبار backend

في /healthz ابحث عن:

~~~text
rest.state = LIVE
websocket.state = LIVE
~~~

وقد يظهر current_base_url كأحد عناوين Binance العامة.

هذه العلامات مع Network/REST المباشر تميّز البيانات الحقيقية عن بيانات وهمية. لا يوجد mock price في إعداد التشغيل المحلي.

## 9) Paper Trading فقط

التشغيل المحلي يحافظ على:

~~~text
paper_trading=true
real_order_execution=false
confidence_score=UNKNOWN
~~~

هذه القيم بوابة أمان للاختبار والتحليل فقط.

لا يوجد في هذا الدليل أي أمر شراء أو بيع، ولا أي endpoint لتنفيذ أوامر Binance.

## 10) عدم استخدام Binance API key أو secret

لا تحتاج Binance API key أو secret حتى يعمل فحص السوق العام.

المصادر المطلوبة هنا عامة:

~~~text
https://api.binance.com/api/v3/...
wss://stream.binance.com:443/...
~~~

أي مفاتيح تداول تُترك خارج هذا الاختبار بالكامل.

## 11) TEST_PUSH_ONLY — هل نفعّله محليًا؟

لا نفعّله محليًا.

الإعداد المحلي هو:

~~~text
RADARX_ENV=development
RADARX_PUSH_PROVIDER=none
RADARX_STAGING_TEST_PUSH_ENABLED=false
~~~

والكود الحالي يقفل TEST_PUSH_ONLY خارج staging.

يمكن إجراء اختبار أمان محلي فقط للتأكد من أن المسار محجوب:

### Linux / macOS

~~~bash
curl -i -X POST http://127.0.0.1:8787/v1/push/test \
  -H "Content-Type: application/json" \
  -d '{"test_id":"local-safe-check"}'
~~~

### Windows PowerShell

~~~powershell
curl.exe -i -X POST http://127.0.0.1:8787/v1/push/test `
  -H "Content-Type: application/json" `
  -d "{`"test_id`":`"local-safe-check`"}"
~~~

النتيجة الآمنة المتوقعة هي 404 مع:

~~~json
{"error":"STAGING_ONLY"}
~~~

هذا الاختبار لا يرسل إشعارًا إلى هاتف.

اختبار Push الحقيقي يحتاج staging مهيأ وWeb Push credentials وجهازًا فعليًا يستلم الإشعار، ولذلك لا ندخله في الاختبار المحلي المجاني الحالي.

## 12) ماذا يحدث عند إغلاق الكمبيوتر أو انقطاع الإنترنت؟

- عند إغلاق الكمبيوتر أو إيقاف النظام: خدمة Node والواجهة المحلية تتوقف.
- عند نوم الجهاز: قد تتوقف الشبكة أو تتعطل المراقبة.
- عند انقطاع الإنترنت: العملية المحلية لا تتوقف بالضرورة، لكن الوصول إلى Binance يصبح غير متاح، وتظهر الخدمة/الواجهة حالة degraded أو disconnected، ثم تحاول آليات reconnect/fallback الاستمرار بعد عودة الشبكة.
- التشغيل المحلي ليس خدمة 24/7.

## 13) أوامر الإيقاف

### إيقاف backend

في نافذة npm start اضغط:

~~~text
Ctrl+C
~~~

### إيقاف frontend

في نافذة Python اضغط:

~~~text
Ctrl+C
~~~

لا تحتاج إلى systemd أو Caddy في الاختبار المحلي.

## 14) فحص سريع قبل اعتبار الاختبار ناجحًا

نفّذ بالترتيب:

~~~bash
node --version
npm --version
npm ci
npm test
npm audit --omit=dev --audit-level=critical
npm start
~~~

ثم في نافذة ثانية شغّل static server على 5500 وافتح:

~~~text
http://127.0.0.1:5500/app.html
~~~

ثم افحص:

~~~text
http://127.0.0.1:8787/healthz
http://127.0.0.1:8787/readyz
~~~

وأخيرًا نفّذ اختبار Binance العام من القسم 8.

## 15) حدود الاختبار المحلي

الاختبار المحلي مناسب للتحقق من:

- تشغيل Node والاعتمادات.
- API health/readiness.
- اتصال Binance العام.
- WebSocket/REST fallback.
- منطق التحليل.
- Paper Trading.
- تخزين بيانات الاختبار محليًا.
- منع TEST_PUSH_ONLY خارج staging.

لكنه لا يثبت:

- استمرارية 24/7.
- استقبال Push على هاتف عبر HTTPS عام.
- DNS أو شهادة عامة.
- تشغيل systemd/Caddy على خادم.
- سلوك مزود استضافة خارجي.
- تحمل انقطاع كهرباء جهازك أو إعادة تشغيله.
- أداء التطبيق تحت حمل عام على الإنترنت.

## 16) قواعد أمان ثابتة في هذا الاختبار

لا تغيّر:

~~~text
RADARX_PAPER_TRADING=true
RADARX_REAL_ORDER_EXECUTION=false
RADARX_CONFIDENCE_MODE=UNKNOWN
RADARX_STAGING_TEST_PUSH_ENABLED=false
~~~

ولا تضف:

~~~text
BINANCE_API_KEY
BINANCE_API_SECRET
~~~

ولا ترسل أي طلب شراء أو بيع.

## 17) ملاحظات الفرع

هذا التعديل مخصص للتشغيل المحلي فقط:

- لا يغيّر main.
- لا ينشئ Oracle.
- لا ينشئ Hetzner.
- لا ينشئ Render.
- لا ينشئ DNS.
- لا ينشر HTTPS عامًا.
- لا يضيف أسرارًا حقيقية إلى Git.
- لا يغير استراتيجية السوق أو مصادر البيانات العامة.
