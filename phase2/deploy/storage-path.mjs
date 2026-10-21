import {resolve} from 'node:path';

function cleanPath(value) {
  const path = String(value || '').trim();
  if (!path || !path.startsWith('/')) throw new Error('ARCHIVE_MOUNT_PATH_MUST_BE_ABSOLUTE');
  return path.replace(/\/+$/, '') || '/';
}

/** Match a real mount-point entry, not merely a directory whose name begins with /data. */
export function isMountPoint(mountTable, target='/data') {
  const wanted = cleanPath(target);
  return String(mountTable || '').split(/\r?\n/).some(line => {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 3) return false;
    const mountPoint = fields[1].replace(/\\040/g, ' ');
    return mountPoint === wanted;
  });
}

/**
 * Prefer an explicitly configured path. Otherwise use /data when that exact
 * path is mounted, or when running on Railway (where /data is the configured
 * persistent volume). This keeps container-local test/dev runs on local disk.
 */
export function resolveArchiveStorage({configuredDir=null, onRailway=false, dataVolumeMounted=false}={}) {
  const explicit = String(configuredDir ?? '').trim();
  const usesDataPath = Boolean(explicit || onRailway || dataVolumeMounted);
  const dir = explicit || (usesDataPath ? '/data/.radarx-data' : './.radarx-data');
  const legacyDir = resolve(dir) !== resolve('./.radarx-data') ? './.radarx-data' : null;
  const selectedFromDataVolume = dataVolumeMounted && (dir === '/data' || dir.startsWith('/data/'));
  return {
    dir,
    legacyDir,
    volumeMountPath: selectedFromDataVolume ? '/data' : null,
    volumeMounted: Boolean(dataVolumeMounted),
    selectedFromDataVolume
  };
}

/** Use platform-neutral build metadata when the host is not Railway. */
export function resolveBuildMetadata(env=process.env) {
  const first = (...values) => {
    for (const value of values) {
      const text = String(value ?? '').trim();
      if (text) return text;
    }
    return null;
  };
  return {
    build_commit: first(env.RADARX_BUILD_COMMIT, env.GIT_COMMIT_SHA, env.GIT_COMMIT,
      env.SOURCE_VERSION, env.VCS_REF, env.RAILWAY_GIT_COMMIT_SHA, env.GITHUB_SHA),
    build_branch: first(env.RADARX_BUILD_BRANCH, env.GIT_BRANCH, env.SOURCE_BRANCH,
      env.BRANCH_NAME, env.RAILWAY_GIT_BRANCH, env.GITHUB_REF_NAME),
    service_id: first(env.RADARX_SERVICE_ID, env.DHDTECH_SERVICE_ID, env.RAILWAY_SERVICE_ID),
    deployment_id: first(env.RADARX_DEPLOYMENT_ID, env.DHDTECH_DEPLOYMENT_ID, env.RAILWAY_DEPLOYMENT_ID)
  };
}
