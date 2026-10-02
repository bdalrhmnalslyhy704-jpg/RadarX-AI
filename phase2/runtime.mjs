const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8787;
const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '0.0.0.0']);
const SECRET_ENV_NAMES = ['RADARX_AUTH_SECRET', 'VAPID_PRIVATE_KEY'];

export function resolveHost(env=process.env) {
  const raw = String(env.RADARX_HOST ?? '').trim();
  return raw || DEFAULT_HOST;
}

export function resolvePort(env=process.env) {
  const source = env.PORT != null && String(env.PORT).trim() !== ''
    ? env.PORT
    : env.RADARX_PORT;
  if (source == null || String(source).trim() === '') return DEFAULT_PORT;
  return assertValidPort(source, env.PORT != null && String(env.PORT).trim() !== '' ? 'PORT' : 'RADARX_PORT');
}

export function assertValidPort(value, name='PORT') {
  const raw = String(value ?? '').trim();
  if (!/^\d+$/.test(raw)) throw new Error(name+'_MUST_BE_INTEGER');
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(name+'_OUT_OF_RANGE');
  return port;
}

export function assertAllowedHost(host, environment, {explicit=false}={}) {
  const value = String(host ?? '').trim() || DEFAULT_HOST;
  const runtime = String(environment ?? '').trim().toLowerCase();
  if (!ALLOWED_HOSTS.has(value)) throw new Error('HOST_NOT_ALLOWED');
  if (value === '0.0.0.0' && !['staging', 'production'].includes(runtime))
    throw new Error('WILDCARD_HOST_ONLY_ALLOWED_IN_STAGING_OR_PRODUCTION');
  if (value === '0.0.0.0' && !explicit)
    throw new Error('WILDCARD_HOST_MUST_BE_EXPLICIT');
  return value;
}

export function ensureWritableDataDir(dataDir) {
  return String(dataDir ?? '').trim() || './.radarx-data';
}

export function sanitizeLogMessage(value, env=process.env) {
  let text = String(value ?? '');
  for (const name of SECRET_ENV_NAMES) {
    const secret = String(env[name] ?? '');
    if (secret) text = text.split(secret).join('[REDACTED]');
  }
  return text
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/(RADARX_AUTH_SECRET|VAPID_PRIVATE_KEY)\s*[=:]\s*[^\s,;]+/gi, '$1=[REDACTED]');
}
