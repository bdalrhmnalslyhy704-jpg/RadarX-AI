import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {createServer} from 'node:http';
import {mkdtemp,readdir,stat,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DurableStore} from '../core/store.mjs';
import {SCAN_JOURNEY_SCHEMA} from '../core/scan-journey-ledger.mjs';

const MiB=1024*1024;
const CANDLE_MS=5*60*1000;
const CYCLE_COUNT=30;
const SYMBOL_COUNT=280;
const BAR_COUNT=64;
const HISTORICAL_CYCLE_COUNT=686;
const HISTORICAL_SYMBOL_COUNT=496;
const INITIAL_ARCHIVE_COIN_ROWS=HISTORICAL_CYCLE_COUNT*HISTORICAL_SYMBOL_COUNT;
const ALERT_COUNT=623;
const GLOBAL_WORKER_LIMIT=6;
const ARCHIVE_BUDGET=480*MiB;
const TEST_DISK_CAP=500*MiB;
const MEMORY_LIMIT_BYTES=1024*MiB;
const startMemory=process.memoryUsage();
const peak={rss_bytes:startMemory.rss,heap_used_bytes:startMemory.heapUsed};
const measurements=[];
const seedMeasurements=[];
let cyclesCompleted=0,cyclesArchived=0,archiveSkipped=0;
let httpRequests=0,http5xx=0,http502=0;
let activeWorkers=0,peakActiveWorkers=0,workQueue=[];
let samplingDisk=false,peakDiskBytes=0;
const root=await mkdtemp(join(tmpdir(),'radarx-archive-resource-soak-'));
const normalDir=join(root,'normal');
const pressureDir=join(root,'pressure');
let store=null,pressureStore=null,server=null,memorySampler=null,diskSampler=null;
let normalDiskFinal=0,pressureDiskFinal=0,seedDiskBytes=0;
let normalState=null,archiveAudit=null,normalSignals=[],pressureSignals=[],pressureState=null,pressureArchiveAudit=null,pressureFiles=[];
const pressureSeedIds=[];

function memory(){
  const m=process.memoryUsage();
  peak.rss_bytes=Math.max(peak.rss_bytes,m.rss);
  peak.heap_used_bytes=Math.max(peak.heap_used_bytes,m.heapUsed);
  return {rss_bytes:m.rss,heap_used_bytes:m.heapUsed,external_bytes:m.external,array_buffers_bytes:m.arrayBuffers};
}
async function directoryBytes(dir){
  let total=0;
  async function walk(path){
    for(const entry of await readdir(path,{withFileTypes:true})){
      const full=join(path,entry.name);
      if(entry.isDirectory())await walk(full);
      else if(entry.isFile())total+=(await stat(full)).size;
    }
  }
  await walk(dir);
  return total;
}
async function observeDisk(){
  if(samplingDisk)return;
  samplingDisk=true;
  try{peakDiskBytes=Math.max(peakDiskBytes,await directoryBytes(root));}
  catch{}
  finally{samplingDisk=false;}
}
function stablePayload(seed,length=2048){
  let value='';
  for(let n=0;value.length<length;n++)
    value+=createHash('sha256').update(seed+':'+n).digest('hex');
  return value.slice(0,length);
}
function makeCycle(index){
  const completedAt=Date.now();
  const aligned=Math.floor(completedAt/CANDLE_MS)*CANDLE_MS;
  const first=aligned-BAR_COUNT*CANDLE_MS;
  const coins=Array.from({length:SYMBOL_COUNT},(_,symbolIndex)=>{
    const symbol='SOAK'+String(symbolIndex).padStart(4,'0')+'USDT';
    const candles=Array.from({length:BAR_COUNT},(_,i)=>{
      const openTime=first+i*CANDLE_MS;
      const open=1+(symbolIndex%17)/1000+(i%11)/10000;
      const close=open+(i%2?0.0004:-0.0002);
      return {
        open_time:openTime,close_time:openTime+CANDLE_MS-1,
        open,high:Math.max(open,close)+0.001,low:Math.min(open,close)-0.001,close,
        volume:1000+((symbolIndex*13+i*17)%3000),
        quote_volume:10000+((symbolIndex*31+i*19)%90000),
        trade_count:20+((symbolIndex+i)%300),
        taker_buy_base_volume:100+((symbolIndex*7+i*3)%500)
      };
    });
    return {
      symbol,eligible:true,fast_scan_at:completedAt-3000,
      micro_scan_completed_at:completedAt-2000,
      deep_scan_status:symbolIndex<18?'COMPLETED':'NOT_SELECTED',
      deep_scan_completed_at:symbolIndex<18?completedAt-1000:null,
      outcome_signal_id:'RADAR8:'+symbol+':'+completedAt,
      candles_used:{'5m':candles},
      evidence_payload:stablePayload(index+':'+symbol)
    };
  });
  return {
    schema_version:SCAN_JOURNEY_SCHEMA,cycle_id:'RADAR8:USDT:RESOURCE-SOAK:'+index+':'+completedAt,
    cycle_number:index+1,radar:'RADAR_8',quote:'USDT',status:'COMPLETE',
    started_at:completedAt-45_000,completed_at:completedAt,scan_duration_ms:43000,
    data_policy:{closed_candles_only:true,paper_trading:true,real_order_execution:false,confidence_score:'UNKNOWN'},
    counters:{expected_total:SYMBOL_COUNT,received_total:SYMBOL_COUNT,missing_ticker_total:0},
    coins
  };
}
function makeHistoricalCycle(index){
  // Model the deployed archive's 686 x 496 = 340,256 row manifest while keeping
  // fixture creation one cycle at a time. The per-row entropy makes the gzip bytes
  // comparable to a large real JSON archive without loading historical rows globally.
  const completedAt=Date.now()-(HISTORICAL_CYCLE_COUNT-index)*60_000;
  const coins=Array.from({length:HISTORICAL_SYMBOL_COUNT},(_,symbolIndex)=>({
    symbol:'HIST'+String(symbolIndex).padStart(4,'0')+'USDT',
    eligible:true,
    fast_scan_at:completedAt-3000,
    evidence_payload:randomBytes(760).toString('base64url')
  }));
  return {
    schema_version:SCAN_JOURNEY_SCHEMA,
    cycle_id:'RADAR8:USDT:RESOURCE-SEED:'+index,
    cycle_number:index+1,radar:'RADAR_8',quote:'USDT',status:'COMPLETE',
    started_at:completedAt-45_000,completed_at:completedAt,scan_duration_ms:43000,
    data_policy:{closed_candles_only:true,paper_trading:true,real_order_execution:false,confidence_score:'UNKNOWN'},
    counters:{expected_total:HISTORICAL_SYMBOL_COUNT,received_total:HISTORICAL_SYMBOL_COUNT,missing_ticker_total:0},
    coins
  };
}
function signal(index,pressure=false){
  const at=Date.now();
  return {
    id:'FALCON:RESOURCE-SOAK:'+index,radar:'FALCON_EYE_RADAR',symbol:'SOAK0000USDT',
    event:'TEST_RESOURCE_SOAK',detected_at:at,processed_at:at,price:1.2345+index/100000,
    paper_trading:true,real_order_execution:false,confidence_score:'UNKNOWN',
    storage_pressure_fixture:pressure
  };
}
function makeAlertsForCycle(cycleIndex){
  const base=Math.floor(ALERT_COUNT/CYCLE_COUNT),extra=ALERT_COUNT%CYCLE_COUNT;
  const count=base+(cycleIndex<extra?1:0);
  const firstId=cycleIndex*base+Math.min(cycleIndex,extra);
  return Array.from({length:count},(_,offset)=>({
    ...signal(firstId+offset),
    id:'FALCON:RESOURCE-SOAK:ALERT:'+String(firstId+offset).padStart(4,'0'),
    cycle:cycleIndex+1,
    detected_at:Date.now(),
    processed_at:Date.now()
  }));
}
async function acquireWorker(){
  if(activeWorkers<GLOBAL_WORKER_LIMIT){
    activeWorkers++;
    peakActiveWorkers=Math.max(peakActiveWorkers,activeWorkers);
    return;
  }
  await new Promise(resolve=>workQueue.push(resolve));
  // A released slot transfers directly to the waiting worker; activeWorkers is
  // intentionally unchanged while ownership of the slot moves.
}
function releaseWorker(){
  const next=workQueue.shift();
  if(next)next();
  else activeWorkers=Math.max(0,activeWorkers-1);
}
async function mapLimit(items,laneLimit,worker){
  const results=new Array(items.length);
  let cursor=0;
  const count=Math.min(Math.max(1,laneLimit),items.length);
  await Promise.all(Array.from({length:count},async()=>{
    while(true){
      const index=cursor++;
      if(index>=items.length)return;
      await acquireWorker();
      try{results[index]=await worker(items[index],index);}
      finally{releaseWorker();}
    }
  }));
  return results;
}
async function runConcurrentRadarWork(cycle){
  const micro=cycle.coins.slice(0,48);
  const deep=cycle.coins.slice(0,18);
  const analystInputs=deep;
  const scanCandle=async(coin,index)=>{
    let checksum=0;
    for(let i=0;i<coin.candles_used['5m'].length;i++){
      const candle=coin.candles_used['5m'][i];
      checksum+=(candle.high+candle.low+candle.close)*((i%7)+1);
    }
    if((index%4)===0)await new Promise(resolve=>setImmediate(resolve));
    return {symbol:coin.symbol,checksum};
  };
  const [microResults,deepResults,analystResults]=await Promise.all([
    mapLimit(micro,6,scanCandle),
    mapLimit(deep,4,scanCandle),
    mapLimit(analystInputs,4,async(coin,index)=>{
      const scanned=await scanCandle(coin,index);
      let score=0;
      // Workload proxy: all 19 specialists plus a final judge are evaluated;
      // outputs are reduced immediately instead of retaining 20 role objects.
      for(let role=0;role<20;role++){
        const value=(scanned.checksum%(role+17))/(role+17);
        score+=Number.isFinite(value)?value:0;
      }
      return {symbol:coin.symbol,role_count:20,score};
    })
  ]);
  return {
    eligible_symbols:cycle.coins.filter(coin=>coin.eligible===true).length,
    micro_requested:micro.length,micro_completed:microResults.filter(Boolean).length,
    deep_requested:deep.length,deep_completed:deepResults.filter(Boolean).length,
    analyst_symbols_requested:analystInputs.length,analyst_symbols_completed:analystResults.filter(Boolean).length,
    independent_role_evaluations:analystResults.reduce((sum,row)=>sum+(row?.role_count||0),0),
    peak_global_concurrency:peakActiveWorkers,global_concurrency_limit:GLOBAL_WORKER_LIMIT
  };
}
function sendJson(res,status,body){
  res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});
  res.end(JSON.stringify(body));
}
async function handle(req,res){
  try{
    const url=new URL(req.url||'/', 'http://127.0.0.1');
    if(url.pathname==='/health'){sendJson(res,200,{ok:true});return;}
    if(url.pathname==='/cycle'){
      const index=Number(url.searchParams.get('i'));
      const before=memory();
      const diskBefore=await directoryBytes(normalDir);
      const started=Date.now();
      const alertBatch=makeAlertsForCycle(index);
      const cycle=makeCycle(index);
      const [alertResult,archive,work]=await Promise.all([
        store.appendJsonlArchive('falconEyeAlerts',alertBatch),
        store.appendScanJourneyCycle(cycle,{maxBytes:ARCHIVE_BUDGET}),
        runConcurrentRadarWork(cycle)
      ]);
      assert.equal(alertResult.written,alertBatch.length,'every scheduled alert must be persisted');
      assert.equal(work.eligible_symbols,SYMBOL_COUNT,'eligible market coverage shrank');
      assert.equal(work.micro_completed,48,'Micro workload dropped a selected symbol');
      assert.equal(work.deep_completed,18,'Deep workload dropped a selected symbol');
      assert.equal(work.analyst_symbols_completed,18,'analyst workload dropped a selected symbol');
      assert.equal(work.independent_role_evaluations,360,'specialist/final role outputs were dropped');
      cyclesCompleted++;cyclesArchived++;
      const diskAfter=await directoryBytes(normalDir);
      const after=memory();
      measurements.push({
        cycle:index+1,memory_before:before,memory_after:after,
        archive_directory_bytes_before:diskBefore,archive_directory_bytes_after:diskAfter,
        compressed_archive_bytes:archive.compressed_bytes,retained_cycles:archive.retained_cycles,
        retained_coin_rows:archive.retained_coin_rows,pruned_cycles:archive.pruned_cycle_count,
        duration_ms:Date.now()-started,archive_status:'COMMITTED',alerts_written:alertResult.written,
        work
      });
      sendJson(res,200,{ok:true,cycle:index+1,archive_status:'COMMITTED',alerts_written:alertResult.written,work});
      return;
    }
    if(url.pathname==='/pressure'){
      const before=memory();
      const diskBefore=await directoryBytes(pressureDir);
      const started=Date.now();
      await pressureStore.appendFalconEyeAlert(signal('PRESSURE',true));
      let archiveStatus='COMMITTED',pressureCode=null;
      try{
        const cycle=makeCycle(CYCLE_COUNT);
        await pressureStore.appendScanJourneyCycle(cycle,{maxBytes:ARCHIVE_BUDGET});
      }catch(error){
        if(error?.code!=='SCAN_JOURNEY_STORAGE_PRESSURE')throw error;
        archiveStatus='SKIPPED_STORAGE_PRESSURE';
        pressureCode=error.code;
        archiveSkipped++;
      }
      cyclesCompleted++;
      const diskAfter=await directoryBytes(pressureDir);
      const after=memory();
      measurements.push({
        cycle:CYCLE_COUNT+1,memory_before:before,memory_after:after,
        archive_directory_bytes_before:diskBefore,archive_directory_bytes_after:diskAfter,
        duration_ms:Date.now()-started,archive_status:archiveStatus,archive_error_code:pressureCode,
        cycle_completed:true
      });
      sendJson(res,200,{ok:true,cycle:CYCLE_COUNT+1,cycle_completed:true,archive_status:archiveStatus,pressure_code:pressureCode});
      return;
    }
    sendJson(res,404,{error:'NOT_FOUND'});
  }catch(error){
    sendJson(res,500,{error:String(error?.stack||error)});
  }
}

async function checkedFetch(base,path){
  const response=await fetch(base+path);
  httpRequests++;
  if(response.status>=500)http5xx++;
  if(response.status===502)http502++;
  const body=await response.json().catch(async()=>({raw:await response.text().catch(()=> '')}));
  assert.ok(response.status>=200&&response.status<300,
    'test endpoint unexpectedly failed: '+path+' HTTP '+response.status+' body='+JSON.stringify(body));
  return body;
}

try{
  store=await new DurableStore({
    dir:normalDir,freeBytesProvider:async()=>512*MiB,
    maxCycleArchiveBytes:ARCHIVE_BUDGET,storageReserveBytes:16*MiB
  }).init();
  let pressureFreeBytes=512*MiB;
  pressureStore=await new DurableStore({
    dir:pressureDir,freeBytesProvider:async()=>pressureFreeBytes,
    maxCycleArchiveBytes:ARCHIVE_BUDGET,storageReserveBytes:16*MiB
  }).init();

  memorySampler=setInterval(()=>memory(),25);
  diskSampler=setInterval(()=>void observeDisk(),1000);

  const seedStarted=Date.now();
  for(let i=0;i<HISTORICAL_CYCLE_COUNT;i++){
    const before=memory();
    const cycle=makeHistoricalCycle(i);
    const result=await store.appendScanJourneyCycle(cycle,{maxBytes:ARCHIVE_BUDGET});
    assert.equal(result.cycle_coin_rows,HISTORICAL_SYMBOL_COUNT);
    const after=memory();
    if((i+1)%25===0||i===HISTORICAL_CYCLE_COUNT-1){
      seedMeasurements.push({seed_cycle:i+1,memory_before:before,memory_after:after,
        retained_cycles:result.retained_cycles,retained_coin_rows:result.retained_coin_rows,
        compressed_archive_bytes:result.compressed_bytes,elapsed_ms:Date.now()-seedStarted});
      memory();
    }
  }
  const seededState=await store.getScanJourneyState();
  assert.equal(seededState.cycles.length,HISTORICAL_CYCLE_COUNT,'historical cycle count fixture incomplete');
  assert.equal(seededState.retained_coin_rows,INITIAL_ARCHIVE_COIN_ROWS,'historical archive row fixture incomplete');
  seedDiskBytes=await directoryBytes(normalDir);

  const pressureSeedCycles=[100,101].map(index=>makeCycle(index));
  for(const cycle of pressureSeedCycles)
    await pressureStore.appendScanJourneyCycle(cycle,{maxBytes:8*MiB});
  pressureSeedIds.push(...(await pressureStore.getScanJourneyState()).cycles.map(row=>row.cycle_id));
  assert.equal(pressureSeedIds.length,2,'pressure fixture requires two valid pre-existing archived cycles');
  pressureFreeBytes=8*MiB;

  server=createServer((req,res)=>{void handle(req,res);});
  await new Promise((resolve,reject)=>server.listen(0,'127.0.0.1',error=>error?reject(error):resolve()));
  const address=server.address();
  const base='http://127.0.0.1:'+address.port;

  for(let i=0;i<CYCLE_COUNT;i++){
    const [cycleReply]=await Promise.all([
      checkedFetch(base,'/cycle?i='+i),
      checkedFetch(base,'/health'),
      checkedFetch(base,'/health')
    ]);
    assert.equal(cycleReply.archive_status,'COMMITTED');
  }
  const pressureReply=await Promise.all([
    checkedFetch(base,'/pressure'),
    checkedFetch(base,'/health'),
    checkedFetch(base,'/health')
  ]);
  assert.equal(pressureReply[0].archive_status,'SKIPPED_STORAGE_PRESSURE');
  assert.equal(pressureReply[0].cycle_completed,true);
  assert.equal(pressureReply[0].pressure_code,'SCAN_JOURNEY_STORAGE_PRESSURE');

  normalState=await store.getScanJourneyState();
  archiveAudit=await store.verifyScanJourneyArchive();
  normalSignals=await store.readAlertPage('falconEyeAlerts',{sinceMs:0,radar:'FALCON_EYE_RADAR',limit:1000});
  pressureSignals=await pressureStore.readAlertPage('falconEyeAlerts',{sinceMs:0,radar:'FALCON_EYE_RADAR',limit:1000});
  pressureState=await pressureStore.getScanJourneyState();
  pressureArchiveAudit=await pressureStore.verifyScanJourneyArchive();
  pressureFiles=(await readdir(pressureStore.scanJourneyDir)).filter(name=>name.endsWith('.json.gz'));
  const pressureSeedIdsAfter=pressureState.cycles.map(row=>row.cycle_id);
  normalDiskFinal=await directoryBytes(normalDir);
  pressureDiskFinal=await directoryBytes(pressureDir);
  await observeDisk();

  const alertIds=normalSignals.map(row=>row.id);
  const uniqueAlertCount=new Set(alertIds).size;
  const missingAlerts=Math.max(0,ALERT_COUNT-alertIds.length);
  const duplicatedAlerts=Math.max(0,alertIds.length-uniqueAlertCount);
  const allSignalIds=[...alertIds,...pressureSignals.map(row=>row.id)];
  const expectedSignalCount=ALERT_COUNT+1;
  const uniqueSignalCount=new Set(allSignalIds).size;
  const missingSignals=Math.max(0,expectedSignalCount-allSignalIds.length);
  const duplicateSignals=Math.max(0,allSignalIds.length-uniqueSignalCount);
  const totalCoinRowsExpected=INITIAL_ARCHIVE_COIN_ROWS+CYCLE_COUNT*SYMBOL_COUNT;
  const allWorkComplete=measurements.filter(row=>row.cycle<=CYCLE_COUNT).every(row=>
    row.work?.eligible_symbols===SYMBOL_COUNT&&row.work?.micro_completed===48&&
    row.work?.deep_completed===18&&row.work?.analyst_symbols_completed===18&&
    row.work?.independent_role_evaluations===360);

  const cycleMem=measurements.filter(row=>row.cycle<=CYCLE_COUNT);
  const avg=(values)=>values.length?values.reduce((sum,value)=>sum+value,0)/values.length:0;
  const averageRss=avg(cycleMem.map(row=>row.memory_after.rss_bytes));
  const averageHeap=avg(cycleMem.map(row=>row.memory_after.heap_used_bytes));
  const report={
    schema:'RADARX_ARCHIVE_MEMORY_SOAK_V2',
    generated_at:new Date().toISOString(),
    environment:'isolated local HTTP server + temporary filesystem in GitHub Actions; no Railway service contacted or modified',
    workload:{
      cycles_requested:CYCLE_COUNT,cycles_completed:cyclesCompleted,eligible_symbols_per_cycle:SYMBOL_COUNT,
      historical_archive_cycles_seeded:HISTORICAL_CYCLE_COUNT,
      historical_symbols_per_cycle:HISTORICAL_SYMBOL_COUNT,
      historical_coin_rows_seeded:INITIAL_ARCHIVE_COIN_ROWS,
      alerts_requested:ALERT_COUNT,alerts_persisted:alertIds.length,
      closed_5m_bars_per_live_symbol:BAR_COUNT,concurrent_micro_selected_per_cycle:48,
      concurrent_deep_selected_per_cycle:18,analyst_symbols_per_cycle:18,
      analyst_roles_per_symbol:20,global_concurrent_worker_limit:GLOBAL_WORKER_LIMIT,
      synthetic_workload_note:'Micro, Deep and 20-role calculations are bounded workload surrogates, not execution traces from the live radar classes.'
    },
    memory:{
      limit_bytes:MEMORY_LIMIT_BYTES,limit_mib:MEMORY_LIMIT_BYTES/MiB,
      start_rss_bytes:startMemory.rss,start_heap_used_bytes:startMemory.heapUsed,
      average_rss_after_cycle_bytes:Math.round(averageRss),average_heap_after_cycle_bytes:Math.round(averageHeap),
      peak_rss_bytes:peak.rss_bytes,peak_rss_mib:Number((peak.rss_bytes/MiB).toFixed(2)),
      peak_heap_used_bytes:peak.heap_used_bytes,peak_heap_used_mib:Number((peak.heap_used_bytes/MiB).toFixed(2)),
      oom_errors_observed:0,
      below_1gb_limit:peak.rss_bytes<MEMORY_LIMIT_BYTES&&peak.heap_used_bytes<MEMORY_LIMIT_BYTES,
      historical_seed_measurements:seedMeasurements,
      measurements_per_cycle:measurements.map(row=>({
        cycle:row.cycle,rss_before_bytes:row.memory_before.rss_bytes,rss_after_bytes:row.memory_after.rss_bytes,
        heap_before_bytes:row.memory_before.heap_used_bytes,heap_after_bytes:row.memory_after.heap_used_bytes,
        external_before_bytes:row.memory_before.external_bytes,external_after_bytes:row.memory_after.external_bytes,
        duration_ms:row.duration_ms,alerts_written:row.alerts_written??0,
        micro_completed:row.work?.micro_completed??null,deep_completed:row.work?.deep_completed??null,
        analyst_symbols_completed:row.work?.analyst_symbols_completed??null,
        role_evaluations:row.work?.independent_role_evaluations??null,
        global_concurrency_peak:row.work?.peak_global_concurrency??null
      }))
    },
    disk:{
      simulated_volume_cap_bytes:TEST_DISK_CAP,configured_archive_retention_budget_bytes:ARCHIVE_BUDGET,
      initial_archive_directory_bytes:seedDiskBytes,normal_directory_bytes_final:normalDiskFinal,
      low_disk_directory_bytes_final:pressureDiskFinal,peak_observed_test_directory_bytes:peakDiskBytes,
      retained_compressed_archive_bytes:normalState.compressed_bytes,
      retained_cycle_count:normalState.cycles.length,retained_coin_rows:normalState.retained_coin_rows,
      expected_retained_coin_rows:totalCoinRowsExpected,pruned_cycle_count:normalState.pruned_cycle_count,
      within_simulated_500mb_volume:Math.max(normalDiskFinal,pressureDiskFinal)<=TEST_DISK_CAP
    },
    http:{
      requests:httpRequests,successful_2xx:httpRequests-http5xx,'5xx':http5xx,status_502:http502,
      memory_related_502:0,
      scope:'local in-process HTTP health/load endpoints only; not a live Railway error-rate measurement'
    },
    cycles:{
      completed:cyclesCompleted,successfully_archived:cyclesArchived,explicitly_skipped_for_low_disk:archiveSkipped,
      manifest_total_recorded:normalState.total_recorded_cycles,archive_integrity:archiveAudit,
      expected_cycle_count:HISTORICAL_CYCLE_COUNT+CYCLE_COUNT,expected_coin_rows:totalCoinRowsExpected,
      archive_matches_expected_rows:normalState.retained_coin_rows===totalCoinRowsExpected&&normalState.cycles.length===HISTORICAL_CYCLE_COUNT+CYCLE_COUNT,
      duration_ms:cycleMem.map(row=>({cycle:row.cycle,duration_ms:row.duration_ms,scan_duration_simulated_ms:43000}))
    },
    workload_coverage:{
      eligible_symbols_per_cycle:cycleMem.map(row=>({cycle:row.cycle,expected:SYMBOL_COUNT,observed:row.work?.eligible_symbols??0})),
      micro_completed_total:cycleMem.reduce((sum,row)=>sum+(row.work?.micro_completed||0),0),
      micro_expected_total:CYCLE_COUNT*48,
      deep_completed_total:cycleMem.reduce((sum,row)=>sum+(row.work?.deep_completed||0),0),
      deep_expected_total:CYCLE_COUNT*18,
      analyst_symbols_completed_total:cycleMem.reduce((sum,row)=>sum+(row.work?.analyst_symbols_completed||0),0),
      analyst_symbols_expected_total:CYCLE_COUNT*18,
      independent_role_evaluations_total:cycleMem.reduce((sum,row)=>sum+(row.work?.independent_role_evaluations||0),0),
      independent_role_evaluations_expected_total:CYCLE_COUNT*18*20,
      peak_global_worker_count:peakActiveWorkers,global_worker_limit:GLOBAL_WORKER_LIMIT,
      all_requested_work_completed:allWorkComplete
    },
    signals:{
      alerts_expected:ALERT_COUNT,alerts_observed:alertIds.length,unique_alerts:uniqueAlertCount,
      missing_alerts:missingAlerts,duplicate_alerts:duplicatedAlerts,
      total_signals_expected_including_low_disk_case:expectedSignalCount,
      total_signals_observed_including_low_disk_case:allSignalIds.length,
      unique_signals:uniqueSignalCount,missing_signals:missingSignals,duplicate_signals:duplicateSignals,
      low_disk_alert_rows:pressureSignals.length
    },
    low_disk_scenario:{
      simulated_free_bytes:8*MiB,protected_reserve_bytes:16*MiB,
      archive_status:measurements.at(-1)?.archive_status,cycle_completed:measurements.at(-1)?.cycle_completed,
      prior_retained_cycle_ids:pressureSeedIds,retained_cycle_ids_after_pressure:pressureSeedIdsAfter,
      committed_cycle_count_after_pressure:pressureState.cycles.length,
      compressed_archive_bytes_after_pressure:pressureState.compressed_bytes,
      archive_integrity:pressureArchiveAudit,
      prior_archive_preserved:JSON.stringify(pressureSeedIdsAfter)===JSON.stringify(pressureSeedIds),
      rejected_cycle_not_published:!pressureState.cycles.some(row=>row.cycle_id.includes('RESOURCE-SOAK:'+CYCLE_COUNT+':')),
      archive_file_count:pressureFiles.length,archive_file_count_matches_manifest:pressureFiles.length===pressureState.cycles.length
    },
    verdict:'PASS'
  };

  assert.equal(cyclesCompleted,CYCLE_COUNT+1);
  assert.equal(cyclesArchived,CYCLE_COUNT);
  assert.equal(archiveSkipped,1);
  assert.equal(seededState.retained_coin_rows,INITIAL_ARCHIVE_COIN_ROWS);
  assert.equal(normalState.retained_coin_rows,totalCoinRowsExpected,'retained archive rows changed unexpectedly');
  assert.equal(normalState.cycles.length,HISTORICAL_CYCLE_COUNT+CYCLE_COUNT,'historical and new cycles must remain retained');
  assert.ok(normalState.compressed_bytes<=ARCHIVE_BUDGET,'compressed archive retention budget exceeded');
  assert.equal(archiveAudit.complete,true,'retained archive integrity failed');
  assert.equal(archiveAudit.readable_cycles,normalState.cycles.length);
  assert.equal(archiveAudit.readable_coin_rows,totalCoinRowsExpected,'streaming verifier reported missing archive rows');
  assert.deepEqual(pressureSeedIdsAfter,pressureSeedIds,'low-disk rejection must preserve the exact prior archive manifest');
  assert.equal(pressureState.cycles.length,2,'prior archived cycles must remain available under disk pressure');
  assert.equal(pressureArchiveAudit.complete,true,'prior archive records must remain readable and pass hash verification');
  assert.equal(pressureFiles.length,pressureState.cycles.length,'no partial gzip cycle files may be left behind');
  assert.equal(pressureState.cycles.some(row=>row.cycle_id.includes('RESOURCE-SOAK:'+CYCLE_COUNT+':')),false,
    'a snapshot rejected for low disk must never be published in the manifest');
  assert.equal(Math.max(normalDiskFinal,pressureDiskFinal)<=TEST_DISK_CAP,true,'temporary filesystem exceeded the 500 MiB volume simulation');
  assert.equal(alertIds.length,ALERT_COUNT,'not all 623 generated alert events survived durable replay');
  assert.equal(uniqueAlertCount,ALERT_COUNT,'duplicate alert IDs were found');
  assert.equal(missingAlerts,0,'alert records were lost in durable replay');
  assert.equal(duplicatedAlerts,0,'duplicate alert records were present in durable replay');
  assert.equal(allSignalIds.length,expectedSignalCount,'signal records were lost in the fixture');
  assert.equal(uniqueSignalCount,expectedSignalCount,'signal IDs were duplicated in the fixture');
  assert.equal(missingSignals,0,'signal records were missing');
  assert.equal(duplicateSignals,0,'signal IDs were duplicated');
  assert.equal(http5xx,0,'HTTP 5xx occurred while the archive was under load');
  assert.equal(http502,0,'HTTP 502 occurred while the archive was under load');
  assert.ok(peak.rss_bytes<MEMORY_LIMIT_BYTES,'peak RSS exceeded the 1 GB memory gate');
  assert.ok(peak.heap_used_bytes<MEMORY_LIMIT_BYTES,'peak Node heap exceeded the 1 GB memory gate');
  assert.equal(allWorkComplete,true,'Micro/Deep/analyst work was silently skipped');
  assert.ok(peakActiveWorkers<=GLOBAL_WORKER_LIMIT,'global worker limit was exceeded');
  assert.ok(peakDiskBytes<=TEST_DISK_CAP,'observed temporary filesystem peak exceeded 500 MiB');

  console.log('ARCHIVE_RESOURCE_SOAK_REPORT='+JSON.stringify(report));
}finally{
  if(memorySampler)clearInterval(memorySampler);
  if(diskSampler)clearInterval(diskSampler);
  if(server)await new Promise(resolve=>server.close(resolve));
  await rm(root,{recursive:true,force:true});
}
