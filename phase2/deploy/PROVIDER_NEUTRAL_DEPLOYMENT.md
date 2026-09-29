
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
PORT=<operator-selected-port-from-environment>
RADARX_DATA_DIR=/var/lib/radarx
```

لا تستخدم `RADARX_PORT` كمنفذ إنتاج ثابت.

المنفذ الداخلي ليس واجهة عامة؛ الجدار الناري يجب أن يمنع الوصول الخارجي إليه. Caddy فقط هو الواجهة العامة.

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
