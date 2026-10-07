import {mkdir,readFile,writeFile,rename,appendFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';

export class DurableStore {
  constructor({dir='./.radarx-data'}={}){this.dir=dir;this.queue=Promise.resolve();this.ready=false;this.lastWriteAt=null;
    this.files={subscriptions:join(dir,'subscriptions.json'),settings:join(dir,'settings.json'),dedup:join(dir,'dedup.json'),signalSnapshots:join(dir,'signal-snapshots.json'),
      signals:join(dir,'signals.jsonl'),notifications:join(dir,'notifications.jsonl'),moveAlerts:join(dir,'move-alerts.jsonl'),strongMoveAlerts:join(dir,'strong-move-alerts.jsonl'),rotationAlerts:join(dir,'rotation-alerts.jsonl'),liquidityAbsorptionAlerts:join(dir,'liquidity-absorption-alerts.jsonl'),kahirAlerts:join(dir,'kahir-alerts.jsonl'),doomsdayAlerts:join(dir,'doomsday-alerts.jsonl'),professorAlerts:join(dir,'professor-alerts.jsonl'),alMuqawimAlerts:join(dir,'al-muqawim-alerts.jsonl'),coinHunterAlerts:join(dir,'coin-hunter-alerts.jsonl'),whaleAccumulationAlerts:join(dir,'whale-accumulation-alerts.jsonl'),earlyExpansionAlerts:join(dir,'early-expansion-alerts.jsonl'),earlyExpansionEvents:join(dir,'early-expansion-events.jsonl')};}
  async init(){await mkdir(this.dir,{recursive:true});
    for(const [k,p] of Object.entries(this.files)){try{await readFile(p,'utf8');}catch{
      await writeFile(p,p.endsWith('.jsonl')?'':'{}',{flag:'wx'}).catch(()=>{});
    }}this.ready=true;return this;}
  async lock(fn){const p=this.queue.then(fn);this.queue=p.catch(()=>{});return p;}
  async readJson(p){try{return JSON.parse(await readFile(p,'utf8'));}catch{return{};}}
  async writeJson(p,v){const t=p+'.tmp-'+process.pid+'-'+Date.now();await writeFile(t,JSON.stringify(v,null,2)+'\n');await rename(t,p);this.lastWriteAt=Date.now();}
  async getSubscriptions(userId=null){const a=await this.readJson(this.files.subscriptions);const r=Object.values(a);
    return userId?r.filter(x=>x.user_id===userId&&!x.disabled):r.filter(x=>!x.disabled);}
  async upsertSubscription(userId,s){return this.lock(async()=>{const a=await this.readJson(this.files.subscriptions);
    const old=Object.values(a).find(x=>x.user_id===userId&&x.endpoint===s.endpoint),id=old?.id||randomUUID();
    a[id]={id,user_id:userId,endpoint:String(s.endpoint),expirationTime:s.expirationTime??null,
      keys:{p256dh:String(s?.keys?.p256dh||''),auth:String(s?.keys?.auth||'')},disabled:false,
      created_at:old?.created_at||Date.now(),updated_at:Date.now()};await this.writeJson(this.files.subscriptions,a);return a[id];});}
  async deleteSubscription(userId,id){return this.lock(async()=>{const a=await this.readJson(this.files.subscriptions);
    if(!a[id]||a[id].user_id!==userId)return false;delete a[id];await this.writeJson(this.files.subscriptions,a);return true;});}
  async disableSubscription(id){return this.lock(async()=>{const a=await this.readJson(this.files.subscriptions);if(!a[id])return false;
    a[id].disabled=true;a[id].updated_at=Date.now();await this.writeJson(this.files.subscriptions,a);return true;});}
  async getUserSettings(userId){const a=await this.readJson(this.files.settings);return a[userId]||null;}
  async putUserSettings(userId,s){return this.lock(async()=>{const a=await this.readJson(this.files.settings);a[userId]={...s,user_id:userId,updated_at:Date.now()};
    await this.writeJson(this.files.settings,a);return a[userId];});}
  async getDedupKey(k){const a=await this.readJson(this.files.dedup);return a[k]||null;}
  async putDedupKey(k,v){return this.lock(async()=>{const a=await this.readJson(this.files.dedup);a[k]=v;await this.writeJson(this.files.dedup,a);});}
  async getSignalSnapshot(symbol){const key=String(symbol||'').trim().toUpperCase();if(!key)return null;const a=await this.readJson(this.files.signalSnapshots);return a[key]||null;}
  async putSignalSnapshot(symbol,snapshot){const key=String(symbol||'').trim().toUpperCase();if(!key)throw new Error('INVALID_SIGNAL_SNAPSHOT_SYMBOL');return this.lock(async()=>{const a=await this.readJson(this.files.signalSnapshots);a[key]={...snapshot,symbol:key,updated_at:Date.now()};await this.writeJson(this.files.signalSnapshots,a);return a[key];});}
  async appendSignalAudit(v){return this.lock(async()=>{await appendFile(this.files.signals,JSON.stringify(v)+'\n');this.lastWriteAt=Date.now();});}
  async appendNotificationAudit(v){return this.lock(async()=>{await appendFile(this.files.notifications,JSON.stringify(v)+'\n');this.lastWriteAt=Date.now();});}  async appendMoveAlert(v){return this.lock(async()=>{await appendFile(this.files.moveAlerts,JSON.stringify(v)+'\n');this.lastWriteAt=Date.now();});}
  async readMoveAlerts({sinceMs=0,limit=100}={}){const rows=await this.readRecent('moveAlerts',Math.min(500,Math.max(1,Number(limit)||100)));return rows.filter(x=>Number(x?.processed_at)>Number(sinceMs||0)).slice(0,Math.min(100,Math.max(1,Number(limit)||100)));}
  async appendStrongMoveAlert(v){return this.lock(async()=>{await appendFile(this.files.strongMoveAlerts,JSON.stringify(v)+'\n');this.lastWriteAt=Date.now();});}
  async readStrongMoveAlerts({sinceMs=0,limit=100}={}){const rows=await this.readRecent('strongMoveAlerts',Math.min(500,Math.max(1,Number(limit)||100)));return rows.filter(x=>Number(x?.processed_at)>Number(sinceMs||0)).slice(0,Math.min(100,Math.max(1,Number(limit)||100)));}
  async appendRotationAlert(v){return this.lock(async()=>{await appendFile(this.files.rotationAlerts,JSON.stringify(v)+'\n');this.lastWriteAt=Date.now();});}
  async readRotationAlerts({sinceMs=0,limit=100}={}){const rows=await this.readRecent('rotationAlerts',Math.min(500,Math.max(1,Number(limit)||100)));return rows.filter(x=>Number(x?.processed_at)>Number(sinceMs||0)).slice(0,Math.min(100,Math.max(1,Number(limit)||100)));}
  async appendLiquidityAbsorptionAlert(v){return this.lock(async()=>{await appendFile(this.files.liquidityAbsorptionAlerts,JSON.stringify(v)+'\n');this.lastWriteAt=Date.now();});}
  async readLiquidityAbsorptionAlerts({sinceMs=0,limit=100}={}){const rows=await this.readRecent('liquidityAbsorptionAlerts',Math.min(500,Math.max(1,Number(limit)||100)));return rows.filter(x=>Number(x?.processed_at)>Number(sinceMs||0)).slice(0,Math.min(100,Math.max(1,Number(limit)||100)));}
  async appendKahirAlert(v){return this.lock(async()=>{await appendFile(this.files.kahirAlerts,JSON.stringify(v)+'\\n');this.lastWriteAt=Date.now();});}
  async readKahirAlerts({sinceMs=0,limit=100}={}){const rows=await this.readRecent('kahirAlerts',Math.min(500,Math.max(1,Number(limit)||100)));return rows.filter(x=>Number(x?.processed_at)>Number(sinceMs||0)).slice(0,Math.min(100,Math.max(1,Number(limit)||100)));}
  async appendDoomsdayAlert(v){return this.lock(async()=>{await appendFile(this.files.doomsdayAlerts,JSON.stringify(v)+'\n');this.lastWriteAt=Date.now();});}
  async readDoomsdayAlerts({sinceMs=0,limit=100}={}){const rows=await this.readRecent('doomsdayAlerts',Math.min(500,Math.max(1,Number(limit)||100)));return rows.filter(x=>Number(x?.processed_at)>Number(sinceMs||0)).slice(0,Math.min(100,Math.max(1,Number(limit)||100)));}
  async appendProfessorAlert(v){return this.lock(async()=>{await appendFile(this.files.professorAlerts,JSON.stringify(v)+'\n');this.lastWriteAt=Date.now();});}
  async appendAlMuqawimAlert(v){return this.lock(async()=>{await appendFile(this.files.alMuqawimAlerts,JSON.stringify(v)+'\n');this.lastWriteAt=Date.now();});}
  async readAlMuqawimAlerts({sinceMs=0,limit=100}={}){const rows=await this.readRecent('alMuqawimAlerts',Math.min(500,Math.max(1,Number(limit)||100)));return rows.filter(x=>Number(x?.processed_at)>Number(sinceMs||0)).slice(0,Math.min(100,Math.max(1,Number(limit)||100)));}
  async readProfessorAlerts({sinceMs=0,limit=100}={}){const rows=await this.readRecent('professorAlerts',Math.min(500,Math.max(1,Number(limit)||100)));return rows.filter(x=>Number(x?.processed_at)>Number(sinceMs||0)).slice(0,Math.min(100,Math.max(1,Number(limit)||100)));}
  async appendKahirAlert(v){return this.lock(async()=>{await appendFile(this.files.kahirAlerts,JSON.stringify(v)+'\\n');this.lastWriteAt=Date.now();});}
  async readKahirAlerts({sinceMs=0,limit=100}={}){const rows=await this.readRecent('kahirAlerts',Math.min(500,Math.max(1,Number(limit)||100)));return rows.filter(x=>Number(x?.processed_at)>Number(sinceMs||0)).slice(0,Math.min(100,Math.max(1,Number(limit)||100)));}

  async appendWhaleAccumulationAlert(v){return this.lock(async()=>{await appendFile(this.files.whaleAccumulationAlerts,JSON.stringify(v)+'\\n');this.lastWriteAt=Date.now();});}
  async readWhaleAccumulationAlerts({sinceMs=0,limit=100}={}){const rows=await this.readRecent('whaleAccumulationAlerts',Math.min(1000,Math.max(1,Number(limit)||100)));return rows.filter(x=>Number(x?.processed_at||x?.detected_at)>Number(sinceMs||0)).slice(0,Math.min(100,Math.max(1,Number(limit)||100)));}

  async appendCoinHunterAlert(v){return this.lock(async()=>{await appendFile(this.files.coinHunterAlerts,JSON.stringify(v)+'\n');this.lastWriteAt=Date.now();});}
  async readCoinHunterAlerts({sinceMs=0,limit=100}={}){const rows=await this.readRecent('coinHunterAlerts',Math.min(1000,Math.max(1,Number(limit)||100)));return rows.filter(x=>Number(x?.processed_at||x?.detected_at)>Number(sinceMs||0)).slice(0,Math.min(100,Math.max(1,Number(limit)||100)));}
  async appendEarlyExpansionAlert(v){return this.lock(async()=>{await appendFile(this.files.earlyExpansionAlerts,JSON.stringify(v)+'\n');this.lastWriteAt=Date.now();});}
  async readEarlyExpansionAlerts({sinceMs=0,limit=100}={}){const rows=await this.readRecent('earlyExpansionAlerts',Math.min(1000,Math.max(1,Number(limit)||100)));return rows.filter(x=>Number(x?.processed_at||x?.detected_at)>Number(sinceMs||0)).slice(0,Math.min(100,Math.max(1,Number(limit)||100)));}
  async appendEarlyExpansionEvent(v){return this.lock(async()=>{await appendFile(this.files.earlyExpansionEvents,JSON.stringify(v)+'\n');this.lastWriteAt=Date.now();});}
  async readEarlyExpansionEvents({sinceMs=0,limit=200}={}){const rows=await this.readRecent('earlyExpansionEvents',Math.min(2000,Math.max(1,Number(limit)||200)));return rows.filter(x=>Number(x?.processed_at||x?.detected_at)>Number(sinceMs||0)).slice(0,Math.min(500,Math.max(1,Number(limit)||200)));}
  async readRecent(kind,limit=100){let s='';try{s=await readFile(this.files[kind],'utf8');}catch{return[];}
    return s.split('\n').filter(Boolean).slice(-limit).reverse().map(x=>JSON.parse(x));}
  async health(){try{await mkdir(this.dir,{recursive:true});return{state:this.ready?'LIVE':'INIT',path:this.dir,last_write_at:this.lastWriteAt};}
    catch(e){return{state:'ERROR',path:this.dir,error:String(e?.message??e),last_write_at:this.lastWriteAt};}}
  static publicSubscription(s){return{id:s.id,endpoint:s.endpoint,expirationTime:s.expirationTime,created_at:s.created_at,updated_at:s.updated_at,disabled:Boolean(s.disabled)};}
}
