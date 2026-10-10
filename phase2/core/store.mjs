import {mkdir,readFile,writeFile,rename,appendFile} from 'node:fs/promises';
import {basename,join,resolve} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {gzipSync,gunzipSync} from 'node:zlib';
import {SCAN_JOURNEY_SCHEMA,scanJourneyFilename,validateScanJourneyCycle,scanJourneyOutcomesFromRecord,summarizeScanJourneyOutcomes,SCAN_JOURNEY_HORIZONS} from './scan-journey-ledger.mjs';

export class DurableStore {
  constructor({dir='./.radarx-data'}={}){this.dir=dir;this.queue=Promise.resolve();this.ready=false;this.lastWriteAt=null;this.migratedFiles=[];
    this.scanJourneyDir=join(dir,'scan-journeys');
    this.files={scanJourneyManifest:join(dir,'scan-journey-manifest.json'),subscriptions:join(dir,'subscriptions.json'),settings:join(dir,'settings.json'),dedup:join(dir,'dedup.json'),signalSnapshots:join(dir,'signal-snapshots.json'),
      signals:join(dir,'signals.jsonl'),notifications:join(dir,'notifications.jsonl'),moveAlerts:join(dir,'move-alerts.jsonl'),earlyExpansionAlerts:join(dir,'early-expansion-alerts.jsonl'),preExpansionOutcomes:join(dir,'pre-expansion-outcomes.json'),
      intelligenceMemory:join(dir,'intelligence-memory.json'),strongMoveAlerts:join(dir,'strong-move-alerts.jsonl'),predictionCalibration:join(dir,'prediction-calibration.json'),rotationAlerts:join(dir,'rotation-alerts.jsonl'),liquidityAbsorptionAlerts:join(dir,'liquidity-absorption-alerts.jsonl'),kahirAlerts:join(dir,'kahir-alerts.jsonl'),doomsdayAlerts:join(dir,'doomsday-alerts.jsonl'),professorAlerts:join(dir,'professor-alerts.jsonl'),alMuqawimAlerts:join(dir,'al-muqawim-alerts.jsonl'),falconEyeAlerts:join(dir,'falcon-eye-alerts.jsonl')};}
  async init({legacyDir=null}={}){
    await mkdir(this.dir,{recursive:true});
    await mkdir(this.scanJourneyDir,{recursive:true});
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
  async getPredictionCalibration(symbol){
    const key=String(symbol||'').trim().toUpperCase();if(!key)return null;const a=await this.readJson(this.files.predictionCalibration);return a[key]||null;
  }
  async putPredictionCalibration(symbol,value){
    const key=String(symbol||'').trim().toUpperCase();if(!key)throw new Error('INVALID_PREDICTION_CALIBRATION_SYMBOL');
    return this.lock(async()=>{const a=await this.readJson(this.files.predictionCalibration);a[key]={...value,symbol:key,updated_at:Date.now()};await this.writeJson(this.files.predictionCalibration,a);return a[key];});
  }
  // Internal evaluation state only; no HTTP/API contract is exposed for this file.
  async getPreExpansionOutcomes(){
    return this.readJson(this.files.preExpansionOutcomes);
  }
  async updatePreExpansionOutcomes(updater){
    if(typeof updater!=='function')throw new Error('PRE_EXPANSION_OUTCOME_UPDATER_REQUIRED');
    return this.lock(async()=>{
      const current=await this.readJson(this.files.preExpansionOutcomes);
      const result=await updater(current);
      if(result===false)return current;
      const next=result&&typeof result==='object'&&!Array.isArray(result)?result:current;
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
  async appendKahirAlert(v){return this.lock(async()=>{await appendFile(this.files.kahirAlerts,JSON.stringify(v)+'\\n');this.lastWriteAt=Date.now();});}
  async readKahirAlerts({sinceMs=0,limit=100}={}){const rows=await this.readRecent('kahirAlerts',Math.min(500,Math.max(1,Number(limit)||100)));return rows.filter(x=>Number(x?.processed_at)>Number(sinceMs||0)).slice(0,Math.min(100,Math.max(1,Number(limit)||100)));}
  async appendDoomsdayAlert(v){return this.lock(async()=>{await appendFile(this.files.doomsdayAlerts,JSON.stringify(v)+'\n');this.lastWriteAt=Date.now();});}
  async readDoomsdayAlerts({sinceMs=0,limit=100}={}){const rows=await this.readRecent('doomsdayAlerts',Math.min(500,Math.max(1,Number(limit)||100)));return rows.filter(x=>Number(x?.processed_at)>Number(sinceMs||0)).slice(0,Math.min(100,Math.max(1,Number(limit)||100)));}
  async appendProfessorAlert(v){return this.lock(async()=>{await appendFile(this.files.professorAlerts,JSON.stringify(v)+'\n');this.lastWriteAt=Date.now();});}
  async appendAlMuqawimAlert(v){return this.lock(async()=>{await appendFile(this.files.alMuqawimAlerts,JSON.stringify(v)+'\n');this.lastWriteAt=Date.now();});}
  async readAlMuqawimAlerts({sinceMs=0,limit=100}={}){const rows=await this.readRecent('alMuqawimAlerts',Math.min(500,Math.max(1,Number(limit)||100)));return rows.filter(x=>Number(x?.processed_at)>Number(sinceMs||0)).slice(0,Math.min(100,Math.max(1,Number(limit)||100)));}
  async appendEarlyExpansionAlert(v){return this.lock(async()=>{await appendFile(this.files.earlyExpansionAlerts,JSON.stringify(v)+'\n');this.lastWriteAt=Date.now();});}
  async readEarlyExpansionAlerts({sinceMs=0,limit=100}={}){const safeLimit=Math.min(500,Math.max(1,Number(limit)||100));const rows=await this.readRecent('earlyExpansionAlerts',500);return rows.filter(x=>Number(x?.processed_at??x?.detected_at??0)>Number(sinceMs||0)).sort((a,b)=>Number(a?.processed_at??a?.detected_at??0)-Number(b?.processed_at??b?.detected_at??0)).slice(0,safeLimit);}
  async appendFalconEyeAlert(v){return this.lock(async()=>{await appendFile(this.files.falconEyeAlerts,JSON.stringify(v)+'\n');this.lastWriteAt=Date.now();});}
  async readFalconEyeAlerts({sinceMs=0,limit=100}={}){const safeLimit=Math.min(100,Math.max(1,Number(limit)||100));const rows=await this.readRecent('falconEyeAlerts',500);return rows.filter(x=>Number(x?.processed_at)>Number(sinceMs||0)).sort((a,b)=>Number(a?.processed_at||0)-Number(b?.processed_at||0)).slice(0,safeLimit);}
  async readProfessorAlerts({sinceMs=0,limit=100}={}){const rows=await this.readRecent('professorAlerts',Math.min(500,Math.max(1,Number(limit)||100)));return rows.filter(x=>Number(x?.processed_at)>Number(sinceMs||0)).slice(0,Math.min(100,Math.max(1,Number(limit)||100)));}
  async appendKahirAlert(v){return this.lock(async()=>{await appendFile(this.files.kahirAlerts,JSON.stringify(v)+'\\n');this.lastWriteAt=Date.now();});}
  async readKahirAlerts({sinceMs=0,limit=100}={}){const rows=await this.readRecent('kahirAlerts',Math.min(500,Math.max(1,Number(limit)||100)));return rows.filter(x=>Number(x?.processed_at)>Number(sinceMs||0)).slice(0,Math.min(100,Math.max(1,Number(limit)||100)));}

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
        await writeFile(temp,repaired);await rename(temp,existingPath);
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
      await writeFile(tempPath,zipped);
      await rename(tempPath,finalPath);
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
          await writeFile(temp,compressed);await rename(temp,filePath);
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
