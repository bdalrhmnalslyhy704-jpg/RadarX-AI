import fs from 'node:fs/promises';

const raw = String(process.env.RADARX_BACKEND_BASE_URL || '').trim();
if (!raw) {
  throw new Error('RADARX_BACKEND_BASE_URL is required: set this GitHub repository variable to the existing DHDTech backend HTTPS origin.');
}
let parsed;
try { parsed = new URL(raw); } catch { throw new Error('RADARX_BACKEND_BASE_URL must be a valid HTTPS origin'); }
if (parsed.protocol !== 'https:' || parsed.username || parsed.password ||
    parsed.pathname !== '/' || parsed.search || parsed.hash || raw !== parsed.origin ||
    (parsed.port && parsed.port !== '443')) {
  throw new Error('RADARX_BACKEND_BASE_URL must be a bare HTTPS origin on port 443, without a path, credentials, query, or trailing slash');
}
const origin = parsed.origin;
const oldPrimary = 'https://radarx-ai-triple-production.up.railway.app';
const oldFallback = 'https://radarx-ai-production.up.railway.app';

async function update(path, transform = source => source) {
  let source = await fs.readFile(path, 'utf8');
  if (!source.includes(oldPrimary) && !source.includes(oldFallback)) {
    throw new Error('Expected legacy backend origin was not found in ' + path);
  }
  source = source.split(oldPrimary).join(origin).split(oldFallback).join(origin);
  source = transform(source);
  await fs.writeFile(path, source, 'utf8');
}

for (const path of [
  'android/app/src/main/assets/radarx-backend-client.mjs',
  'android/app/src/main/assets/radarx-backend-client.js'
]) {
  await update(path, source => {
    const fallbackPattern = /export const BACKEND_FALLBACK_URLS\s*=\s*Object\.freeze\([\s\S]*?\);/;
    if (!fallbackPattern.test(source)) throw new Error('BACKEND_FALLBACK_URLS declaration not found in ' + path);
    return source.replace(fallbackPattern, 'export const BACKEND_FALLBACK_URLS = Object.freeze([]);');
  });
}

for (const path of [
  'android/app/src/main/java/com/radarx/app/MainActivity.java',
  'android/app/src/main/java/com/radarx/app/BottomRadarActivity.java'
]) {
  await update(path, source => {
    const fallbackPattern = /private static final String BACKEND_FALLBACK_ORIGIN\s*=\s*"[^"]+";/;
    if (!fallbackPattern.test(source)) throw new Error('BACKEND_FALLBACK_ORIGIN declaration not found in ' + path);
    return source.replace(fallbackPattern, 'private static final String BACKEND_FALLBACK_ORIGIN = BACKEND_ORIGIN;');
  });
}

await update('android/app/src/main/java/com/radarx/app/TradliActivity.java', source => {
  const fallbackPattern = /private static final String FALLBACK_BACKEND_ORIGIN\s*=\s*"[^"]+";/;
  if (!fallbackPattern.test(source)) throw new Error('FALLBACK_BACKEND_ORIGIN declaration not found in TradliActivity.java');
  return source.replace(fallbackPattern, 'private static final String FALLBACK_BACKEND_ORIGIN = PRIMARY_BACKEND_ORIGIN;');
});

await update('android/app/src/main/java/com/radarx/app/RadarXPushRegistration.java');

await update('android/app/src/main/java/com/radarx/app/RadarXBackgroundMonitorService.java', source => {
  const alertFallback = /private static final String BACKEND_RADAR_ALERTS_FALLBACK\s*=\s*"[^"]+";/;
  if (!alertFallback.test(source)) throw new Error('BACKEND_RADAR_ALERTS_FALLBACK declaration not found');
  source = source.replace(alertFallback, 'private static final String BACKEND_RADAR_ALERTS_FALLBACK = BACKEND_RADAR_ALERTS;');
  source = source.replace(
    /unifiedBases\s*=\s*new String\[\]\s*\{\s*BACKEND_RADAR_ALERTS,\s*BACKEND_RADAR_ALERTS_FALLBACK\s*\};/,
    'unifiedBases = new String[] { BACKEND_RADAR_ALERTS };'
  );
  source = source.replace(
    /String\[\]\s+bases\s*=\s*\{\s*"https:\/\/[^"]+"\s*,\s*"https:\/\/[^"]+"\s*\};/,
    'String[] bases = { "' + origin + '" };'
  );
  return source;
});

console.log(JSON.stringify({configured_backend_origin:origin,legacy_railway_hosts_removed:true,primary_fallbacks_disabled:true}));
