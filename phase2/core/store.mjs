import {createReadStream} from 'node:fs';
import {createInterface} from 'node:readline';
import {mkdir,readFile,writeFile,rename,appendFile,stat,unlink,readdir} from 'node:fs/promises';
import {basename,join,resolve} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {gzipSync,gunzipSync} from 'node:zlib';
import {SCAN_JOURNEY_SCHEMA,scanJourneyFilename,validateScanJourneyCycle,scanJourneyOutcomesFromRecord,summarizeScanJourneyOutcomes,SCAN_JOURNEY_HORIZONS} from './scan-journey-ledger.mjs';
const MiB=1024*1024;
// Scheduler events are operational queue state. Hydration reads at most 5,000
// rows per radar; full scan decisions remain in the Scan Journey ledger.
const JSONL_ARCHIVE_POLICIES=Object.freeze({
  schedulerEvents:{compactAtBytes:12*MiB,retainRowsPerKey:5000,keyField:'radar',maxRetainedBytesPerKey:512*1024}
});
const ORPHAN_TEMP_SUFFIX=/\.(?:tmp|repair|outcome|compact)-\d+-\d+$/;

// Tokenize JSON values directly from the file stream. This is deliberately a
// small purpose-built reader for startup compaction: it parses one outcome row
// at a time instead of materializing the old 5,000-row ledger in one JSON.parse.
class StreamingJsonValueReader{
  constructor(path){
    this.iterator=createReadStream(path,{encoding:'utf8'})[Symbol.asyncIterator]();
    this.buffer='';this.index=0;this.ended=false;
  }
  async fill(){
    while(this.index>=this.buffer.length&&!this.ended){
      const next=await this.iterator.next();
      if(next.done){this.buffer='';this.index=0;this.ended=true;return false;}
      this.buffer=next.value;this.index=0;
    }
    return this.index<this.buffer.length;
  }
  async peek(){return await this.fill()?this.buffer[this.index]:null;}
  async take(){const value=await this.peek();if(value!==null)this.index++;return value;}
  async skipWhitespace(){
    while(await this.fill()&&/\s/.test(this.buffer[this.index]))this.index++;
  }
  async consume(expected){
    await this.skipWhitespace();
    const actual=await this.take();
    if(actual!==expected)throw new Error('PRE_EXPANSION_OUTCOME_LEDGER_INVALID_JSON');
  }
  async readRawValue(){
    await this.skipWhitespace();
    if(!await this.fill())throw new Error('PRE_EXPANSION_OUTCOME_LEDGER_INVALID_JSON');
    const first=this.buffer[this.index];
    if(first==='"'){
      const parts=[];let escaped=false;
      this.index++;
      while(true){
        if(!await this.fill())throw new Error('PRE_EXPANSION_OUTCOME_LEDGER_INVALID_JSON');
        const start=this.index;
        for(let i=start;i<this.buffer.length;i++){
          const char=this.buffer[i];
          if(escaped)escaped=false;
          else if(char==='\\')escaped=true;
          else if(char==='"'){
            this.index=i+1;parts.push(this.buffer.slice(start,i+1));return '"'+parts.join('');
          }
        }
        parts.push(this.buffer.slice(start));this.index=this.buffer.length;
      }
    }
    if(first!=='{'&&first!=='['){
      const parts=[];
      while(await this.fill()){
        const start=this.index;let i=start;
        for(;i<this.buffer.length;i++){
          const char=this.buffer[i];
          if(char===','||char===']'||char==='}'||/\s/.test(char))break;
        }
        if(i>start)parts.push(this.buffer.slice(start,i));
        this.index=i;
        if(i<this.buffer.length)break;
      }
      const raw=parts.join('').trim();
      if(!raw)throw new Error('PRE_EXPANSION_OUTCOME_LEDGER_INVALID_JSON');
      return raw;
    }
    const stack=[];const parts=[];let inString=false;let escaped=false;
    while(true){
      if(!await this.fill())throw new Error('PRE_EXPANSION_OUTCOME_LEDGER_INVALID_JSON');
      const start=this.index;
      for(let i=start;i<this.buffer.length;i++){
        const char=this.buffer[i];
        if(inString){
          if(escaped)escaped=false;
          else if(char==='\\')escaped=true;
          else if(char==='"')inString=false;
        }else if(char==='"')inString=true;
        else if(char==='{'||char==='[')stack.push(char==='{'?'}':']');
        else if(char==='}'||char===']'){
          if(stack.pop()!==char)throw new Error('PRE_EXPANSION_OUTCOME_LEDGER_INVALID_JSON');
          if(stack.length===0){
            this.index=i+1;parts.push(this.buffer.slice(start,i+1));return parts.join('');
          }
        }
      }
      parts.push(this.buffer.slice(start));this.index=this.buffer.length;
    }
  }
}

async function readBoundedJsonArray(reader,limit){
  await reader.consume('[');
  const ring=[];let total=0;let afterComma=false;
  while(true){
    await reader.skipWhitespace();
    const next=await reader.peek();
    if(next===']'){
      if(afterComma)throw new Error('PRE_EXPANSION_OUTCOME_LEDGER_INVALID_JSON');
      await reader.take();break;
    }
    if(next===null)throw new Error('PRE_EXPANSION_OUTCOME_LEDGER_INVALID_JSON');
    let value;
    try{value=JSON.parse(await reader.readRawValue());}
    catch{throw new Error('PRE_EXPANSION_OUTCOME_LEDGER_INVALID_JSON');}
    if(total<limit)ring.push(value);
    else ring[total%limit]=value;
    total++;afterComma=false;
    await reader.skipWhitespace();
    const delimiter=await reader.peek();
    if(delimiter===','){await reader.take();afterComma=true;continue;}
    if(delimiter===']'){await reader.take();break;}
    throw new Error('PRE_EXPANSION_OUTCOME_LEDGER_INVALID_JSON');
  }
  const offset=total>limit?total%limit:0;
  const rows=total>limit?ring.slice(offset).concat(ring.slice(0,offset)):ring;
  return {rows,total};
}

async function readBoundedOutcomeLedger(path,recordLimit){
  const reader=new StreamingJsonValueReader(path);const state={};
  let totalRecords=0;let recordsSeen=false;let firstProperty=true;let afterComma=false;
  await reader.consume('{');
  while(true){
    await reader.skipWhitespace();
    const next=await reader.peek();
    if(next==='}'){
      if(afterComma)throw new Error('PRE_EXPANSION_OUTCOME_LEDGER_INVALID_JSON');
      await reader.take();break;
    }
    if(next===null)throw new Error('PRE_EXPANSION_OUTCOME_LEDGER_INVALID_JSON');
    if(!firstProperty&&!afterComma)throw new Error('PRE_EXPANSION_OUTCOME_LEDGER_INVALID_JSON');
    let key;
    try{key=JSON.parse(await reader.readRawValue());}
    catch{throw new Error('PRE_EXPANSION_OUTCOME_LEDGER_INVALID_JSON');}
    if(typeof key!=='string')throw new Error('PRE_EXPANSION_OUTCOME_LEDGER_INVALID_JSON');
    await reader.consume(':');
    if(key==='records'){
      const bounded=await readBoundedJsonArray(reader,recordLimit);
      state.records=bounded.rows;totalRecords=bounded.total;recordsSeen=true;
    }else{
      try{state[key]=JSON.parse(await reader.readRawValue());}
      catch{throw new Error('PRE_EXPANSION_OUTCOME_LEDGER_INVALID_JSON');}
    }
    firstProperty=false;afterComma=false;
    await reader.skipWhitespace();
    const delimiter=await reader.peek();
    if(delimiter===','){await reader.take();afterComma=true;continue;}
    if(delimiter==='}'){await reader.take();break;}
    throw new Error('PRE_EXPANSION_OUTCOME_LEDGER_INVALID_JSON');
  }
  await reader.skipWhitespace();
  if(await reader.peek()!==null)throw new Error('PRE_EXPANSION_OUTCOME_LEDGER_INVALID_JSON');
  if(!recordsSeen)state.records=[];
  if(!state||typeof state!=='object'||Array.isArray(state))throw new Error('PRE_EXPANSION_OUTCOME_LEDGER_INVALID_STATE');
  return {state,totalRecords};
}



export class DurableStore {
  constructor({dir='./.radarx-data'}={}){this.dir=dir;this.queue=Promise.resolve();this.schedulerEventsQueue=Promise.resolve();this.ready=false;this.lastWriteAt=null;this.migratedFiles=[];
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
  // Operational scheduler history has its own queue: slow compaction/readback of
  // this bounded journal must never block user-visible alert persistence or the
  // scan-journey ledger, which use the primary DurableStore queue.
  async schedulerEventsLock(fn){
    const p=this.schedulerEventsQueue.then(fn);
    this.schedulerEventsQueue=p.catch(()=>{});
    return p;
  }
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
    if(kind==='schedulerEvents')return this.schedulerEventsLock(()=>this._compactJsonlArchive(kind,{force}));
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
  // Compact the high-churn outcome ledger once at process startup. The ledger is
  // intentionally smaller than the immutable Scan Journey archive: completed scan
  // evidence remains in Scan Journey, while this working set keeps the most recent
  // outcomes so recurring full-file reads cannot exhaust the bounded Node heap.
  async compactPreExpansionOutcomes({maxRecords=2500,maxStageKeys=6000}={}){
    const recordLimit=Math.max(100,Math.min(5000,Math.trunc(Number(maxRecords)||2500)));
    const stageLimit=Math.max(100,Math.min(10000,Math.trunc(Number(maxStageKeys)||6000)));
    return this.lock(async()=>{
      let raw;
      try{raw=await readFile(this.files.preExpansionOutcomes,'utf8');}
      catch(error){
        if(error?.code==='ENOENT')return {compacted:false,reason:'FILE_NOT_FOUND',retained_records:0,trimmed_records:0};
        throw error;
      }
      let state;
      try{state=JSON.parse(raw);}
      catch{throw new Error('PRE_EXPANSION_OUTCOME_LEDGER_INVALID_JSON');}
      if(!state||typeof state!=='object'||Array.isArray(state))
        throw new Error('PRE_EXPANSION_OUTCOME_LEDGER_INVALID_STATE');
      const priorRecords=Array.isArray(state.records)?state.records:[];
      const priorCount=priorRecords.length;
      const trimmedRecords=Math.max(0,priorCount-recordLimit);
      if(trimmedRecords)state.records=priorRecords.slice(-recordLimit);
      else if(!Array.isArray(state.records))state.records=[];
      const stageMap=state.last_stage_by_key&&typeof state.last_stage_by_key==='object'&&!Array.isArray(state.last_stage_by_key)
        ?state.last_stage_by_key:{};
      let trimmedStageKeys=0;
      const stageEntries=Object.entries(stageMap);
      if(stageEntries.length>stageLimit){
        stageEntries.sort((a,b)=>Number(a[1]?.last_recorded_at||0)-Number(b[1]?.last_recorded_at||0));
        const removeCount=stageEntries.length-stageLimit;
        for(const [key] of stageEntries.slice(0,removeCount))delete stageMap[key];
        state.last_stage_by_key=stageMap;
        trimmedStageKeys=removeCount;
      }else if(state.last_stage_by_key!==stageMap)state.last_stage_by_key=stageMap;
      const beforeBytes=Buffer.byteLength(raw,'utf8');
      if(!trimmedRecords&&!trimmedStageKeys){
        return {compacted:false,reason:'WITHIN_LIMITS',retained_records:priorCount,trimmed_records:0,
          retained_stage_keys:stageEntries.length,trimmed_stage_keys:0,before_bytes:beforeBytes,after_bytes:beforeBytes};
      }
      // Drop the large input string before serializing the smaller, bounded state.
      raw=null;
      await new Promise(resolve=>setImmediate(resolve));
      await this.writeJson(this.files.preExpansionOutcomes,state);
      const afterBytes=Number((await stat(this.files.preExpansionOutcomes)).size)||0;
      return {compacted:true,reason:'WORKING_SET_BOUNDED',retained_records:state.records.length,
        trimmed_records:trimmedRecords,retained_stage_keys:Object.keys(state.last_stage_by_key||{}).length,
        trimmed_stage_keys:trimmedStageKeys,before_bytes:beforeBytes,after_bytes:afterBytes};
    });
  }
  // Internal evaluation state only; no HTTP/API contract is exposed for this file.
  async getPreExpansionOutcomes(){
    return this.readJson(this.files.preExpansionOutcomes);
  }
  async updatePreExpansionOutcomes(updater){
    if(typeof updater!=='function')throw new Error('PRE_EXPANSION_OUTCOME_UPDATER_REQUIRED');
    return this.lock(async()=>{
      let current=await this.readJson(this.files.preExpansionOutcomes);
      const result=await updater(current);
      if(result===false)return current;
      const next=result&&typeof result==='object'&&!Array.isArray(result)?result:current;
      if(next!==current){
        // Drop the original parsed snapshot before serializing the normalized state.
        // Yield once so the completed updater's stack can unwind and become collectible.
        current=null;
        await new Promise(resolve=>setImmediate(resolve));
      }
      await this.writeJson(this.files.preExpansionOutcomes,next);
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
    const rows=(Array.isArray(events)?events:[events]).filter(x=>x&&typeof x==='object'&&!Array.isArray(x));
    if(!rows.length)return {written:0};
    return this.schedulerEventsLock(async()=>{
      await this._compactJsonlArchive('schedulerEvents');
      await appendFile(this.files.schedulerEvents,rows.map(x=>JSON.stringify(x)).join('\n')+'\n');
      this.lastWriteAt=Date.now();
      return {written:rows.length};
    });
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
      await this.schedulerEventsLock(async()=>{
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
  async appendScanJourneyCycle(cycle,{maxBytes=260*1024*1024}={}){
    const validation=validateScanJourneyCycle(cycle);
    if(!validation.valid)throw new Error('SCAN_JOURNEY_INVALID:'+validation.errors.join(','));
    const cycleId=String(cycle.cycle_id);
    const filename=scanJourneyFilename(cycleId);
    const max=Math.max(1024*1024,Number(maxBytes)||260*1024*1024);
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
        const repaired=gzipSync(Buffer.from(JSON.stringify({...cycle,cycle_sequence:prior.cycle_sequence}),'utf8'),{level:6});
        const temp=existingPath+'.repair-'+process.pid+'-'+Date.now();
        try{await writeFile(temp,repaired);await rename(temp,existingPath);}
        catch(error){await unlink(temp).catch(()=>{});throw error;}
        state.compressed_bytes=Math.max(0,state.compressed_bytes-Number(prior.compressed_bytes||0)+repaired.length);
        prior.compressed_bytes=repaired.length;
        prior.sha256=createHash('sha256').update(repaired).digest('hex');
        prior.stored_at=Date.now();
        state.updated_at=Date.now();
        await this.writeJson(this.files.scanJourneyManifest,state);
        return {duplicate:true,repaired:true,cycle_id:cycleId,cycle_sequence:prior.cycle_sequence,retained_cycles:state.cycles.length,retained_coin_rows:state.retained_coin_rows,compressed_bytes:state.compressed_bytes,pruned_cycle_count:state.pruned_cycle_count};
      }
      const sequence=Math.max(state.cycle_sequence+1,Math.trunc(Number(cycle.cycle_number)||0));
      const stored={...cycle,cycle_sequence:sequence};
      const zipped=gzipSync(Buffer.from(JSON.stringify(stored),'utf8'),{level:6});
      const finalPath=join(this.scanJourneyDir,filename);
      const tempPath=finalPath+'.tmp-'+process.pid+'-'+Date.now();
      try{await writeFile(tempPath,zipped);await rename(tempPath,finalPath);}
      catch(error){await unlink(tempPath).catch(()=>{});throw error;}
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
        compressed_bytes:zipped.length,sha256:createHash('sha256').update(zipped).digest('hex'),stored_at:Date.now()
      };
      state.cycles.push(metadata);
      state.cycle_sequence=sequence;
      state.total_recorded_cycles+=1;
      state.retained_coin_rows+=coins.length;
      state.compressed_bytes+=zipped.length;
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
      // The Railway volume is shared with the existing signal archive. Use a rolling
      // compressed journal ceiling so scan history cannot consume the whole 500 MB mount.
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
          const compressed=gzipSync(Buffer.from(JSON.stringify(cycle),'utf8'),{level:6});
          const temp=filePath+'.outcome-'+process.pid+'-'+Date.now();
          try{await writeFile(temp,compressed);await rename(temp,filePath);}
          catch(error){await unlink(temp).catch(()=>{});throw error;}
          state.compressed_bytes=Math.max(0,state.compressed_bytes-Number(metadata.compressed_bytes||0)+compressed.length);
          metadata.compressed_bytes=compressed.length;
          metadata.sha256=createHash('sha256').update(compressed).digest('hex');
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
    let s='';
    try{s=await readFile(file,'utf8');}catch{return[];}
    const rows=[];
    for(const line of s.split('\n').filter(Boolean).slice(-Math.max(1,Number(limit)||100))){
      try{rows.push(JSON.parse(line));}catch{}
    }
    return rows.reverse();
  }
  async health(){try{await mkdir(this.dir,{recursive:true});return{state:this.ready?'LIVE':'INIT',path:this.dir,last_write_at:this.lastWriteAt};}
    catch(e){return{state:'ERROR',path:this.dir,error:String(e?.message??e),last_write_at:this.lastWriteAt};}}
  static publicSubscription(s){return{id:s.id,endpoint:s.endpoint,expirationTime:s.expirationTime,created_at:s.created_at,updated_at:s.updated_at,disabled:Boolean(s.disabled)};}
}
