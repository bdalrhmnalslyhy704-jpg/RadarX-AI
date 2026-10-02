/**
 * RadarX 6.1 APK direct-download proxy.
 * Streams the latest public GitHub Release APK through the RadarX domain
 * with Android-friendly headers and Range support.
 */
module.exports = async function handler(req, res) {
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.statusCode = 405;
      res.setHeader('Allow', 'GET, HEAD');
      return res.end('Method Not Allowed');
    }

    const assetUrl = 'https://github.com/bdalrhmnalslyhy704-jpg/RadarX-AI/releases/latest/download/RadarX-6.1.apk';
    const headers = {};
    if (req.headers && req.headers.range) headers.Range = req.headers.range;

    const upstream = await fetch(assetUrl, {
      method: req.method === 'HEAD' ? 'HEAD' : 'GET',
      redirect: 'follow',
      headers
    });

    if (!upstream.ok && upstream.status !== 206) {
      res.statusCode = upstream.status || 502;
      return res.end('APK upstream unavailable');
    }

    res.statusCode = upstream.status;
    res.setHeader('Content-Type', 'application/vnd.android.package-archive');
    res.setHeader('Content-Disposition', 'attachment; filename="RadarX-6.1.apk"');
    res.setHeader('Cache-Control', 'public, max-age=300, must-revalidate');
    res.setHeader('Accept-Ranges', upstream.headers.get('accept-ranges') || 'bytes');

    for (const name of ['content-length', 'content-range', 'etag', 'last-modified']) {
      const value = upstream.headers.get(name);
      if (value) res.setHeader(name, value);
    }

    if (req.method === 'HEAD') return res.end();
    const body = Buffer.from(await upstream.arrayBuffer());
    if (!res.getHeader('Content-Length')) res.setHeader('Content-Length', String(body.length));
    return res.end(body);
  } catch (error) {
    res.statusCode = 502;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.end('RadarX APK download gateway error');
  }
};
