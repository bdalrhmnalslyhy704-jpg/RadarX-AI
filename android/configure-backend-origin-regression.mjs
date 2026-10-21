import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';

const here = new URL('.', import.meta.url);
const scriptPath = fileURLToPath(new URL('./configure-backend-origin.mjs', here));
const root = await mkdtemp(join(tmpdir(), 'radarx-backend-origin-fixture-'));
const paths = [
  'app/src/main/assets/radarx-backend-client.mjs',
  'app/src/main/assets/radarx-backend-client.js',
  'app/src/main/java/com/radarx/app/MainActivity.java',
  'app/src/main/java/com/radarx/app/BottomRadarActivity.java',
  'app/src/main/java/com/radarx/app/TradliActivity.java',
  'app/src/main/java/com/radarx/app/RadarXBackgroundMonitorService.java',
  'app/src/main/java/com/radarx/app/RadarXPushRegistration.java'
];
const fixtureOrigin = 'https://radarx-fixture.example';

try {
  for (const relative of paths) {
    const source = await readFile(new URL(relative, here), 'utf8');
    const destination = join(root, 'android', relative);
    await mkdir(dirname(destination), {recursive:true});
    await writeFile(destination, source, 'utf8');
  }

  const missingEnv = {...process.env};
  delete missingEnv.RADARX_BACKEND_BASE_URL;
  const missing = spawnSync(process.execPath, [scriptPath], {cwd:root,env:missingEnv,encoding:'utf8'});
  assert.notEqual(missing.status, 0, 'release configuration must fail closed when no backend origin is configured');
  assert.match(String(missing.stderr), /RADARX_BACKEND_BASE_URL is required/);

  for (const invalidOrigin of [
    'http://radarx-fixture.example',
    'https://radarx-fixture.example/api',
    'https://radarx-fixture.example/',
    'https://user:pass@radarx-fixture.example'
  ]) {
    const invalidEnv = {...process.env,RADARX_BACKEND_BASE_URL:invalidOrigin};
    const invalid = spawnSync(process.execPath, [scriptPath], {cwd:root,env:invalidEnv,encoding:'utf8'});
    assert.notEqual(invalid.status,0,'unsafe or non-origin backend URL must be rejected: '+invalidOrigin);
  }

  const configured = spawnSync(process.execPath, [scriptPath], {
    cwd:root,env:{...process.env,RADARX_BACKEND_BASE_URL:fixtureOrigin},encoding:'utf8'
  });
  assert.equal(configured.status,0,configured.stderr || configured.stdout);
  assert.match(configured.stdout, /"legacy_railway_hosts_removed":true/);

  const transformed = new Map();
  for (const relative of paths) {
    const source = await readFile(join(root,'android',relative),'utf8');
    transformed.set(relative,source);
    assert.ok(source.includes(fixtureOrigin),'configured origin missing from '+relative);
    assert.doesNotMatch(source,/https:\/\/radarx-ai-(?:triple-)?production\.up\.railway\.app/,
      'legacy Railway origin remains in '+relative);
  }

  for (const relative of paths.slice(0,2)) {
    assert.match(transformed.get(relative),/BACKEND_FALLBACK_URLS = Object\.freeze\(\[\]\);/);
  }
  assert.match(transformed.get(paths[2]),/BACKEND_FALLBACK_ORIGIN = BACKEND_ORIGIN;/);
  assert.match(transformed.get(paths[3]),/BACKEND_FALLBACK_ORIGIN = BACKEND_ORIGIN;/);
  assert.match(transformed.get(paths[4]),/FALLBACK_BACKEND_ORIGIN = PRIMARY_BACKEND_ORIGIN;/);
  assert.match(transformed.get(paths[5]),/BACKEND_RADAR_ALERTS_FALLBACK = BACKEND_RADAR_ALERTS;/);
  assert.match(transformed.get(paths[5]),/unifiedBases = new String\[\] \{ BACKEND_RADAR_ALERTS \};/);
  assert.match(transformed.get(paths[5]),/String\[\] bases = \{ "https:\/\/radarx-fixture\.example" \};/);
  assert.match(transformed.get(paths[6]),/BACKEND = "https:\/\/radarx-fixture\.example";/);

  console.log('Android DHDTech backend-origin configuration regression tests passed');
} finally {
  await rm(root,{recursive:true,force:true});
}
