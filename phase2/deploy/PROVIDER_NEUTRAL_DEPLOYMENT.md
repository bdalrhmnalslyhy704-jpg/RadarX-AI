
# RadarX — Provider-Neutral Linux Deployment

## الهدف

هذه الخطة تجعل RadarX قابلًا للتشغيل على أي خادم Linux يدعم:

- Ubuntu Linux
- Node.js 24 LTS
- systemd
- Caddy
- HTTPS
- WebSocket عبر نفس خدمة التطبيق
- تخزين دائم على `/var/lib/radarx`

لا توجد في هذه الخطة أي تبعية لـ Render API أو Render Disk أو إعدادات Render الخاصة.

**حالة الخطة:** ملفات وتجهيزات فقط. لا يتم إنشاء حساب استضافة أو خادم أو DNS أو وسيلة دفع أو نشر.

## خط الإصدار

Baseline موصى به حاليًا:

```text
fe6db929e62ce9bf179f829e2b2bf7f28566f6a4
```

هذا هو رأس Release Candidate الذي اجتاز آخر CI بنجاح. يجب تسجيل Commit معروف قبل كل نشر، واستخدامه نفسه في rollback.

## المعمارية

```text
Internet
  |
  |  HTTPS :443 / HTTP :80
  v
Caddy
  |
  | reverse proxy + WebSocket upgrade
  v
RadarX Node.js (systemd, user=radarx)
  |
  +--> Binance public REST/WSS
  |
  +--> /var/lib/radarx
```

Caddy يخدم PWA من `/opt/radarx/phase1/`، ويمرر API/health/readiness وأي WebSocket مستقبل إلى Node.

## Runtime Contract

يجب أن يقرأ التطبيق:

```text
RADARX_HOST=0.0.0.0
RADARX_BACKGROUND_MONITOR_ENABLED=true
PORT=<operator-selected-port-from-environment>
RADARX_DATA_DIR=/var/lib/radarx
```

لا تستخدم `RADARX_PORT` كمنفذ إنتاج ثابت.

المنفذ الداخلي ليس واجهة عامة؛ الجدار الناري يجب أن يمنع الوصول الخارجي إليه. Caddy فقط هو الواجهة العامة.

## Background Monitor Mode

يُفصل تشغيل التحليل الأمامي عن مراقبة الخادم عبر:

```text
RADARX_BACKGROUND_MONITOR_ENABLED=false   # Local Foreground Mode
RADARX_BACKGROUND_MONITOR_ENABLED=true    # Future Server Background Mode
```

في Local Foreground Mode لا يبدأ `MarketMonitor` داخل الخدمة المحلية؛ الواجهة تجلب Public REST وتحلل البيانات أثناء فتح الصفحة. في Server Background Mode يبدأ `MarketMonitor` ويستخدم Binance Public REST/WebSocket ويستمر مستقلًا عن المتصفح.

## Build / Start

عند تجهيز نسخة تشغيلية من Git:

```bash
npm ci --omit=dev
npm start
```

للتدقيق قبل التشغيل:

```bash
npm ci
npm test
npm audit --omit=dev --audit-level=critical
```

## HTTPS

Caddy يوفّر HTTPS تلقائيًا عند استخدام hostname عام صحيح، ويجدد الشهادات تلقائيًا. يلزم DNS صحيح ووصول خارجي إلى 80/443. urlCaddy Automatic HTTPS documentationhttps://caddyserver.com/docs/automatic-https

استخدم أصل PWA/API دقيقًا، مثل:

```text
https://radarx.example.com
```

ولا تستخدم `*` في CORS أو عنوان HTTP غير المشفر في staging/production.

## WebSocket

Caddy reverse proxy يدعم WebSocket عند تمرير الطلب إلى backend. لا تحتاج إلى منفذ عام منفصل للـWebSocket. urlCaddy request matchers / WebSocket documentationhttps://caddyserver.com/docs/caddyfile/matchers

في RadarX، اتصال Binance WSS هو اتصال outbound من الخادم. يجب أن يستمر reconnect/backoff وREST fallback كما هو.

## Health / Readiness

المساران العامان:

```text
GET /healthz
GET /readyz
```

`/healthz` يجيب عن صحة الخدمة الحالية.

`/readyz` بوابة التشغيل: يجب أن يرى DurableStore LIVE وأن يرى WebSocket أو REST في حالة صالحة قبل اعتبار الخدمة جاهزة.

## Persistent Data

```text
/var/lib/radarx
```

هذا المجلد يجب أن يكون دائمًا، ويمتلكه المستخدم `radarx`.

الـsystemd service يستخدم:

```text
RADARX_DATA_DIR=/var/lib/radarx
```

## Linux User Boundary

لا تشغّل RadarX كـroot.

المستخدم المقترح:

```text
radarx
```

العمليات المطلوبة للتثبيت/configuration تستخدم sudo، بينما process التشغيل الفعلي يعمل كمستخدم `radarx`.

## Firewall

افتراضيًا:

- SSH: TCP 22
- HTTP: TCP 80
- HTTPS: TCP 443

ولا تفتح منفذ التطبيق الداخلي مباشرة للعالم.

مثال UFW:

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status verbose
```

إذا كان SSH يعمل على منفذ آخر، اسمح به قبل تفعيل UFW.

على Oracle، تطبق القاعدة نفسها أيضًا على VCN Security List/NSG.

## Secrets Outside Git

ضع الملف:

```text
/etc/radarx/radarx.env
```

بصلاحيات:

```text
root:root 0600
```

يحوي placeholders/قيم runtime الحقيقية على الخادم فقط، ولا يوضع في Git.

الحد الأدنى:

```text
RADARX_ENV=staging
RADARX_HOST=0.0.0.0
RADARX_BACKGROUND_MONITOR_ENABLED=true
PORT=8787
RADARX_PUSH_PROVIDER=webpush
RADARX_ALLOWED_ORIGINS=https://radarx.example.com
RADARX_PUBLIC_API_ORIGIN=https://radarx.example.com
RADARX_DATA_DIR=/var/lib/radarx
RADARX_AUTH_SECRET=<secret>
VAPID_SUBJECT=<secret>
VAPID_PUBLIC_KEY=<secret>
VAPID_PRIVATE_KEY=<secret>
RADARX_PAPER_TRADING=true
RADARX_REAL_ORDER_EXECUTION=false
RADARX_CONFIDENCE_MODE=UNKNOWN
RADARX_STAGING_TEST_PUSH_ENABLED=false
```

الـ`PORT=8787` هنا مجرد قيمة تشغيلية يختارها المشغّل ويحقنها في البيئة؛ التطبيق يعتمد على `PORT` وليس `RADARX_PORT`.

## Safety Invariants

يجب أن تبقى دائمًا:

```text
paper_trading=true
real_order_execution=false
confidence_score=UNKNOWN
```

لا تستخدم:

- Binance API key
- Binance secret
- order endpoint
- withdrawal endpoint
- authenticated exchange user-data credentials

التحليل Read-only، والصفقات Paper فقط.

## TEST_PUSH_ONLY

الاختبار الميداني:

```text
RADARX_STAGING_TEST_PUSH_ENABLED=true
```

يُفعّل فقط على staging وفي نافذة الاختبار.

لا تعتبر استجابة HTTP الناجحة أو `status=SENT` دليلًا على وصول الهاتف.

لا يصبح staging push validation في النظام VALIDATED إلا بعد إثبات وصول الإشعار إلى جهاز حقيقي وإرسال receipt acknowledgment المرتبط بالـsubscription والـevent.

بعد الاختبار:

```text
RADARX_STAGING_TEST_PUSH_ENABLED=false
```

ثم أعد تشغيل الخدمة.

## LIVE_MARKET_SIGNAL Gate

في staging، يجب أن يبقى:

```text
LIVE_MARKET_SIGNAL Push = BLOCKED
```

حتى تصبح حالة `staging_push_validation_status`:

```text
VALIDATED
```

في هذه الأثناء يستمر:

- Paper Signal
- SIGNAL_EVALUATION audit
- internal notification audit

ولا يتحول TEST_PUSH_ONLY إلى LIVE_MARKET_SIGNAL.

## Rollback

1. سجل Commit الحالي قبل النشر.
2. احتفظ بآخر Commit معروف وسليم، مثل baseline أعلاه.
3. عند وجود خلل في التطبيق، أعد checkout إلى الـknown-good commit.
4. نفذ `npm ci --omit=dev`.
5. أعد تشغيل systemd.
6. تحقق من `/healthz` و`/readyz`.
7. لا تسترجع بيانات القرص إلا إذا كان الخلل في البيانات نفسها.

## Backup

بيانات RadarX الأساسية:

```text
/var/lib/radarx
```

مثال backup:

```bash
sudo install -d -m 700 /var/backups/radarx
sudo tar -C /var/lib -czf /var/backups/radarx/radarx-$(date +%Y%m%d-%H%M%S).tar.gz radarx
sudo chmod 600 /var/backups/radarx/*.tar.gz
```

الاستعادة:

```bash
sudo systemctl stop radarx
sudo tar -C /var/lib -xzf /var/backups/radarx/<KNOWN-BACKUP>.tar.gz
sudo chown -R radarx:radarx /var/lib/radarx
sudo systemctl start radarx
```

نسخ الأسرار الاحتياطية يجب أن تبقى مشفرة خارج Git، وليس داخل نفس أرشيف public repository.

## Operational Checklist

- Ubuntu supported and updated.
- Node 24 LTS verified.
- `radarx` is non-root.
- `/var/lib/radarx` writable by `radarx`.
- `/etc/radarx/radarx.env` is 0600 and outside Git.
- `RADARX_HOST=0.0.0.0`.
- `PORT` supplied through environment.
- Caddy owns public 80/443.
- 8787/internal app port not exposed externally.
- `/healthz` returns 200.
- `/readyz` returns 200 only when ready.
- HTTPS is valid.
- PWA CORS origin is exact.
- `TEST_PUSH_ONLY` is false during normal operation.
- Physical-device test is required before live Push validation.
- `paper_trading=true`.
- `real_order_execution=false`.
- `confidence_score=UNKNOWN`.

## Provider Decision

### First choice — Oracle Cloud Always Free

Use when an Always Free eligible instance is available in the home region. Current Oracle documentation lists an Always Free Ampere A1 allocation equivalent to 2 OCPUs and 12 GB RAM, plus 200 GB combined Always Free Block Volume in the home region. Oracle also notes possible temporary “out of host capacity” errors and idle-instance reclamation rules. urlOracle Always Free resourceshttps://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm

### Second choice — economical VPS

Use a small x86 VPS such as Hetzner CX23 when Oracle capacity/account constraints prevent the free path. Current Hetzner pricing lists CX23 at about $6.49/month excluding VAT and excluding Primary IPv4 in Germany/Finland; Primary IPv4 is currently $0.60/month excluding VAT. urlHetzner June 2026 price adjustmenthttps://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/ urlHetzner Primary IPv4 pricinghttps://docs.hetzner.com/cloud/servers/primary-ips/overview/

## No Render

This provider-neutral path intentionally does not use Render APIs, Render Disks, Render-specific configuration, or Render deployment commands.


## مقارنة خيارات الاستضافة

| الخيار | التكلفة الحالية | 24/7 | HTTPS | تخزين دائم | WebSocket | صعوبة الإعداد | مسؤولية الأمان | المخاطر/الحدود |
|---|---|---|---|---|---|---|---|---|
| التشغيل المحلي | $0 | فقط ما دام الجهاز والخدمة يعملان | ممكن مع Caddy محليًا؛ ليس بديلًا عامًا عمليًا | نعم على قرص الجهاز | نعم | منخفضة | أنت مسؤول بالكامل | انقطاع الكهرباء/الإنترنت والنوم/إغلاق الجهاز |
| Oracle Cloud Always Free | $0 داخل حدود Always Free | نعم، مع قيود Oracle | نعم عبر Caddy | نعم | نعم | متوسطة | أنت + Oracle controls | A1 capacity قد لا تكون متاحة مؤقتًا؛ قد تُستعاد موارد compute الخاملة وفق سياسة Oracle؛ التسجيل قد يتطلب بطاقة |
| VPS اقتصادي (مثال Hetzner CX23) | نحو $6.49/شهر + $0.60 IPv4 = $7.09 قبل VAT | نعم | نعم عبر Caddy | نعم | نعم | متوسطة | أنت + مزود البنية | رسوم إضافية محتملة لـIPv4/VAT والموارد؛ الإدارة والنسخ الاحتياطي عليك |
| Render | Free متاح بقيود؛ Web Service المدفوع يبدأ من نحو $7/شهر + $0.25/GB للقرص | Free لا يصلح لمراقبة 24/7 لأنه يدخل sleep؛ المدفوع نعم | نعم | نعم على Persistent Disk | نعم | منخفضة | جزء كبير لدى المنصة | تكلفة مستمرة؛ هذه المرحلة لا تستخدم Render |

مصادر الأسعار/القيود الحالية:
- Oracle Always Free: https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm
- Oracle Free Tier signup: https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier.htm
- Hetzner June 2026 pricing: https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/
- Hetzner Primary IPv4: https://docs.hetzner.com/cloud/servers/primary-ips/overview/
- Render pricing: https://render.com/pricing
- Render compute plans: https://render.com/docs/compute-plans

## Runbook موحّد للخادم

### 1. تجهيز Ubuntu

```bash
sudo apt update
sudo apt full-upgrade -y
sudo apt install -y curl ca-certificates git ufw tar gzip
```

### 2. تثبيت Node.js 24 LTS

Node.js v24.21.0 هو إصدار 24.x LTS الحالي وقت إعداد هذه الوثيقة، وتتوفر له Linux x64 وLinux arm64 binaries. تحقق من الإصدار بعد التثبيت:

```bash
node --version
npm --version
```

المصدر الرسمي: https://nodejs.org/en/download/archive/v24.21.0

### 3. إنشاء المستخدم والمسارات

```bash
sudo useradd --system --create-home --home-dir /home/radarx --shell /usr/sbin/nologin radarx
sudo install -d -o radarx -g radarx -m 750 /opt/radarx
sudo install -d -o radarx -g radarx -m 750 /var/lib/radarx
sudo install -d -o root -g root -m 700 /etc/radarx
```

### 4. وضع الكود

استخدم Commit معروفًا وسليمًا. في هذا الإصدار:

```text
fe6db929e62ce9bf179f829e2b2bf7f28566f6a4
```

ثم:

```bash
sudo -u radarx git clone <REPOSITORY_URL> /opt/radarx
sudo -u radarx git -C /opt/radarx checkout fe6db929e62ce9bf179f829e2b2bf7f28566f6a4
sudo -u radarx -H bash -lc 'cd /opt/radarx && npm ci --omit=dev'
```

### 5. ملف الأسرار

أنشئ:

```text
/etc/radarx/radarx.env
```

ثم:

```bash
sudo chown root:root /etc/radarx/radarx.env
sudo chmod 600 /etc/radarx/radarx.env
```

الحد الأدنى:

```text
RADARX_ENV=staging
RADARX_STAGING_TEST_PUSH_ENABLED=false
RADARX_HOST=0.0.0.0
PORT=8787
RADARX_PUSH_PROVIDER=webpush
RADARX_ALLOWED_ORIGINS=https://radarx.example.com
RADARX_PUBLIC_API_ORIGIN=https://radarx.example.com
RADARX_DATA_DIR=/var/lib/radarx
RADARX_AUTH_SECRET=<secret>
VAPID_SUBJECT=<secret>
VAPID_PUBLIC_KEY=<secret>
VAPID_PRIVATE_KEY=<secret>
RADARX_PAPER_TRADING=true
RADARX_REAL_ORDER_EXECUTION=false
RADARX_CONFIDENCE_MODE=UNKNOWN
```

### 6. التحقق قبل التشغيل

```bash
sudo -u radarx -H bash -lc 'cd /opt/radarx && npm ci'
sudo -u radarx -H bash -lc 'cd /opt/radarx && npm test'
sudo -u radarx -H bash -lc 'cd /opt/radarx && npm audit --omit=dev --audit-level=critical'
```

يجب ألا يبدأ اختبار الهاتف قبل نجاح هذه الخطوة.

### 7. systemd

انسخ:

```text
phase2/deploy/systemd/radarx.service.example
```

إلى:

```text
/etc/systemd/system/radarx.service
```

ثم:

```bash
sudo systemctl daemon-reload
sudo systemctl enable radarx
sudo systemctl start radarx
sudo systemctl status radarx --no-pager
```

للسجلات:

```bash
sudo journalctl -u radarx -n 100 --no-pager
```

### 8. Firewall

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status verbose
```

يجب ألا يكون منفذ Node الداخلي مكشوفًا للعامة.

### 9. Caddy وHTTPS

ثبّت Caddy من الحزمة الرسمية لنظام Ubuntu. بعد وضع hostname الحقيقي في Caddyfile:

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

يجب أن تشير DNS A/AAAA إلى الخادم وأن تكون 80/443 متاحتين خارجيًا قبل طلب الشهادة العامة.

### 10. Health / Readiness

```bash
curl -fsS https://radarx.example.com/healthz
curl -fsS https://radarx.example.com/readyz
```

إذا فشل `/readyz`، لا تبدأ اختبار Push.

### 11. TEST_PUSH_ONLY

فقط على staging:

```text
RADARX_STAGING_TEST_PUSH_ENABLED=true
```

ثم:

```bash
sudo systemctl restart radarx
```

شغّل الاختبار من PWA على هاتف حقيقي.

**المعيار النهائي للنجاح:** الإشعار يظهر فعليًا على الهاتف، ثم يتم receipt acknowledgment الصحيح ويرتفع `staging_push_validation_status` إلى `VALIDATED`.

`HTTP 202` أو `status=SENT` وحدهما لا يكفيان.

### 12. بعد اختبار الهاتف

أعد:

```text
RADARX_STAGING_TEST_PUSH_ENABLED=false
```

ثم:

```bash
sudo systemctl restart radarx
```

### 13. LIVE_MARKET_SIGNAL

قبل `VALIDATED`:

```text
Paper Signal = مستمر
Audit = مستمر
LIVE_MARKET_SIGNAL Push = محجوب
```

لا يجوز تخطي البوابة بناءً على نجاح مزود Push فقط.

### 14. Rollback

سجل Commit الحالي وCommit سابق معروف.

```bash
sudo systemctl stop radarx
sudo -u radarx git -C /opt/radarx fetch --all
sudo -u radarx git -C /opt/radarx checkout <KNOWN_GOOD_COMMIT>
sudo -u radarx -H bash -lc 'cd /opt/radarx && npm ci --omit=dev'
sudo systemctl start radarx
curl -fsS https://radarx.example.com/healthz
curl -fsS https://radarx.example.com/readyz
```

### 15. Backup / Restore

Backup:

```bash
sudo install -d -m 700 /var/backups/radarx
sudo tar -C /var/lib -czf /var/backups/radarx/radarx-$(date +%Y%m%d-%H%M%S).tar.gz radarx
sudo chmod 600 /var/backups/radarx/*.tar.gz
```

Restore:

```bash
sudo systemctl stop radarx
sudo tar -C /var/lib -xzf /var/backups/radarx/<KNOWN-BACKUP>.tar.gz
sudo chown -R radarx:radarx /var/lib/radarx
sudo systemctl start radarx
```

أرشيف الأسرار لا يوضع في Git؛ يُخزن منفصلًا ومشفرًا.
