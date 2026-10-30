import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {parseMountTable,resolveDurableStorage} from '../core/persistent-storage.mjs';

test('mount table parser decodes escaped mount paths and excludes container pseudo-filesystems',()=>{
  const mounts=[
    '/dev/vdb1 /data ext4 rw,relatime 0 0',
    'overlay / overlay rw,relatime 0 0',
    'tmpfs /tmp tmpfs rw,nosuid,nodev 0 0',
    '/dev/vdc1 /mnt/radar\\040disk xfs rw,relatime 0 0'
  ].join('\\n');
  assert.deepEqual(parseMountTable(mounts),[
    {mount_path:'/data',filesystem:'ext4'},
    {mount_path:'/mnt/radar disk',filesystem:'xfs'}
  ]);
});

test('DHDTech-style mounted /data disk is selected automatically for durable RadarX storage',()=>{
  const value=resolveDurableStorage({
    env:{},cwd:'/app',
    mountsContent:'/dev/vdb1 /data ext4 rw,relatime 0 0\\noverlay / overlay rw 0 0'
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

test('container writable layer is not misreported as persistent when no data volume is mounted',()=>{
  const value=resolveDurableStorage({
    env:{},cwd:'/app',
    mountsContent:'overlay / overlay rw 0 0\\ntmpfs /tmp tmpfs rw 0 0'
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
