import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {DurableStore} from '../core/store.mjs';
import {parseMountTable,resolveDurableStorage} from '../core/persistent-storage.mjs';

test('mount table parser decodes escaped mount paths and excludes container pseudo-filesystems',()=>{
  const mounts=[
    '/dev/vdb1 /data ext4 rw,relatime 0 0',
    'overlay / overlay rw,relatime 0 0',
    'tmpfs /tmp tmpfs rw,nosuid,nodev 0 0',
    '/dev/vdc1 /mnt/radar\\040disk xfs rw,relatime 0 0'
  ].join('\n');
  assert.deepEqual(parseMountTable(mounts),[
    {mount_path:'/data',filesystem:'ext4'},
    {mount_path:'/mnt/radar disk',filesystem:'xfs'}
  ]);
});

test('DHDTech-style mounted /data disk is selected automatically for durable RadarX storage',()=>{
  const value=resolveDurableStorage({
    env:{},cwd:'/app',
    mountsContent:'/dev/vdb1 /data ext4 rw,relatime 0 0\noverlay / overlay rw 0 0'
  });
  assert.equal(value.directory,'/data/.radarx-data');
  assert.equal(value.absolute_directory,'/data/.radarx-data');
  assert.equal(value.persistent,true);
  assert.equal(value.mount_path,'/data');
  assert.equal(value.source,'AUTO_DETECTED_MOUNT');
});

test('explicit RADARX_DATA_DIR remains supported and is marked durable only inside a real mount',()=>{
  const mounted=resolveDurableStorage({
    env:{RADARX_DATA_DIR:'/data/radarx-state'},
    cwd:'/app',
    mountsContent:'/dev/vdb1 /data ext4 rw 0 0'
  });
  assert.equal(mounted.directory,'/data/radarx-state');
  assert.equal(mounted.persistent,true);
  assert.equal(mounted.mount_path,'/data');

  const ephemeral=resolveDurableStorage({
    env:{RADARX_DATA_DIR:'/app/state'},
    cwd:'/app',
    mountsContent:'overlay / overlay rw 0 0'
  });
  assert.equal(ephemeral.absolute_directory,resolve('/app/state'));
  assert.equal(ephemeral.persistent,false);
});

test('a stale explicit directory inside the container is overridden by a real mounted data volume',()=>{
  const value=resolveDurableStorage({
    env:{RADARX_DATA_DIR:'/app/.radarx-data'},cwd:'/app',
    mountsContent:'/dev/vdb1 /data ext4 rw,relatime 0 0\\noverlay / overlay rw 0 0'
  });
  assert.equal(value.directory,'/data/.radarx-data');
  assert.equal(value.persistent,true);
  assert.equal(value.mount_path,'/data');
  assert.equal(value.source,'AUTO_DETECTED_MOUNT');
});

test('container writable layer is not misreported as persistent when no data volume is mounted',()=>{
  const value=resolveDurableStorage({
    env:{},cwd:'/app',
    mountsContent:'overlay / overlay rw 0 0\ntmpfs /tmp tmpfs rw 0 0'
  });
  assert.equal(value.directory,'./.radarx-data');
  assert.equal(value.persistent,false);
  assert.equal(value.mount_path,null);
  assert.equal(value.source,'CONTAINER_FILESYSTEM_FALLBACK');
});

test('configured DHDTech mount path is used only when it exists in the mount table',()=>{
  const mounted=resolveDurableStorage({
    env:{RADARX_DATA_MOUNT_PATH:'/mnt/volume'},
    cwd:'/app',
    mountsContent:'/dev/vdc1 /mnt/volume xfs rw 0 0'
  });
  assert.equal(mounted.directory,'/mnt/volume/.radarx-data');
  assert.equal(mounted.persistent,true);

  const missing=resolveDurableStorage({
    env:{RADARX_DATA_MOUNT_PATH:'/mnt/volume'},
    cwd:'/app',
    mountsContent:'overlay / overlay rw 0 0'
  });
  assert.equal(missing.directory,'./.radarx-data');
  assert.equal(missing.persistent,false);
});

test('FCM device registry survives reopening DurableStore when its directory is on the mounted volume',async()=>{
  const root=await mkdtemp(join(tmpdir(),'radarx-persistent-device-registry-'));
  const volume=join(root,'volume');
  const installationId='123e4567-e89b-42d3-a456-426614174000';
  const token='FCM_TEST_TOKEN_'+('x'.repeat(180));
  try{
    const selected=resolveDurableStorage({
      env:{RADARX_DATA_MOUNT_PATH:volume},cwd:root,
      mountsContent:'/dev/vdb1 '+volume+' ext4 rw,relatime 0 0'
    });
    assert.equal(selected.persistent,true);
    const first=await new DurableStore({dir:selected.directory}).init();
    const created=await first.upsertFcmDevice(installationId,token);
    assert.equal(created.provider,'fcm');

    const afterRestart=await new DurableStore({dir:selected.directory}).init();
    const device=await afterRestart.getFcmDevice(installationId);
    assert.ok(device);
    assert.equal(device.installation_id,installationId);
    assert.equal(device.fcm_token,token);
    assert.equal(device.disabled,false);
  }finally{
    await rm(root,{recursive:true,force:true});
  }
});
