# Low-Cost VPS — RadarX Setup

هذا هو المسار المدفوع الاحتياطي بعد Oracle Always Free.

## مثال اقتصادي: Hetzner CX23

السعر الحالي المنشور من Hetzner لـCX23 في ألمانيا/فنلندا هو تقريبًا **$6.49/شهر** قبل VAT وبدون Primary IPv4، مع 2 vCPU و4 GB RAM و40 GB تخزين. Primary IPv4 حاليًا **$0.60/شهر** قبل VAT؛ IPv6 مجاني. urlHetzner June 2026 price adjustmenthttps://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/ urlHetzner Primary IP pricinghttps://docs.hetzner.com/cloud/servers/primary-ips/overview/

تقدير عملي مع IPv4:

```text
$6.49 + $0.60 = $7.09/month
```

قبل VAT وأي مورد إضافي.

**لا يتم إنشاء الحساب أو الخادم الآن.**

## المواصفات

```text
Ubuntu Linux
2 vCPU
4 GB RAM
40 GB+ local storage
x86_64
```

CX23 خيار x86 محافظ للتوافق. لا تستخدم ARM VPS إلا بعد اختبار ARM مستقل.

## تجهيز Ubuntu

```bash
sudo apt update
sudo apt full-upgrade -y
sudo apt install -y curl ca-certificates git ufw tar gzip
```

## Node.js 24 LTS

Node.js حاليًا يدرج v24.21.0 LTS. استخدم حزمة/بنية موثوقة وراجع الإصدار بعد التثبيت. urlNode.js v24.21.0 archivehttps://nodejs.org/en/download/archive/v24.21.0

```bash
node --version
npm --version
```

## مستخدم RadarX

```bash
sudo useradd --system --create-home --home-dir /home/radarx --shell /usr/sbin/nologin radarx
sudo install -d -o radarx -g radarx -m 750 /opt/radarx
sudo install -d -o radarx -g radarx -m 750 /var/lib/radarx
sudo install -d -o root -g root -m 700 /etc/radarx
```

## الإصدار المعروف

```text
fe6db929e62ce9bf179f829e2b2bf7f28566f6a4
```

ثم:

```bash
sudo -u radarx git clone <REPOSITORY_URL> /opt/radarx
sudo -u radarx git -C /opt/radarx checkout fe6db929e62ce9bf179f829e2b2bf7f28566f6a4
sudo -u radarx -H bash -lc 'cd /opt/radarx && npm ci --omit=dev'
```

## Secrets

```text
/etc/radarx/radarx.env
```

```bash
sudo chown root:root /etc/radarx/radarx.env
sudo chmod 600 /etc/radarx/radarx.env
```

استخدم:

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

لا تضع أي قيمة حقيقية في Git.

## systemd

انسخ:

```text
phase2/deploy/systemd/radarx.service.example
```

إلى `/etc/systemd/system/radarx.service`.

```bash
sudo systemctl daemon-reload
sudo systemctl enable radarx
sudo systemctl start radarx
sudo systemctl status radarx --no-pager
```

Logs:

```bash
sudo journalctl -u radarx -n 100 --no-pager
```

## Firewall

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

لا تسمح خارجيًا بمنفذ Node الداخلي.

## Caddy وHTTPS

ثبّت Caddy من الحزمة الرسمية لنظام Ubuntu. توصي Caddy باستخدام الحزمة الرسمية على الأنظمة الإنتاجية. urlCaddy install documentationhttps://caddyserver.com/docs/install

استخدم:

```text
phase2/deploy/Caddyfile.example
```

مع hostname حقيقي عند الجاهزية، ثم:

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Caddy يوفر HTTPS تلقائيًا عند توفر hostname عام وDNS و80/443. urlCaddy Automatic HTTPShttps://caddyserver.com/docs/automatic-https

## Health / Readiness

```bash
curl -fsS https://radarx.example.com/healthz
curl -fsS https://radarx.example.com/readyz
```

## TEST_PUSH_ONLY

شغّله فقط على staging:

```text
RADARX_STAGING_TEST_PUSH_ENABLED=true
```

يجب أن يصل إلى هاتف حقيقي ويُسجّل receipt acknowledgment قبل الانتقال إلى حالة `VALIDATED`.

بعد التحقق:

```text
RADARX_STAGING_TEST_PUSH_ENABLED=false
```

ثم:

```bash
sudo systemctl restart radarx
```

## LIVE_MARKET_SIGNAL

```text
قبل الهاتف الحقيقي:
Paper Signal = ON
Audit = ON
LIVE_MARKET_SIGNAL Push = BLOCKED
```

## Rollback

```bash
sudo systemctl stop radarx
sudo -u radarx git -C /opt/radarx fetch --all
sudo -u radarx git -C /opt/radarx checkout <KNOWN_GOOD_COMMIT>
sudo -u radarx -H bash -lc 'cd /opt/radarx && npm ci --omit=dev'
sudo systemctl start radarx
```

ثم تحقق من `/healthz` و`/readyz`.

## Backup

```bash
sudo install -d -m 700 /var/backups/radarx
sudo tar -C /var/lib -czf /var/backups/radarx/radarx-$(date +%Y%m%d-%H%M%S).tar.gz radarx
sudo chmod 600 /var/backups/radarx/*.tar.gz
```

النسخ الاحتياطية المشفرة تبقى خارج Git.

## مسؤولية الأمان

في VPS اقتصادي أنت مسؤول عن:

- تحديث Ubuntu.
- SSH hardening.
- UFW / provider firewall.
- تحديث Node/Caddy.
- مراقبة systemd.
- DNS.
- تدوير الأسرار.
- النسخ الاحتياطي.
- الاستعادة.

التكلفة المنخفضة لا تلغي تكلفة الإدارة التشغيلية.
