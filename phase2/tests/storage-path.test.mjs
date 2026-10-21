import assert from 'node:assert/strict';
import test from 'node:test';
import {isMountPoint,resolveArchiveStorage,resolveBuildMetadata} from '../deploy/storage-path.mjs';

test('detects an exact /data mount from the Linux mount table',()=>{
  const mounts=[
    'overlay / overlay rw,relatime 0 0',
    '/dev/vdb /data ext4 rw,relatime 0 0',
    '/dev/vdc /var/lib/data ext4 rw,relatime 0 0'
  ].join('\n');
  assert.equal(isMountPoint(mounts,'/data'),true);
  assert.equal(isMountPoint(mounts,'/data/cache'),false);
  assert.equal(isMountPoint(mounts,'/data2'),false);
});

test('uses the actual /data volume on a non-Railway host and migrates local archives once',()=>{
  const result=resolveArchiveStorage({onRailway:false,dataVolumeMounted:true});
  assert.equal(result.dir,'/data/.radarx-data');
  assert.equal(result.legacyDir,'./.radarx-data');
  assert.equal(result.volumeMountPath,'/data');
  assert.equal(result.selectedFromDataVolume,true);
});

test('does not claim persistent storage when /data is not mounted in local/container dev',()=>{
  const result=resolveArchiveStorage({onRailway:false,dataVolumeMounted:false});
  assert.equal(result.dir,'./.radarx-data');
  assert.equal(result.legacyDir,null);
  assert.equal(result.volumeMountPath,null);
  assert.equal(result.selectedFromDataVolume,false);
});

test('explicit archive path has priority and remains diagnosable',()=>{
  const result=resolveArchiveStorage({configuredDir:'/data/radarx-archive',onRailway:false,dataVolumeMounted:true});
  assert.equal(result.dir,'/data/radarx-archive');
  assert.equal(result.legacyDir,'./.radarx-data');
  assert.equal(result.volumeMountPath,'/data');
});

test('resolves build and deployment provenance across platform-neutral environment names',()=>{
  assert.deepEqual(resolveBuildMetadata({
    RADARX_BUILD_COMMIT:'abc123',
    RADARX_BUILD_BRANCH:'build224-release',
    RADARX_SERVICE_ID:'radarx-backend',
    RADARX_DEPLOYMENT_ID:'deploy-9',
    GITHUB_SHA:'ignored',
    RAILWAY_GIT_BRANCH:'ignored-branch'
  }),{
    build_commit:'abc123',
    build_branch:'build224-release',
    service_id:'radarx-backend',
    deployment_id:'deploy-9'
  });
});

test('supports common GitHub/Git metadata fallbacks without fabricating a commit',()=>{
  assert.deepEqual(resolveBuildMetadata({GITHUB_SHA:'def456',GITHUB_REF_NAME:'branch-x'}),{
    build_commit:'def456',build_branch:'branch-x',service_id:null,deployment_id:null
  });
  assert.equal(resolveBuildMetadata({}).build_commit,null);
});

console.log('storage-path.test.mjs: PASS');
