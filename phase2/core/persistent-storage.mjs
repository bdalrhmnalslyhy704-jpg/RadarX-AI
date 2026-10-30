import {join,resolve,sep} from 'node:path';

const PSEUDO_FILESYSTEMS=new Set([
  'overlay','aufs','tmpfs','ramfs','devtmpfs','proc','sysfs','cgroup','cgroup2',
  'devpts','mqueue','tracefs','debugfs','securityfs','pstore','autofs','fusectl',
  'squashfs','rpc_pipefs','nsfs'
]);

const decodeMountPath=value=>String(value||'')
  .replace(/\\040/g,' ')
  .replace(/\\011/g,'\t')
  .replace(/\\134/g,'\\');

export function parseMountTable(contents=''){
  return String(contents||'').split(/\r?\n/).map(line=>{
    const fields=line.trim().split(/\s+/);
    if(fields.length<3)return null;
    const mountPath=decodeMountPath(fields[1]);
    const fsType=String(fields[2]||'').toLowerCase();
    if(!mountPath.startsWith('/')||mountPath==='/')return null;
    if(PSEUDO_FILESYSTEMS.has(fsType))return null;
    return {mount_path:mountPath,filesystem:fsType};
  }).filter(Boolean);
}

/**
 * Prefer a real mounted disk for the durable JSON store. Container writable
 * layers are not durable across redeploys; subscriptions.json includes native
 * FCM device tokens and must live on storage mounted outside the container.
 */
export function resolveDurableStorage({env=process.env,mountsContent='',cwd=process.cwd()}={}){
  const explicitDir=String(env.RADARX_DATA_DIR||env.DHDTECH_DATA_DIR||'').trim();
  const requestedMount=String(env.RADARX_DATA_MOUNT_PATH||env.DHDTECH_VOLUME_MOUNT_PATH||'').trim();
  const isRailway=Boolean(env.RAILWAY_SERVICE_ID||env.RAILWAY_ENVIRONMENT);
  const mounts=parseMountTable(mountsContent);
  const mountSet=new Set(mounts.map(x=>x.mount_path));
  const candidates=[requestedMount,'/data','/app/data','/mnt/data','/mnt/persistent','/persistent']
    .map(x=>String(x||'').trim())
    .filter((x,i,a)=>x&&a.indexOf(x)===i);
  const findBackingMount=directory=>{
    const absolute=resolve(cwd,directory);
    return mounts
      .filter(entry=>absolute===entry.mount_path||absolute.startsWith(entry.mount_path+sep))
      .sort((a,b)=>b.mount_path.length-a.mount_path.length)[0]||null;
  };
  const explicitMount=explicitDir?findBackingMount(explicitDir):null;
  const selectedMount=candidates.find(path=>mountSet.has(resolve(cwd,path)))||null;
  // A stale RADARX_DATA_DIR pointing into the writable image must never override
  // a real mounted disk. Keep an explicit directory only when it is itself backed
  // by a detected mount, or when no mounted volume is available at all.
  const directory=explicitDir&&explicitMount?explicitDir:
    selectedMount?join(selectedMount,'.radarx-data'):
    explicitDir|| (isRailway?'/data/.radarx-data':'./.radarx-data');
  const absoluteDirectory=resolve(cwd,directory);
  const backingMount=findBackingMount(directory);
  const persistent=Boolean(backingMount);
  const source=explicitDir&&explicitMount?'ENV_CONFIGURED_MOUNT_DIRECTORY':
    selectedMount?'AUTO_DETECTED_MOUNT':
    explicitDir?'ENV_CONFIGURED_DIRECTORY_EPHEMERAL':
    isRailway?'RAILWAY_DEFAULT_DIRECTORY_EPHEMERAL':
    'CONTAINER_FILESYSTEM_FALLBACK';
  return {
    directory,
    absolute_directory:absoluteDirectory,
    persistent,
    mount_path:backingMount?.mount_path||null,
    filesystem:backingMount?.filesystem||null,
    source,
    detected_mounts:mounts.map(x=>x.mount_path)
  };
}
