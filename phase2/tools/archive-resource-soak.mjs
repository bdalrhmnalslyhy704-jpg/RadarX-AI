import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {mkdtemp,readdir,stat,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DurableStore} from '../core/store.mjs';
import {SCAN_JOURNEY_SCHEMA} from '../core/scan-journey-ledger.mjs';

const MiB=1024*1024;
const CANDLE_MS=5*60*1000;
const CYCLE_COUNT=12;
const SYMBOL_COUNT=496;
const BAR_COUNT=64;
const ARCHIVE_BUDGET=3*MiB;
const TEST_DISK_CAP=16*MiB;
const startRss=process.memoryUsage().rss;
const peak={rss_bytes:startRss,heap_used_bytes:process.memoryUsage().heapUsed};
const measurements=[];
let cyclesCompleted=0,cyclesArchived=0,archiveSkipped=0;
let httpRequests=0,http5xx=0,http502=0;
let samplingDisk=false,peakDiskBytes=0;
const root=await mkdtemp(join(tmpdir(),'radarx-archive-resource-soak-'));
const normalDir=join(root,'normal');
const pressureDir=join(root,'pressure');
const store=await new DurableStore({
  dir:normalDir,
  freeBytesProvider:async()=>512*MiB,
  storageReserveBytes:16*MiB
}).init();
const pressureStore=await new DurableStore({
  dir:pressureDir,
  freeBytesProvider:async()=>8*MiB,
  storageReserveBytes:16*MiB
}).init();

function memory(){
  const m=process.memoryUsage();
  peak.rss_bytes=Math.max(peak.rss_bytes,m.rss);
  peak.heap_used_bytes=Math.max(peak.heap_used_bytes,m.heapUsed);
  return {rss_bytes:m.rss,heap_used_bytes:m.heapUsed,external_bytes:m.external};
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
      symbol,eligible:symbolIndex%2===0,fast_scan_at:completedAt-3000,
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
function signal(index,pressure=false){
  const at=Date.now();
  return {
    id:'FALCON:RESOURCE-SOAK:'+index,radar:'FALCON_EYE_RADAR',symbol:'SOAK0000USDT',
    event:'TEST_RESOURCE_SOAK',detected_at:at,processed_at:at,price:1.2345+index/100000,
    paper_trading:true,real_order_execution:false,confidence_score:'UNKNOWN',
    storage_pressure_fixture:pressure
  };
}
function sendJson(res,status,body){
  res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});
  res.end(JSON.stringify(body));
}
async function handle(req,res){
  const url=new URL(req.url||'/', 'http://127.0.0.1');
  if(url.pathname==='/health'){sendJson(res,200,{ok:true});return;}
  if(url.pathname==='/cycle'){
    const index=Number(url.searchParams.get('i'));
    const before=memory();
    const diskBefore=await directoryBytes(normalDir);
    const started=Date.now();
    const alert=signal(index);
    await store.appendFalconEyeAlert(alert);
    const cycle=makeCycle(index);
    const archive=await store.appendScanJourneyCycle(cycle,{maxBytes:ARCHIVE_BUDGET});
    cyclesCompleted++;cyclesArchived++;
    const diskAfter=await directoryBytes(normalDir);
    const after=memory();
    measurements.push({
      cycle:index+1,memory_before:before,memory_after:after,
      archive_directory_bytes_before:diskBefore,archive_directory_bytes_after:diskAfter,
      compressed_archive_bytes:archive.compressed_bytes,retained_cycles:archive.retained_cycles,
      pruned_cycles:archive.pruned_cycle_count,duration_ms:Date.now()-started,
      archive_status:'COMMITTED'
    });
    sendJson(res,200,{ok:true,cycle:index+1,archive_status:'COMMITTED'});
    return;
  }
  if(url.pathname==='/pressure'){
    const before=memory();
    const diskBefore=await directoryBytes(pressureDir);
    const started=Date.now();
    const alert=signal(CYCLE_COUNT,true);
    await pressureStore.appendFalconEyeAlert(alert);
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
    // The scan/cycle is complete even if the bulky snapshot is deliberately withheld.
    cyclesCompleted++;
    const diskAfter=await directoryBytes(pressureDir);
    const after=memory();
    measurements.push({
      cycle:CYCLE_COUNT+1,memory_before:before,memory_after:after,
      archive_directory_bytes_before:diskBefore,archive_directory_bytes_after:diskAfter,
      duration_ms:Date.now()-started,archive_status:archiveStatus,archive_error_code:pressureCode,
      cycle_completed:true
    });
    sendJson(res,200,{ok:true,cycle:CYCLE_COUNT+1,cycle_completed:true,archive_status,pressure_code:pressureCode});
    return;
  }
  sendJson(res,404,{error:'NOT_FOUND'});
}
const server=createServer((req,res)=>{void handle(req,res).catch(error=>sendJson(res,500,{error:String(error?.stack||error)}));});
await new Promise((resolve,reject)=>server.listen(0,'127.0.0.1',error=>error?reject(error):resolve()));
const address=server.address();
const base='http://127.0.0.1:'+address.port;
const sampler=setInterval(()=>{
  memory();
  void observeDisk();
},10);

async function checkedFetch(path){
  const response=await fetch(base+path);
  httpRequests++;
  if(response.status>=500)http5xx++;
  if(response.status===502)http502++;
  const body=await response.json();
  assert.ok(response.status>=200&&response.status<300,'test endpoint unexpectedly failed: '+path+' HTTP '+response.status);
  return body;
}

let normalState,archiveAudit,normalSignals,pressureSignals,pressureState,normalDiskFinal,pressureDiskFinal;
try{
  for(let i=0;i<CYCLE_COUNT;i++){
    // Run health requests alongside compression and disk writes to expose HTTP failures
    // while the archive workload is active, rather than testing the store in isolation.
    const [cycleReply]=await Promise.all([
      checkedFetch('/cycle?i='+i),
      checkedFetch('/health'),
      checkedFetch('/health')
    ]);
    assert.equal(cycleReply.archive_status,'COMMITTED');
  }
  const pressureReply=await Promise.all([
    checkedFetch('/pressure'),
    checkedFetch('/health'),
    checkedFetch('/health')
  ]);
  assert.equal(pressureReply[0].archive_status,'SKIPPED_STORAGE_PRESSURE');
  assert.equal(pressureReply[0].cycle_completed,true);
  assert.equal(pressureReply[0].pressure_code,'SCAN_JOURNEY_STORAGE_PRESSURE');

  normalState=await store.getScanJourneyState();
  archiveAudit=await store.verifyScanJourneyArchive();
  normalSignals=await store.readAlertPage('falconEyeAlerts',{sinceMs:0,radar:'FALCON_EYE_RADAR',limit:1000});
  pressureSignals=await pressureStore.readAlertPage('falconEyeAlerts',{sinceMs:0,radar:'FALCON_EYE_RADAR',limit:1000});
  pressureState=await pressureStore.getScanJourneyState();
  normalDiskFinal=await directoryBytes(normalDir);
  pressureDiskFinal=await directoryBytes(pressureDir);
  await observeDisk();

  const allSignalIds=[...normalSignals,...pressureSignals].map(row=>row.id);
  const expectedSignalCount=CYCLE_COUNT+1;
  const uniqueSignalCount=new Set(allSignalIds).size;
  const missingSignals=Math.max(0,expectedSignalCount-allSignalIds.length);
  const duplicateSignals=Math.max(0,allSignalIds.length-uniqueSignalCount);
  const report={
    schema:'RADARX_ARCHIVE_RESOURCE_SOAK_V1',
    environment:'isolated GitHub Actions/temporary filesystem; no Railway service contacted or modified',
    workload:{normal_cycles_requested:CYCLE_COUNT,synthetic_symbols_per_cycle:SYMBOL_COUNT,closed_5m_bars_per_symbol:BAR_COUNT,pressure_scenario_cycles:1},
    memory:{
      start_rss_bytes:startRss,peak_rss_bytes:peak.rss_bytes,peak_heap_used_bytes:peak.heap_used_bytes,
      measurements_per_cycle:measurements.map(row=>({
        cycle:row.cycle,rss_before_bytes:row.memory_before.rss_bytes,rss_after_bytes:row.memory_after.rss_bytes,
        heap_before_bytes:row.memory_before.heap_used_bytes,heap_after_bytes:row.memory_after.heap_used_bytes,
        duration_ms:row.duration_ms
      }))
    },
    disk:{
      configured_test_archive_budget_bytes:ARCHIVE_BUDGET,
      configured_test_directory_cap_bytes:TEST_DISK_CAP,
      normal_archive_directory_bytes_after_each_cycle:measurements.filter(x=>x.cycle<=CYCLE_COUNT).map(x=>({cycle:x.cycle,before:x.archive_directory_bytes_before,after:x.archive_directory_bytes_after})),
      normal_directory_bytes_final:normalDiskFinal,pressure_directory_bytes_final:pressureDiskFinal,
      peak_observed_test_directory_bytes:peakDiskBytes,
      retained_compressed_archive_bytes:normalState.compressed_bytes,
      retained_cycle_count:normalState.cycles.length,retained_coin_rows:normalState.retained_coin_rows,
      pruned_cycle_count:normalState.pruned_cycle_count
    },
    http:{requests:httpRequests,5xx:http5xx,status_502:http502,expected_failures:0},
    cycles:{completed:cyclesCompleted,successfully_archived:cyclesArchived,explicitly_skipped_for_low_disk:archiveSkipped,manifest_total_recorded:normalState.total_recorded_cycles,archive_integrity:archiveAudit},
    signals:{expected:expectedSignalCount,observed:allSignalIds.length,unique:uniqueSignalCount,missing:missingSignals,duplicates:duplicateSignals,normal_log_rows:normalSignals.length,low_disk_log_rows:pressureSignals.length},
    low_disk_scenario:{
      simulated_free_bytes:8*MiB,protected_reserve_bytes:16*MiB,
      archive_status:measurements.at(-1).archive_status,cycle_completed:measurements.at(-1).cycle_completed,
      committed_cycle_count:pressureState.cycles.length,partial_archive_files:(await readdir(pressureStore.scanJourneyDir)).filter(name=>name.endsWith('.json.gz')).length
    },
    verdict:'PASS'
  };

  assert.equal(cyclesCompleted,CYCLE_COUNT+1);
  assert.equal(cyclesArchived,CYCLE_COUNT);
  assert.equal(archiveSkipped,1);
  assert.ok(normalState.compressed_bytes<=ARCHIVE_BUDGET,'compressed archive budget exceeded');
  assert.equal(archiveAudit.complete,true,'retained archive integrity failed');
  assert.equal(archiveAudit.readable_cycles,normalState.cycles.length);
  assert.equal(normalState.pruned_cycle_count>0,true,'stress test must exercise repeated retention');
  assert.equal(pressureState.cycles.length,0,'low-disk gate must not publish a partial manifest');
  assert.equal((await readdir(pressureStore.scanJourneyDir)).filter(name=>name.endsWith('.json.gz')).length,0);
  assert.equal(allSignalIds.length,expectedSignalCount,'signal records were lost in the fixture');
  assert.equal(uniqueSignalCount,expectedSignalCount,'signal IDs were duplicated in the fixture');
  assert.equal(http5xx,0,'HTTP 5xx occurred while the archive was under load');
  assert.equal(http502,0,'HTTP 502 occurred while the archive was under load');
  assert.ok(peakDiskBytes<TEST_DISK_CAP,'test archive directory exceeded its explicit disk cap');

  console.log('ARCHIVE_RESOURCE_SOAK_REPORT='+JSON.stringify(report));
} finally {
  clearInterval(sampler);
  await new Promise(resolve=>server.close(resolve));
  await rm(root,{recursive:true,force:true});
}
