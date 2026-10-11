import {createReadStream,createWriteStream} from 'node:fs';
import {createInterface} from 'node:readline';
import {mkdir,readFile,writeFile,rename,appendFile,stat,statfs,unlink,readdir} from 'node:fs/promises';
import {basename,join,resolve} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {Readable,Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {createGzip,gunzipSync} from 'node:zlib';
import {SCAN_JOURNEY_SCHEMA,scanJourneyFilename,validateScanJourneyCycle,scanJourneyOutcomesFromRecord,summarizeScanJourneyOutcomes,SCAN_JOURNEY_HORIZONS} from './scan-journey-ledger.mjs';
const MiB=1024*1024;
// Scheduler events are operational queue state. Hydration reads at most 5,000
// rows per radar; full scan decisions remain in the Scan Journey ledger.
const JSONL_ARCHIVE_POLICIES=Object.freeze({
  schedulerEvents:{compactAtBytes:12*MiB,retainRowsPerKey:5000,keyField:'radar',maxRetainedBytesPerKey:512*1024}
});
const ORPHAN_TEMP_SUFFIX=/\.(?:tmp|repair|outcome|compact)-\d+-\d+$/;

// Serialize a durable cycle in bounded chunks. Avoid a full JSON string + Buffer +
// gzip buffer coexisting in the V8 heap during the 496-symbol market-wide cycle.
function* jsonChunks(value, ancestors=new Set(), arrayMember=false) {
  if(value===null){yield 'null';return;}
  if(typeof value==='string'||typeof value==='boolean'){yield JSON.stringify(value);return;}
  if(typeof value==='number'){yield Number.isFinite(value)?String(value):'null';return;}
  if(typeof value==='undefined'||typeof value==='function'||typeof value==='symbol'){
    if(arrayMember)yield 'null';
    return;
  }
  if(typeof value==='bigint')throw new TypeError('Do not know how to serialize a BigInt');
  if(typeof value!=='object'){yield 'null';return;}
  if(ancestors.has(value))throw new TypeError('Converting circular structure to JSON');
  ancestors.add(value);
  try {
    if(Array.isArray(value)){
      yield '[';
      for(let i=0;i<value.length;i++){
        if(i)yield ',';
        const child=value[i];
        if(child===undefined||typeof child==='function'||typeof child==='symbol')yield 'null';
        else yield* jsonChunks(child,ancestors,true);
      }
      yield ']';
      return;
    }
    yield '{';
    let first=true;
    for(const [key,child] of Object.entries(value)){
      if(child===undefined||typeof child==='function'||typeof child==='symbol')continue;
      if(!first)yield ',';
      first=false;
      yield JSON.stringify(key);
      yield ':';
      yield* jsonChunks(child,ancestors,false);
    }
    yield '}';
  } finally {
    ancestors.delete(value);
  }
}

async function writeGzipJsonAtomic(path,value,{maxBytes=Infinity}={}) {
  const temp=path+'.tmp-'+process.pid+'-'+Date.now()+'-'+randomUUID();
  const digest=createHash('sha256');
  let bytes=0;
  const meter=new Transform({
    transform(chunk,encoding,callback){
      bytes+=chunk.length;
      if(bytes>maxBytes){
        const error=new Error('SCAN_JOURNEY_CYCLE_TOO_LARGE: compressed_bytes='+bytes+',limit_bytes='+maxBytes);
        error.code='SCAN_JOURNEY_CYCLE_TOO_LARGE';
        callback(error);
        return;
      }
      digest.update(chunk);
      callback(null,chunk);
    }
  });
  try{
    await pipeline(
      Readable.from(jsonChunks(value),{objectMode:false}),
      createGzip({level:6}),
      meter,
      createWriteStream(temp,{flags:'wx'})
    );
    const sha256=digest.digest('hex');
    await rename(temp,path);
    return {bytes,sha256};
  }catch(error){
    await unlink(temp).catch(()=>{});
    throw error;
  }
}

export class DurableStore {
  constructor({dir='./.radarx-data',freeBytesProvider=null,maxCycleArchiveBytes=24*MiB,storageReserveBytes=16*MiB}={}){
    this.dir=dir;this.queue=Promise.resolve();this.ready=false;this.lastWriteAt=null;this.migratedFiles=[];this.preExpansionOutcomeCache=undefined;
    this.freeBytesProvider=typeof freeBytesProvider==='function'?freeBytesProvider:null;
    this.maxCycleArchiveBytes=Math.max(1024*1024,Number(maxCycleArchiveBytes)||24*MiB);
    this.storageReserveBytes=Math.max(1024*1024,Number(storageReserveBytes)||16*MiB);
    this.scanJourneyDir=join(dir,'scan-journeys');
    this.files={scanJourneyManifest:join(dir,'scan-journey-manifest.json'),subscriptions:join(dir,'subscriptions.json'),settings:join(dir,'settings.json'),dedup:join(dir,'dedup.json'),signalSnapshots:join(dir,'signal-snapshots.json'),
      signals:join(dir,'signals.jsonl'),notifications:join(dir,'notifications.jsonl'),moveAlerts:join(dir,'move-alerts.jsonl'),earlyExpansionAlerts:join(dir,'early-expansion-alerts.jsonl'),preExpansionOutcomes:join(dir,'pre-expansion-outcomes.json'),
      intelligenceMemory:join(dir,'intelligence-memory.json'),strongMoveAlerts:join(dir,'strong-move-alerts.jsonl'),predictionCalibration:join(dir,'prediction-calibration.json'),rotationAlerts:join(dir,'rotation-alerts.jsonl'),liquidityAbsorptionAlerts:join(dir,'liquidity-absorption-alerts.jsonl'),kahirAlerts:join(dir,'kahir-alerts.jsonl'),doomsdayAlerts:join(dir,'doomsday-alerts.jsonl'),professorAlerts:join(dir,'professor-alerts.jsonl'),alMuqawimAlerts:join(dir,'al-muqawim-alerts.jsonl'),coinHunterAlerts:join(dir,'coin-hunter-alerts.jsonl'),whaleAccumulationAlerts:join(dir,'whale-accumulation-alerts.jsonl'),falconEyeAlerts:join(dir,'falcon-eye-alerts.jsonl'),schedulerEvents:join(dir,'scan-scheduler-events.jsonl')};}
  async init({legacyDir=null}={}){
    await mkdir(this.dir,{recursive:true});
    await mkdir(this.scanJourneyDir,{recursive:true});
    // init runs before any writers start; matching files can only be abandoned
    // atomic-write temporaries from a previous process.
    this.tempCleanup=await this.cleanupOrphanedTemporaryFiles();
    // Migrate any surviving ephemeral files only when the durable target lacks that file.
    // The copy is idempotent and never overwrites an existing archived file.
    if(legacyDir&&resolve(legacyDir)!==resolve(this.dir)){
      for(const p of Object.values(this.files)){
        let destinationExists=false;
        try{await readFile(p,'utf8');destinationExists=true;}catch{}
        if(destinationExists)continue;
        const legacyPath=join(legacyDir,basename(p));
        try{
          const contents=await readFile(legacyPath,'utf8');
          await writeFile(p,contents,{flag:'wx'});
          this.migratedFiles.push(basename(p));
        }catch{}
      }
    }
    for(const p of Object.values(this.files)){
      try{await readFile(p,'utf8');}catch{
        await writeFile(p,p.endsWith('.jsonl')?'':'{}',{flag:'wx'}).catch(()=>{});
      }
    }
    this.ready=true;return this;
  }
  async lock(fn){const p=this.queue.then(fn);this.queue=p.catch(()=>{});return p;}
  async readJson(p){try{return JSON.parse(await readFile(p,'utf8'));}catch{return{};}}
  async writeJson(p,v){
    const t=p+'.tmp-'+process.pid+'-'+Date.now();
    // The outcome ledger is a large, internal 5,000-record file. Compact JSON
    // preserves the schema while avoiding a large whitespace-heavy serialization
    // buffer on every live markout update. Other JSON files remain human-readable.
    const serialized=JSON.stringify(v,null,p===this.files.preExpansionOutcomes?0:2)+'\n';
    try{
      await writeFile(t,serialized);
      await rename(t,p);
      this.lastWriteAt=Date.now();
    }catch(error){
      await unlink(t).catch(()=>{});
      throw error;
    }
  }
  async cleanupOrphanedTemporaryFiles(){
    let deletedFiles=0,freedBytes=0,failedFiles=0;
    for(const root of [this.dir,this.scanJourneyDir]){
      let entries=[];
      try{entries=await readdir(root,{withFileTypes:true});}
      catch(error){if(error?.code==='ENOENT')continue;failedFiles++;continue;}
      for(const entry of entries){
        if(!entry.isFile()||!ORPHAN_TEMP_SUFFIX.test(entry.name))continue;
        const path=join(root,entry.name);
        try{
          const info=await stat(path);
          await unlink(path);
          deletedFiles++;freedBytes+=Math.max(0,Number(info.size)||0);
        }catch(error){if(error?.code!=='ENOENT')failedFiles++;}
      }
    }
    return {deleted_files:deletedFiles,freed_bytes:freedBytes,failed_files:failedFiles};
  }

  async compactJsonlArchive(kind,{force=false}={}){
    return this.lock(()=>this._compactJsonlArchive(kind,{force}));
  }
  async _compactJsonlArchive(kind,{force=false}={}){
    const policy=JSONL_ARCHIVE_POLICIES[kind],file=this.files[kind];
    if(!policy||!file)return {compacted:false,reason:'NO_RETENTION_POLICY'};
    let before;
    try{before=await stat(file);}catch(error){
      if(error?.code==='ENOENT')return {compacted:false,reason:'FILE_NOT_FOUND'};
      throw error;
    }
    if(!force&&before.size<policy.compactAtBytes)
      return {compacted:false,reason:'BELOW_COMPACTION_THRESHOLD',before_bytes:before.size};
    const limit=Number(policy.retainRowsPerKey??policy.retainRows);
    if(!Number.isInteger(limit)||limit<1)throw new Error('JSONL_RETENTION_LIMIT_INVALID');
    const groups=new Map();let sequence=0,inputRows=0;
    const input=createReadStream(file,{encoding:'utf8'});
    const reader=createInterface({input,crlfDelay:Infinity});
    try{
      for await(const line of reader){
        if(!line.trim())continue;
        let key='__all__';
        if(policy.keyField){
          try{
            const parsed=JSON.parse(line);
            key=String(parsed?.[policy.keyField]??'UNKNOWN');
          }catch{key='UNKNOWN';}
        }
        let group=groups.get(key);
        if(!group){group={rows:[],cursor:0};groups.set(key,group);}
        const row={sequence:sequence++,line,bytes:Buffer.byteLength(line,'utf8')+1};
        inputRows++;
        if(group.rows.length<limit)group.rows.push(row);
        else{
          group.rows[group.cursor]=row;
          group.cursor=(group.cursor+1)%limit;
        }
      }
    }finally{
      reader.close();input.destroy();
    }
    const kept=[];
    for(const group of groups.values()){
      const rows=group.rows.filter(Boolean).sort((a,b)=>a.sequence-b.sequence);
      const byteLimit=Number(policy.maxRetainedBytesPerKey??policy.maxRetainedBytes??Infinity);
      let bytes=rows.reduce((sum,row)=>sum+row.bytes,0),start=0;
      while(rows.length-start>1&&bytes>byteLimit){bytes-=rows[start].bytes;start++;}
      kept.push(...rows.slice(start));
    }
    kept.sort((a,b)=>a.sequence-b.sequence);
    const content=kept.length?kept.map(row=>row.line).join('\n')+'\n':'';
    const afterBytes=Buffer.byteLength(content,'utf8');
    if(afterBytes>=before.size)
      return {compacted:false,reason:'RETENTION_DID_NOT_REDUCE_FILE',before_bytes:before.size,after_bytes:afterBytes,input_rows:inputRows,retained_rows:kept.length};
    const temp=file+'.compact-'+process.pid+'-'+Date.now();
    try{
      await writeFile(temp,content,{flag:'wx'});
      await rename(temp,file);
    }catch(error){
      await unlink(temp).catch(()=>{});
      // Keep the source intact if a compacted copy cannot be made durable.
      throw error;
    }
    this.lastWriteAt=Date.now();
    return {compacted:true,before_bytes:before.size,after_bytes:afterBytes,input_rows:inputRows,retained_rows:kept.length};
  }
  async appendJsonlArchive(kind,values){
    const rows=(Array.isArray(values)?values:[values]).filter(x=>x&&typeof x==='object'&&!Array.isArray(x));
    const file=this.files[kind];
    if(!file)throw new Error('JSONL_ARCHIVE_KIND_UNKNOWN:'+kind);
    if(!rows.length)return {written:0};
    return this.lock(async()=>{
      await this._compactJsonlArchive(kind);
      await appendFile(file,rows.map(x=>JSON.stringify(x)).join('\n')+'\n');
      this.lastWriteAt=Date.now();
      return {written:rows.length};
    });
  }
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
  async getPredictionCalibration(symbol){
    const key=String(symbol||'').trim().toUpperCase();if(!key)return null;const a=await this.readJson(this.files.predictionCalibration);return a[key]||null;
  }
  async putPredictionCalibration(symbol,value){
    const key=String(symbol||'').trim().toUpperCase();if(!key)throw new Error('INVALID_PREDICTION_CALIBRATION_SYMBOL');
    return this.lock(async()=>{const a=await this.readJson(this.files.predictionCalibration);a[key]={...value,symbol:key,updated_at:Date.now()};await this.writeJson(this.files.predictionCalibration,a);return a[key];});
  }
  // Internal evaluation state only; no HTTP/API contract is exposed for this file.
  async getPreExpansionOutcomes(){
    // This store is owned by one backend process. Keep its parsed outcome ledger in
    // memory so the 5,000-row file is not reparsed on every radar cycle. All writes
    // still pass through the store lock and atomically refresh this cache.
    if(this.preExpansionOutcomeCache!==undefined)return this.preExpansionOutcomeCache;
    const state=await this.readJson(this.files.preExpansionOutcomes);
    this.preExpansionOutcomeCache=state;
    return state;
  }
  async updatePreExpansionOutcomes(updater){
    if(typeof updater!=='function')throw new Error('PRE_EXPANSION_OUTCOME_UPDATER_REQUIRED');
    return this.lock(async()=>{
      let current=this.preExpansionOutcomeCache;
      if(current===undefined)current=await this.readJson(this.files.preExpansionOutcomes);
      const result=await updater(current);
      if(result===false){this.preExpansionOutcomeCache=current;return current;}
      const next=result&&typeof result==='object'&&!Array.isArray(result)?result:current;
      if(next!==current){
        // Drop the original parsed snapshot before serializing the normalized state.
        // Yield once so the completed updater's stack can unwind and become collectible.
        current=null;
        await new Promise(resolve=>setImmediate(resolve));
      }
      await this.writeJson(this.files.preExpansionOutcomes,next);
      this.preExpansionOutcomeCache=next;
      return next;
    });
  }
  async getIntelligenceMemory(symbol){
    const key=String(symbol||'').trim().toUpperCase();
    if(!key)return null;
    const a=await this.readJson(this.files.intelligenceMemory);
    return a[key]||null;
  }
  async putIntelligenceMemory(symbol,value){
    const key=String(symbol||'').trim().toUpperCase();
    if(!key)throw new Error('INVALID_INTELLIGENCE_MEMORY_SYMBOL');
    return this.lock(async()=>{
      const a=await this.readJson(this.files.intelligenceMemory);
      a[key]={...value,symbol:key,updated_at:Date.now()};
      await this.writeJson(this.files.intelligenceMemory,a);
      return a[key];
    });
  }
  async appendSignalAudit(v){return this.lock(async()=>{await appendFile(this.files.signals,JSON.stringify(v)+'\n');this.lastWriteAt=Date.now();});}
  async appendNotificationAudit(v){return this.lock(async()=>{await appendFile(this.files.notifications,JSON.stringify(v)+'\n');this.lastWriteAt=Date.now();});}  async appendMoveAlert(v){return this.lock(async()=>{await appendFile(this.files.moveAlerts,JSON.stringify(v)+'\n');this.lastWriteAt=Date.now();});}
  async readMoveAlerts({sinceMs=0,limit=100}={}){const rows=await this.readRecent('moveAlerts',Math.min(500,Math.max(1,Number(limit)||100)));return rows.filter(x=>Number(x?.processed_at)>Number(sinceMs||0)).slice(0,Math.min(100,Math.max(1,Number(limit)||100)));}
  async appendStrongMoveAlert(v){return this.lock(async()=>{await appendFile(this.files.strongMoveAlerts,JSON.stringify(v)+'\n');this.lastWriteAt=Date.now();});}
  async readStrongMoveAlerts({sinceMs=0,limit=100}={}){const rows=await this.readRecent('strongMoveAlerts',Math.min(500,Math.max(1,Number(limit)||100)));return rows.filter(x=>Number(x?.processed_at)>Number(sinceMs||0)).slice(0,Math.min(100,Math.max(1,Number(limit)||100)));}
  async appendRotationAlert(v){return this.lock(async()=>{await appendFile(this.files.rotationAlerts,JSON.stringify(v)+'\n');this.lastWriteAt=Date.now();});}
  async readRotationAlerts({sinceMs=0,limit=100}={}){const rows=await this.readRecent('rotationAlerts',Math.min(500,Math.max(1,Number(limit)||100)));return rows.filter(x=>Number(x?.processed_at)>Number(sinceMs||0)).slice(0,Math.min(100,Math.max(1,Number(limit)||100)));}
  async appendLiquidityAbsorptionAlert(v){return this.lock(async()=>{await appendFile(this.files.liquidityAbsorptionAlerts,JSON.stringify(v)+'\n');this.lastWriteAt=Date.now();});}
  async readLiquidityAbsorptionAlerts({sinceMs=0,limit=100}={}){const rows=await this.readRecent('liquidityAbsorptionAlerts',Math.min(500,Math.max(1,Number(limit)||100)));return rows.filter(x=>Number(x?.processed_at)>Number(sinceMs||0)).slice(0,Math.min(100,Math.max(1,Number(limit)||100)));}
  async appendKahirAlert(v){return this.appendJsonlArchive('kahirAlerts',[v]);}
  async readKahirAlerts({sinceMs=0,limit=100}={}){const rows=await this.readRecent('kahirAlerts',Math.min(500,Math.max(1,Number(limit)||100)));return rows.filter(x=>Number(x?.processed_at)>Number(sinceMs||0)).slice(0,Math.min(100,Math.max(1,Number(limit)||100)));}
  async appendDoomsdayAlert(v){return this.lock(async()=>{await appendFile(this.files.doomsdayAlerts,JSON.stringify(v)+'\n');this.lastWriteAt=Date.now();});}
  async readDoomsdayAlerts({sinceMs=0,limit=100}={}){const rows=await this.readRecent('doomsdayAlerts',Math.min(500,Math.max(1,Number(limit)||100)));return rows.filter(x=>Number(x?.processed_at)>Number(sinceMs||0)).slice(0,Math.min(100,Math.max(1,Number(limit)||100)));}
  async appendProfessorAlert(v){return this.lock(async()=>{await appendFile(this.files.professorAlerts,JSON.stringify(v)+'\n');this.lastWriteAt=Date.now();});}
  async appendAlMuqawimAlert(v){return this.lock(async()=>{await appendFile(this.files.alMuqawimAlerts,JSON.stringify(v)+'\n');this.lastWriteAt=Date.now();});}
  async readAlMuqawimAlerts({sinceMs=0,limit=100}={}){const rows=await this.readRecent('alMuqawimAlerts',Math.min(500,Math.max(1,Number(limit)||100)));return rows.filter(x=>Number(x?.processed_at)>Number(sinceMs||0)).slice(0,Math.min(100,Math.max(1,Number(limit)||100)));}
  async appendEarlyExpansionAlert(v){return this.lock(async()=>{await appendFile(this.files.earlyExpansionAlerts,JSON.stringify(v)+'\n');this.lastWriteAt=Date.now();});}
  async readEarlyExpansionAlerts({sinceMs=0,limit=100}={}){const safeLimit=Math.min(500,Math.max(1,Number(limit)||100));const rows=await this.readRecent('earlyExpansionAlerts',500);return rows.filter(x=>Number(x?.processed_at??x?.detected_at??0)>Number(sinceMs||0)).sort((a,b)=>Number(a?.processed_at??a?.detected_at??0)-Number(b?.processed_at??b?.detected_at??0)).slice(0,safeLimit);}
  async appendScanSchedulerEvents(events){
    return this.appendJsonlArchive('schedulerEvents',events);
  }
  async readScanSchedulerEvents({radar=null,symbol=null,sinceMs=0,limit=1000}={}){
    const safeLimit=Math.min(5000,Math.max(1,Number(limit)||1000));
    const targetRadar=radar?String(radar).toUpperCase():null;
    const targetSymbol=symbol?String(symbol).toUpperCase():null;
    // Filter while streaming, then retain the newest N records for this radar.
    // Applying a global last-N cap first lets a busy radar evict another radar's state.
    const rows=[];
    let cursor=0;
    try{
      await this.lock(async()=>{
        const input=createReadStream(this.files.schedulerEvents,{encoding:'utf8'});
        const reader=createInterface({input,crlfDelay:Infinity});
        try{
          for await(const line of reader){
            if(!line.trim())continue;
            let event;
            try{event=JSON.parse(line);}catch{continue;}
            if(targetRadar&&String(event?.radar||'').toUpperCase()!==targetRadar)continue;
            if(targetSymbol&&String(event?.symbol||'').toUpperCase()!==targetSymbol)continue;
            if(Number(event?.event_at||0)<Number(sinceMs||0))continue;
            if(rows.length<safeLimit)rows.push(event);
            else{rows[cursor]=event;cursor=(cursor+1)%safeLimit;}
          }
        }finally{
          reader.close();
          input.destroy();
        }
      });
    }catch{return[];}
    return rows.sort((a,b)=>Number(a?.event_at||0)-Number(b?.event_at||0));
  }
  async appendFalconEyeAlert(v){return this.lock(async()=>{await appendFile(this.files.falconEyeAlerts,JSON.stringify(v)+'\n');this.lastWriteAt=Date.now();});}
  async readFalconEyeAlerts({sinceMs=0,limit=100}={}){const safeLimit=Math.min(100,Math.max(1,Number(limit)||100));const rows=await this.readRecent('falconEyeAlerts',500);return rows.filter(x=>Number(x?.processed_at)>Number(sinceMs||0)).sort((a,b)=>Number(a?.processed_at||0)-Number(b?.processed_at||0)).slice(0,safeLimit);}
  async readProfessorAlerts({sinceMs=0,limit=100}={}){const rows=await this.readRecent('professorAlerts',Math.min(500,Math.max(1,Number(limit)||100)));return rows.filter(x=>Number(x?.processed_at)>Number(sinceMs||0)).slice(0,Math.min(100,Math.max(1,Number(limit)||100)));}
  async readKahirAlerts({sinceMs=0,limit=100}={}){const rows=await this.readRecent('kahirAlerts',Math.min(500,Math.max(1,Number(limit)||100)));return rows.filter(x=>Number(x?.processed_at)>Number(sinceMs||0)).slice(0,Math.min(100,Math.max(1,Number(limit)||100)));}
  async appendCoinHunterAlert(v){return this.lock(async()=>{await appendFile(this.files.coinHunterAlerts,JSON.stringify(v)+'\n');this.lastWriteAt=Date.now();});}
  async readCoinHunterAlerts({sinceMs=0,limit=100}={}){const take=Math.min(100,Math.max(1,Math.trunc(Number(limit)||100)));const rows=await this.readRecent('coinHunterAlerts',Math.min(500,take));return rows.filter(x=>Number(x?.processed_at??x?.detected_at??0)>Number(sinceMs||0)).slice(0,take);}
  async appendWhaleAccumulationAlert(v){return this.lock(async()=>{await appendFile(this.files.whaleAccumulationAlerts,JSON.stringify(v)+'\n');this.lastWriteAt=Date.now();});}
  async readWhaleAccumulationAlerts({sinceMs=0,limit=100}={}){const take=Math.min(100,Math.max(1,Math.trunc(Number(limit)||100)));const rows=await this.readRecent('whaleAccumulationAlerts',Math.min(500,take));return rows.filter(x=>Number(x?.processed_at??x?.detected_at??0)>Number(sinceMs||0)).slice(0,take);}

  scanJourneyState(raw={}) {
    const s=raw&&typeof raw==='object'?raw:{};
    return {
      schema_version:SCAN_JOURNEY_SCHEMA,
      cycles:Array.isArray(s.cycles)?s.cycles:[],
      cycle_sequence:Math.max(0,Number(s.cycle_sequence)||0),
      total_recorded_cycles:Math.max(0,Number(s.total_recorded_cycles)||0),
      pruned_cycle_count:Math.max(0,Number(s.pruned_cycle_count)||0),
      retained_coin_rows:Math.max(0,Number(s.retained_coin_rows)||0),
      compressed_bytes:Math.max(0,Number(s.compressed_bytes)||0),
      last_micro_cycle_by_symbol:s.last_micro_cycle_by_symbol&&typeof s.last_micro_cycle_by_symbol==='object'?s.last_micro_cycle_by_symbol:{},
      last_deep_cycle_by_symbol:s.last_deep_cycle_by_symbol&&typeof s.last_deep_cycle_by_symbol==='object'?s.last_deep_cycle_by_symbol:{},
      last_deep_at_by_symbol:s.last_deep_at_by_symbol&&typeof s.last_deep_at_by_symbol==='object'?s.last_deep_at_by_symbol:{},
      eligible_since_by_symbol:s.eligible_since_by_symbol&&typeof s.eligible_since_by_symbol==='object'?s.eligible_since_by_symbol:{},
      updated_at:Math.max(0,Number(s.updated_at)||0)
    };
  }
  async getScanJourneyState(){
    return this.scanJourneyState(await this.readJson(this.files.scanJourneyManifest));
  }
  async scanJourneyWriteBudget(){
    let freeBytes=null;
    try{
      if(this.freeBytesProvider)freeBytes=Number(await this.freeBytesProvider(this.dir));
      else {
        const fs=await statfs(this.dir);
        freeBytes=Number(fs.bavail)*Number(fs.bsize);
      }
    }catch{return {free_bytes:null,max_write_bytes:this.maxCycleArchiveBytes,capacity_checked:false};}
    if(!Number.isFinite(freeBytes)||freeBytes<0)
      return {free_bytes:null,max_write_bytes:this.maxCycleArchiveBytes,capacity_checked:false};
    const maxWriteBytes=Math.min(this.maxCycleArchiveBytes,freeBytes-this.storageReserveBytes);
    if(maxWriteBytes<1024*1024){
      const error=new Error('SCAN_JOURNEY_STORAGE_PRESSURE: free_bytes='+Math.floor(freeBytes)+',reserve_bytes='+this.storageReserveBytes);
      error.code='SCAN_JOURNEY_STORAGE_PRESSURE';
      error.freeBytes=Math.floor(freeBytes);
      error.reserveBytes=this.storageReserveBytes;
      throw error;
    }
    return {free_bytes:Math.floor(freeBytes),max_write_bytes:Math.floor(maxWriteBytes),capacity_checked:true};
  }
  async appendScanJourneyCycle(cycle,{maxBytes=160*1024*1024}={}){
    const validation=validateScanJourneyCycle(cycle);
    if(!validation.valid)throw new Error('SCAN_JOURNEY_INVALID:'+validation.errors.join(','));
    const cycleId=String(cycle.cycle_id);
    const filename=scanJourneyFilename(cycleId);
    const max=Math.max(1024*1024,Number(maxBytes)||160*1024*1024);
    return this.lock(async()=>{
      const state=this.scanJourneyState(await this.readJson(this.files.scanJourneyManifest));
      const prior=state.cycles.find(x=>x.cycle_id===cycleId);
      const existingPath=prior?join(this.scanJourneyDir,prior.filename):null;
      if(prior){
        try{
          const existing=await readFile(existingPath);
          const digest=createHash('sha256').update(existing).digest('hex');
          if(prior.sha256===digest){
            const existingCycle=JSON.parse(gunzipSync(existing).toString('utf8'));
            if(existingCycle.cycle_id===cycleId)return {duplicate:true,repaired:false,cycle_id:cycleId,cycle_sequence:prior.cycle_sequence,retained_cycles:state.cycles.length,retained_coin_rows:state.retained_coin_rows,compressed_bytes:state.compressed_bytes,pruned_cycle_count:state.pruned_cycle_count};
          }
        }catch{}
        // Repair a missing/corrupt copy from the repeated deterministic cycle id.
        // Keep its sequence and counters unchanged: repair is not a second event.
        const budget=await this.scanJourneyWriteBudget();
        const repaired=await writeGzipJsonAtomic(existingPath,{...cycle,cycle_sequence:prior.cycle_sequence},{maxBytes:budget.max_write_bytes});
        state.compressed_bytes=Math.max(0,state.compressed_bytes-Number(prior.compressed_bytes||0)+repaired.bytes);
        prior.compressed_bytes=repaired.bytes;
        prior.sha256=repaired.sha256;
        prior.stored_at=Date.now();
        state.updated_at=Date.now();
        await this.writeJson(this.files.scanJourneyManifest,state);
        return {duplicate:true,repaired:true,cycle_id:cycleId,cycle_sequence:prior.cycle_sequence,retained_cycles:state.cycles.length,retained_coin_rows:state.retained_coin_rows,compressed_bytes:state.compressed_bytes,pruned_cycle_count:state.pruned_cycle_count};
      }
      const sequence=Math.max(state.cycle_sequence+1,Math.trunc(Number(cycle.cycle_number)||0));
      const stored={...cycle,cycle_sequence:sequence};
      const budget=await this.scanJourneyWriteBudget();
      const finalPath=join(this.scanJourneyDir,filename);
      const archived=await writeGzipJsonAtomic(finalPath,stored,{maxBytes:budget.max_write_bytes});
      const coins=Array.isArray(cycle.coins)?cycle.coins:[];
      const eligible=coins.filter(x=>x&&x.eligible===true);
      const metadata={
        cycle_id:cycleId,filename,cycle_sequence:sequence,
        started_at:cycle.started_at??null,completed_at:cycle.completed_at??null,
        coin_count:coins.length,eligible_count:eligible.length,
        fast_count:coins.filter(x=>x?.fast_scan_at!==undefined&&x.fast_scan_at!=='.INCOMPLETE'&&x.fast_scan_at!==null).length,
        micro_count:coins.filter(x=>x?.micro_scan_completed_at!==undefined&&x.micro_scan_completed_at!=='.INCOMPLETE'&&x.micro_scan_completed_at!==null).length,
        deep_count:coins.filter(x=>x?.deep_scan_status==='COMPLETED').length,
        deep_failed_count:coins.filter(x=>x?.deep_scan_status==='FAILED').length,
        outcome_signal_ids:coins.map(x=>x?.outcome_signal_id).filter(x=>typeof x==='string'&&x&&x!=='.INCOMPLETE'),
        outcomes_checked_at:0,
        compressed_bytes:archived.bytes,sha256:archived.sha256,stored_at:Date.now()
      };
      state.cycles.push(metadata);
      state.cycle_sequence=sequence;
      state.total_recorded_cycles+=1;
      state.retained_coin_rows+=coins.length;
      state.compressed_bytes+=archived.bytes;
      const explicitlyBelowEligibility=new Set(coins
        .filter(coin=>coin&&coin.rejection_reason==='BELOW_MIN_QUOTE_VOLUME_24H')
        .map(coin=>String(coin.symbol||'').toUpperCase()).filter(Boolean));
      // A missing ticker is a data gap, not proof the symbol lost eligibility.
      // Preserve its queue age across partial Binance replies and resets only when
      // an observed ticker clearly fails the explicit liquidity threshold.
      for(const symbol of explicitlyBelowEligibility)delete state.eligible_since_by_symbol[symbol];
      for(const coin of eligible){
        const symbol=String(coin.symbol||'').toUpperCase();
        if(!symbol)continue;
        const first=Number(coin.first_eligible_at??coin.eligibility_at);
        if(!Object.hasOwn(state.eligible_since_by_symbol,symbol))
          state.eligible_since_by_symbol[symbol]=Number.isFinite(first)?first:Date.now();
        if(coin.micro_scan_completed_at!==undefined&&coin.micro_scan_completed_at!=='.INCOMPLETE'&&coin.micro_scan_completed_at!==null)
          state.last_micro_cycle_by_symbol[symbol]=sequence;
        if(coin.deep_scan_status==='COMPLETED'&&coin.deep_scan_completed_at!==undefined&&coin.deep_scan_completed_at!=='.INCOMPLETE'&&coin.deep_scan_completed_at!==null){
          state.last_deep_cycle_by_symbol[symbol]=sequence;
          const at=Number(coin.deep_scan_completed_at);
          if(Number.isFinite(at))state.last_deep_at_by_symbol[symbol]=at;
        }
      }
      for(const key of ['last_micro_cycle_by_symbol','last_deep_cycle_by_symbol','last_deep_at_by_symbol']){
        const map=state[key],entries=Object.entries(map);
        if(entries.length>10000){
          entries.sort((a,b)=>Number(a[1]||0)-Number(b[1]||0));
          for(const [symbol] of entries.slice(0,entries.length-10000))delete map[symbol];
        }
      }
      // The Railway volume is shared with outcome and alert archives. Retain at most
      // 160 MiB of scan journeys, reserving the rest of the existing 500 MB mount for
      // signal history, outcomes, and atomic-write headroom.
      const prunedFiles=[];
      while(state.compressed_bytes>max&&state.cycles.length>1){
        const oldest=state.cycles.shift();
        prunedFiles.push(oldest.filename);
        state.compressed_bytes=Math.max(0,state.compressed_bytes-Number(oldest.compressed_bytes||0));
        state.retained_coin_rows=Math.max(0,state.retained_coin_rows-Number(oldest.coin_count||0));
        state.pruned_cycle_count+=1;
      }
      state.updated_at=Date.now();
      await this.writeJson(this.files.scanJourneyManifest,state);
      for(const oldFile of prunedFiles)await import('node:fs/promises').then(fs=>fs.unlink(join(this.scanJourneyDir,oldFile)).catch(()=>{}));
      return {duplicate:false,cycle_id:cycleId,cycle_sequence:sequence,retained_cycles:state.cycles.length,retained_coin_rows:state.retained_coin_rows,compressed_bytes:state.compressed_bytes,pruned_cycle_count:state.pruned_cycle_count,cycle_coin_rows:coins.length};
    });
  }
  async refreshScanJourneyOutcomes(records,{limit=24,now=Date.now(),checkIntervalMs=60_000}={}){
    const byId=new Map((Array.isArray(records)?records:[])
      .filter(x=>x&&typeof x.signal_id==='string'&&x.signal_id)
      .map(x=>[x.signal_id,x]));
    const take=Math.max(1,Math.min(100,Math.trunc(Number(limit)||24)));
    const interval=Math.max(5_000,Number(checkIntervalMs)||60_000);
    return this.lock(async()=>{
      const state=this.scanJourneyState(await this.readJson(this.files.scanJourneyManifest));
      const candidates=state.cycles
        .filter(x=>!Array.isArray(x.outcome_signal_ids)||x.outcome_signal_ids.length>0)
        .filter(x=>Math.max(0,Number(now)-Number(x.outcomes_checked_at||0))>=interval)
        .sort((a,b)=>Number(a.outcomes_checked_at||0)-Number(b.outcomes_checked_at||0)||Number(a.cycle_sequence||0)-Number(b.cycle_sequence||0))
        .slice(0,take);
      let checkedCycles=0,updatedCycles=0,updatedCoinRows=0,missingFiles=0,corruptFiles=0;
      for(const metadata of candidates){
        const filePath=join(this.scanJourneyDir,metadata.filename);
        let cycle,bytes;
        try{
          bytes=await readFile(filePath);
          if(!metadata.sha256||createHash('sha256').update(bytes).digest('hex')!==metadata.sha256){
            corruptFiles++;continue;
          }
          cycle=JSON.parse(gunzipSync(bytes).toString('utf8'));
          if(cycle.cycle_id!==metadata.cycle_id||!Array.isArray(cycle.coins)){
            corruptFiles++;continue;
          }
        }catch(error){
          if(error?.code==='ENOENT')missingFiles++;else corruptFiles++;
          continue;
        }
        const ids=[...new Set(cycle.coins.map(x=>x?.outcome_signal_id)
          .filter(x=>typeof x==='string'&&x&&x!=='.INCOMPLETE'))];
        let cycleChanged=false,coinUpdates=0;
        for(const coin of cycle.coins){
          const id=coin?.outcome_signal_id;
          if(typeof id!=='string'||!id||id==='.INCOMPLETE')continue;
          const outcome=byId.get(id);
          if(!outcome)continue;
          const mapped=scanJourneyOutcomesFromRecord(outcome);
          if(JSON.stringify(coin.outcomes)!==JSON.stringify(mapped)){
            coin.outcomes=mapped;coinUpdates++;cycleChanged=true;
          }
        }
        const outcomeSummary=summarizeScanJourneyOutcomes(cycle.coins);
        const nextCounters={
          ...(cycle.counters||{}),
          outcomes_tracked_total:outcomeSummary.tracked_total,
          outcomes_untracked_total:outcomeSummary.untracked_total,
          outcomes_by_horizon:outcomeSummary.by_horizon
        };
        if(JSON.stringify(cycle.counters?.outcomes_by_horizon)!==JSON.stringify(nextCounters.outcomes_by_horizon)||
           cycle.counters?.outcomes_tracked_total!==nextCounters.outcomes_tracked_total||
           cycle.counters?.outcomes_untracked_total!==nextCounters.outcomes_untracked_total){
          cycle.counters=nextCounters;cycleChanged=true;
        }
        if(cycleChanged){
          cycle.outcomes_updated_at=Number(now);
          const budget=await this.scanJourneyWriteBudget();
          const compressed=await writeGzipJsonAtomic(filePath,cycle,{maxBytes:budget.max_write_bytes});
          state.compressed_bytes=Math.max(0,state.compressed_bytes-Number(metadata.compressed_bytes||0)+compressed.bytes);
          metadata.compressed_bytes=compressed.bytes;
          metadata.sha256=compressed.sha256;
          metadata.stored_at=Number(now);
          updatedCycles++;updatedCoinRows+=coinUpdates;
        }
        metadata.outcome_signal_ids=ids.filter(id=>{
          const outcome=byId.get(id);
          if(!outcome)return true;
          return !SCAN_JOURNEY_HORIZONS.every(h=>{
            const mapped=scanJourneyOutcomesFromRecord(outcome)[h];
            return mapped.status==='COMPLETE';
          });
        });
        metadata.outcomes_checked_at=Number(now);
        metadata.outcome_tracked_total=outcomeSummary.tracked_total;
        metadata.outcome_complete_total=Object.values(outcomeSummary.by_horizon['24h']||{}).length
          ? outcomeSummary.by_horizon['24h'].complete:0;
        checkedCycles++;
        state.updated_at=Number(now);
        await this.writeJson(this.files.scanJourneyManifest,state);
      }
      return {checked_cycles:checkedCycles,updated_cycles:updatedCycles,updated_coin_rows:updatedCoinRows,
        missing_files:missingFiles,corrupt_files:corruptFiles,pending_cycles:state.cycles.filter(x=>Array.isArray(x.outcome_signal_ids)&&x.outcome_signal_ids.length>0).length,
        retained_cycles:state.cycles.length,retained_coin_rows:state.retained_coin_rows,compressed_bytes:state.compressed_bytes};
    });
  }
  async verifyScanJourneyArchive(){
    const state=await this.getScanJourneyState();
    const missingCycles=[],corruptCycles=[];
    let readableCycles=0,readableCoinRows=0,verifiedBytes=0;
    for(const entry of state.cycles){
      try{
        const bytes=await readFile(join(this.scanJourneyDir,entry.filename));
        if(!entry.sha256||createHash('sha256').update(bytes).digest('hex')!==entry.sha256){
          corruptCycles.push(entry.cycle_id);continue;
        }
        const cycle=JSON.parse(gunzipSync(bytes).toString('utf8'));
        if(cycle.cycle_id!==entry.cycle_id||!Array.isArray(cycle.coins)){
          corruptCycles.push(entry.cycle_id);continue;
        }
        readableCycles++;readableCoinRows+=cycle.coins.length;verifiedBytes+=bytes.length;
      }catch(error){
        if(error?.code==='ENOENT')missingCycles.push(entry.cycle_id);
        else corruptCycles.push(entry.cycle_id);
      }
    }
    return {schema_version:SCAN_JOURNEY_SCHEMA,expected_cycles:state.cycles.length,readable_cycles:readableCycles,
      expected_coin_rows:state.retained_coin_rows,readable_coin_rows:readableCoinRows,verified_bytes:verifiedBytes,
      missing_cycles:missingCycles,corrupt_cycles:corruptCycles,
      complete:missingCycles.length===0&&corruptCycles.length===0&&readableCycles===state.cycles.length&&readableCoinRows===state.retained_coin_rows};
  }
  /**
   * Rehydrate only recent, verified closed-candle history already persisted in the
   * Scan Journey archive. This is a read-only archive lookup: it makes no REST calls
   * and never relaxes the market-wide cache's freshness/continuity gate.
   */
  async readScanJourneyCandleHistory({
    symbols=[],timeframe='5m',minCandles=60,maxCandles=96,maxCycles=50,
    maxAgeMs=8*60_000,now=Date.now()
  }={}){
    const intervalMs={'1m':60_000,'5m':5*60_000,'15m':15*60_000,'1h':60*60_000,'4h':4*60*60_000}[String(timeframe)];
    if(!intervalMs)throw new Error('SCAN_JOURNEY_CANDLE_TIMEFRAME_UNSUPPORTED');
    const wanted=new Set((Array.isArray(symbols)?symbols:[])
      .map(value=>String(value||'').trim().toUpperCase())
      .filter(symbol=>/^[A-Z0-9]{2,25}USDT$/.test(symbol)));
    const cutoff=Number(now);
    if(!Number.isFinite(cutoff)||cutoff<=0)throw new Error('SCAN_JOURNEY_CANDLE_NOW_INVALID');
    const minimum=Math.max(2,Math.min(180,Math.trunc(Number(minCandles)||60)));
    const maximum=Math.max(minimum,Math.min(180,Math.trunc(Number(maxCandles)||96)));
    const cycleLimit=Math.max(1,Math.min(100,Math.trunc(Number(maxCycles)||50)));
    const freshness=Math.max(0,Number.isFinite(Number(maxAgeMs))?Number(maxAgeMs):8*60_000);
    const state=await this.getScanJourneyState();
    const history=state.cycles.slice(-cycleLimit).reverse();
    const resolved=new Set(),series={};
    let cyclesExamined=0,unreadableCycles=0,invalidCycles=0,snapshotsExamined=0;
    let staleSymbols=0,invalidSymbols=0;
    const finite=value=>value!==null&&value!==undefined&&
      !(typeof value==='string'&&value.trim()==='')&&Number.isFinite(Number(value));
    for(const metadata of history){
      if(resolved.size>=wanted.size)break;
      let cycle;
      cyclesExamined++;
      try{
        const bytes=await readFile(join(this.scanJourneyDir,metadata.filename));
        if(!metadata.sha256||createHash('sha256').update(bytes).digest('hex')!==metadata.sha256){
          invalidCycles++;continue;
        }
        cycle=JSON.parse(gunzipSync(bytes).toString('utf8'));
        if(cycle?.cycle_id!==metadata.cycle_id||cycle?.radar!=='RADAR_8'||cycle?.status!=='COMPLETE'||!Array.isArray(cycle?.coins)){
          invalidCycles++;continue;
        }
      }catch(error){
        if(error?.code==='ENOENT')unreadableCycles++;
        else invalidCycles++;
        continue;
      }
      for(const coin of cycle.coins){
        const symbol=String(coin?.symbol||'').trim().toUpperCase();
        if(!wanted.has(symbol)||resolved.has(symbol)||coin?.eligible!==true)continue;
        const raw=coin?.candles_used?.[timeframe];
        if(!Array.isArray(raw)||raw.length===0)continue;
        snapshotsExamined++;
        // Once a symbol has a newer real snapshot, older snapshots can never make it
        // fresher; resolve it even if it is stale or fails candle integrity checks.
        resolved.add(symbol);
        const rows=raw.slice(-maximum);
        const validRows=rows.length>=minimum&&rows.every((row,index)=>{
          const openTime=Number(row?.open_time),closeTime=Number(row?.close_time);
          const open=Number(row?.open),high=Number(row?.high),low=Number(row?.low),close=Number(row?.close);
          const volume=Number(row?.volume);
          if(![openTime,closeTime,open,high,low,close,volume].every(Number.isFinite))return false;
          if(openTime<=0||closeTime!==openTime+intervalMs-1||closeTime>cutoff||
             open<=0||close<=0||low<=0||high<Math.max(open,close)||low>Math.min(open,close)||
             high<low||volume<0)return false;
          if(index>0&&openTime-Number(rows[index-1].open_time)!==intervalMs)return false;
          return true;
        });
        if(!validRows){invalidSymbols++;continue;}
        const latestClose=Number(rows.at(-1).close_time);
        if(cutoff-latestClose<0||cutoff-latestClose>freshness){staleSymbols++;continue;}
        series[symbol]=rows.map(row=>({
          symbol,openTime:Number(row.open_time),closeTime:Number(row.close_time),
          open:Number(row.open),high:Number(row.high),low:Number(row.low),close:Number(row.close),
          volume:Number(row.volume),
          quoteVolume:finite(row.quote_volume)?Number(row.quote_volume):null,
          tradeCount:finite(row.trade_count)?Number(row.trade_count):null,
          takerBuyBaseVolume:finite(row.taker_buy_base_volume)?Number(row.taker_buy_base_volume):null,
          closed:true,source:'BINANCE_PUBLIC_REST_CACHE',sourceTime:Number(row.close_time),receivedAt:cutoff
        }));
      }
    }
    return {
      timeframe,requested_symbols:wanted.size,hydrated_symbols:Object.keys(series).length,
      missing_snapshot_symbols:Math.max(0,wanted.size-resolved.size),
      stale_symbols:staleSymbols,invalid_symbols:invalidSymbols,
      cycles_examined:cyclesExamined,unreadable_cycles:unreadableCycles,
      invalid_cycles:invalidCycles,snapshots_examined:snapshotsExamined,series
    };
  }
  async readScanJourneyCycles({limit=10}={}){
    const state=await this.getScanJourneyState();
    const take=Math.max(1,Math.min(1000,Math.trunc(Number(limit)||10)));
    const rows=[];
    for(const entry of state.cycles.slice(-take).reverse()){
      try{
        const bytes=await readFile(join(this.scanJourneyDir,entry.filename));
        if(!entry.sha256||createHash('sha256').update(bytes).digest('hex')!==entry.sha256)continue;
        const cycle=JSON.parse(gunzipSync(bytes).toString('utf8'));
        if(cycle.cycle_id===entry.cycle_id&&Array.isArray(cycle.coins))rows.push(cycle);
      }catch{}
    }
    return rows;
  }

  async readAlertPage(kind,{sinceMs=0,sinceId='',radar='',limit=100}={}){
    const file=this.files[kind];
    if(!file)return[];
    const safeLimit=Math.min(1000,Math.max(1,Math.trunc(Number(limit)||100)));
    const after=Math.max(0,Number.isFinite(Number(sinceMs))?Number(sinceMs):0);
    const afterId=String(sinceId||'');
    const radarId=String(radar||'UNKNOWN_RADAR').toUpperCase();
    const compare=(a,b)=>a.at-b.at||a.cursorId.localeCompare(b.cursorId);
    const page=[];
    let input=null,lines=null;
    try{
      // Stream the full archive so replay is independent of recent-500 readers
      // without allocating the complete JSONL file in memory.
      input=createReadStream(file,{encoding:'utf8'});
      lines=createInterface({input,crlfDelay:Infinity});
      for await(const line of lines){
        if(!line.trim())continue;
        let row;
        try{row=JSON.parse(line);}catch{continue;}
        if(!row||typeof row!=='object'||Array.isArray(row))continue;
        const at=Number(row.processed_at??row.detected_at??row.detectedAt??row.event_at??0);
        if(!Number.isFinite(at)||at<=0)continue;
        const identity=String(row.id||[row.symbol||'',row.event||row.type||'',at].join(':'));
        const cursorId=radarId+'|'+identity;
        if(at<after||(at===after&&(!afterId||cursorId.localeCompare(afterId)<=0)))continue;
        const item={row,at,cursorId};
        if(page.length<safeLimit){page.push(item);continue;}
        let worst=0;
        for(let i=1;i<page.length;i++)if(compare(page[i],page[worst])>0)worst=i;
        if(compare(item,page[worst])<0)page[worst]=item;
      }
    }catch{
      // Fail closed so a partial archive read cannot advance the client cursor.
      return[];
    }finally{
      if(lines)lines.close();
      if(input&&!input.destroyed)input.destroy();
    }
    return page.sort(compare).map(item=>({...item.row,replay_cursor_at:item.at,replay_cursor_id:item.cursorId}));
  }
  async readRecent(kind,limit=100){
    const file=this.files[kind];
    if(!file)return[];
    const safeLimit=Math.max(1,Math.trunc(Number(limit)||100));
    // JSONL alert archives grow over time. Stream the file and keep only the last
    // N raw lines, rather than reading/splitting the entire archive into heap memory.
    const tail=new Array(safeLimit);
    let count=0,cursor=0,input=null,lines=null;
    try{
      input=createReadStream(file,{encoding:'utf8'});
      lines=createInterface({input,crlfDelay:Infinity});
      for await(const line of lines){
        if(!line)continue;
        tail[cursor]=line;
        cursor=(cursor+1)%safeLimit;
        count=Math.min(safeLimit,count+1);
      }
    }catch{
      return[];
    }finally{
      if(lines)lines.close();
      if(input&&!input.destroyed)input.destroy();
    }
    const first=(cursor-count+safeLimit)%safeLimit;
    const rows=[];
    for(let i=0;i<count;i++){
      try{rows.push(JSON.parse(tail[(first+i)%safeLimit]));}catch{}
    }
    return rows.reverse();
  }
  async health(){try{await mkdir(this.dir,{recursive:true});return{state:this.ready?'LIVE':'INIT',path:this.dir,last_write_at:this.lastWriteAt};}
    catch(e){return{state:'ERROR',path:this.dir,error:String(e?.message??e),last_write_at:this.lastWriteAt};}}
  static publicSubscription(s){return{id:s.id,endpoint:s.endpoint,expirationTime:s.expirationTime,created_at:s.created_at,updated_at:s.updated_at,disabled:Boolean(s.disabled)};}
}
