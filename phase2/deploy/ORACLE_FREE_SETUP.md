# Oracle Cloud Always Free — RadarX Setup

**لا يتم إنشاء حساب أو VM بهذا الملف.**

Oracle Free Tier يوفّر موارد Always Free لا تنتهي صلاحيتها، ومنها Ampere A1 Compute بحد إجمالي يعادل 2 OCPU و12 GB RAM، و200 GB من Block Volume في Home Region. يجب أن تبقى الموارد ضمن حدود Always Free. Oracle يذكر أيضًا أن A1 قد يعرض `out of host capacity` مؤقتًا، وأن بعض مثيلات Always Free الخاملة قد تُستعاد عند انخفاض الاستخدام لفترة 7 أيام. urlOracle Always Free resourceshttps://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm

## نقطة مهمة قبل أي إنشاء

توثيق Oracle الحالي يذكر أن معظم المستخدمين يحتاجون إلى رقم هاتف وبطاقة ائتمان أثناء التسجيل للتحقق، مع عدم تحصيل الرسوم إلا بعد الترقية إلى حساب مدفوع. لذلك، مع شرط المشروع الحالي "لا بطاقة/لا دفع الآن"، **لا يتم إنشاء الحساب الآن**. urlOracle Free Tierhttps://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier.htm

## المواصفات المقترحة

```text
Ubuntu Linux
VM.Standard.A1.Flex
1–2 OCPU
4–12 GB RAM
/var/lib/radarx = persistent block storage
```

لـRadarX، تخصيص 2 OCPU و8–12 GB يترك هامشًا جيدًا ضمن حد A1 المجاني، بشرط عدم تشغيل أحمال أخرى على الحساب.

## Ubuntu

```bash
sudo apt update
sudo apt full-upgrade -y
sudo apt install -y curl ca-certificates git ufw tar gzip
```

## Node.js 24 LTS

Node.js حاليًا يدرج v24.21.0 كإصدار LTS، مع binaries لكل من Linux x64 وLinux arm64. استخدم Linux arm64 في A1، ثم تحقق من الإصدار. urlNode.js v24.21.0 archivehttps://nodejs.org/en/download/archive/v24.21.0

```bash
node --version
npm --version
```

يجب أن يبدأ Node بـ`v24.`.

## مستخدم غير root

```bash
sudo useradd --system --create-home --home-dir /home/radarx --shell /usr/sbin/nologin radarx
sudo install -d -o radarx -g radarx -m 750 /opt/radarx
sudo install -d -o radarx -g radarx -m 750 /var/lib/radarx
sudo install -d -o root -g root -m 700 /etc/radarx
```

## الإصدار

استخدم Commit معروفًا وسليمًا:

```text
fe6db929e62ce9bf179f829e2b2bf7f28566f6a4
```

مثال:

```bash
sudo -u radarx git clone <REPOSITORY_URL> /opt/radarx
sudo -u radarx git -C /opt/radarx checkout fe6db929e62ce9bf179f829e2b2bf7f28566f6a4
sudo -u radarx -H bash -lc 'cd /opt/radarx && npm ci --omit=dev'
```

## Environment خارج Git

أنشئ:

```text
/etc/radarx/radarx.env
```

ثم:

```bash
sudo chown root:root /etc/radarx/radarx.env
sudo chmod 600 /etc/radarx/radarx.env
```

الهيكل:

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
RADARX_STAGING_TEST_PUSH_ENABLED=false
RADARX_PAPER_TRADING=true
RADARX_REAL_ORDER_EXECUTION=false
RADARX_CONFIDENCE_MODE=UNKNOWN
```

لا يوجد أي secret حقيقي في Git.

## systemd

انسخ المثال:

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

## Firewall

اسمح فقط بالحد الأدنى:

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

طبّق الحد نفسه في VCN Security List/NSG.

لا تفتح منفذ Node الداخلي للعامة.

## Caddy

Caddy يوفّر HTTPS تلقائيًا عندما يكون hostname عامًا صحيحًا، مع DNS صحيح ووصول خارجي إلى 80/443. urlCaddy Automatic HTTPShttps://caddyserver.com/docs/automatic-https

استخدم:

```text
phase2/deploy/Caddyfile.example
```

ثم:

```text
/etc/caddy/Caddyfile
```

وتحقق:

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Caddy يمرر WebSocket إلى نفس backend ولا يحتاج منفذًا عامًا منفصلًا. urlCaddy WebSocket matching documentationhttps://caddyserver.com/docs/caddyfile/matchers

## Health / Readiness

بعد توفر DNS وHTTPS:

```bash
curl -fsS https://radarx.example.com/healthz
curl -fsS https://radarx.example.com/readyz
```

## TEST_PUSH_ONLY

قبل الاختبار:

```text
RADARX_STAGING_TEST_PUSH_ENABLED=true
```

ثم:

```bash
sudo systemctl restart radarx
```

النجاح الحقيقي يتطلب أن يظهر الإشعار على هاتف Android فعلي، وليس مجرد `SENT` من مزود Push.

بعد تحقق الهاتف:

```text
RADARX_STAGING_TEST_PUSH_ENABLED=false
```

ثم أعد التشغيل.

## LIVE_MARKET_SIGNAL

قبل الحالة `VALIDATED`:

```text
Paper Signal = مستمر
Audit = مستمر
LIVE_MARKET_SIGNAL Push = محجوب
```

لا يُسمح بانتقال الاختبار إلى إشارة سوق حية لمجرد نجاح استدعاء HTTP.

## Rollback

احتفظ بCommit معروف.

```bash
sudo systemctl stop radarx
sudo -u radarx git -C /opt/radarx fetch --all
sudo -u radarx git -C /opt/radarx checkout <KNOWN_GOOD_COMMIT>
sudo -u radarx -H bash -lc 'cd /opt/radarx && npm ci --omit=dev'
sudo systemctl start radarx
```

ثم تحقق من `/healthz` و`/readyz`.

## Backup

بيانات RadarX:

```text
/var/lib/radarx
```

مثال:

```bash
sudo install -d -m 700 /var/backups/radarx
sudo tar -C /var/lib -czf /var/backups/radarx/radarx-$(date +%Y%m%d-%H%M%S).tar.gz radarx
sudo chmod 600 /var/backups/radarx/*.tar.gz
```

خزن النسخة في مكان منفصل ومشفّر.

## Oracle Limits

لا تعتمد على إنشاء موارد مدفوعة تلقائيًا إذا انعدم A1 capacity. انتقل إلى خطة VPS الرخيصة بدلًا من الترقية غير المقصودة. urlOracle Always Free resourceshttps://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm

## Safety

```text
paper_trading=true
real_order_execution=false
confidence_score=UNKNOWN
```

ولا تستخدم Binance API key أو secret أو أي trading endpoint.
