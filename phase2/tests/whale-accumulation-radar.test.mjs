import test from 'node:test';
import assert from 'node:assert/strict';
import {WhaleAccumulationRadar} from '../core/whale-accumulation-radar.mjs';

test('Whale radar fills unique rotation slots when patrol overlaps quiet high-volume anchors',()=>{
  const radar=new WhaleAccumulationRadar({
    rest:{},store:{},clock:()=>Date.now(),
    config:{topAnchors:3,rotationBatchSize:4}
  });
  radar.universe=Array.from({length:16},(_,i)=>`W${String(i).padStart(2,'0')}USDT`);
  const rows=radar.universe.map((symbol,i)=>({
    symbol,lastPrice:1+i,priceChange24h:0.1,
    quoteVolume24h:20_000_000-i*100_000
  }));
  const selected=radar.selectBatch(rows);
  assert.equal(selected.length,7);
  assert.equal(new Set(selected.map(x=>x.symbol)).size,7);
});
test('Whale scan falls back to the shared REST request for aggTrades when no wrapper exists',async()=>{
  const calls=[];
  const now=Date.now();
  const radar=new WhaleAccumulationRadar({
    rest:{
      klines:async(symbol,interval)=>({candles:[],source:'fixture'}),
      request:async(path,query)=>{calls.push({path,query});return {data:[],source:'fixture'};},
      depth:async()=>({data:{bids:[['1','100']],asks:[['1.01','100']]},source:'fixture'})
    },
    store:{},clock:()=>now,logger:{info(){},warn(){},error(){}}
  });
  const result=await radar.scanRow({symbol:'TESTUSDT',lastPrice:1,priceChange24h:0,quoteVolume24h:2_000_000});
  assert.equal(result.symbol,'TESTUSDT');
  assert.deepEqual(calls,[{path:'/api/v3/aggTrades',query:{symbol:'TESTUSDT',limit:1000}}]);
});

test('Radar 9 bounds deep concurrency, preserves all selected coins, and coalesces overdue timer ticks without overlapping cycles',async()=>{
  const archive=[],logs=[];
  const store={
    async readScanSchedulerEvents({radar=null}={}){return archive.filter(x=>!radar||x.radar===radar);},
    async appendScanSchedulerEvents(events){archive.push(...events);return{written:events.length};}
  };
  const radar=new WhaleAccumulationRadar({
    rest:{},store,clock:()=>Date.now(),logger:{
      info(message){logs.push(String(message));},warn(message){logs.push(String(message));}
    },
    config:{topAnchors:2,rotationBatchSize:2,deepConcurrency:2,pollMs:60000,universeRefreshMs:3600000}
  });
  const rows=['AUSDT','BUSDT','CUSDT','DUSDT'].map((symbol,i)=>({
    symbol,lastPrice:1+i,priceChange24h:.2+i*.1,quoteVolume24h:5_000_000-i*100_000,tradeCount24h:20_000
  }));
  radar.universe=rows.map(x=>x.symbol);radar.universeAt=Date.now();
  radar.refreshUniverse=async()=>{};
  radar.tickerRows=async()=>rows;
  radar.updateFastSnapshot=row=>({volume_accel_ratio:1.01,trade_accel_ratio:1.01,price_acceleration_pct:.01});
  let active=0,maxActive=0,completedRows=0;
  radar.scanRow=async row=>{
    active++;maxActive=Math.max(maxActive,active);
    await new Promise(resolve=>setTimeout(resolve,8));
    active--;completedRows++;
    radar.lastRowTimings.set(row.symbol,{symbol:row.symbol,data_fetch_ms:2,signal_analysis_ms:1,signal_archive_write_ms:0,result_send_ms:0,row_total_ms:3});
    return{eligible:false,potential_label:'WATCH',data_status:'LIVE_DATA',whale_accumulation:{stage:'WATCH'}};
  };
  radar.running=true;
  const first=radar.tick();
  await new Promise(resolve=>setTimeout(resolve,1));
  await radar.tick(); // Must request a follow-up cycle rather than overlap the active one.
  await first;
  for(let n=0;n<200&&logs.filter(x=>x.startsWith('[RADARX_SCHEDULER_REPORT]')).length<2;n++)
    await new Promise(resolve=>setTimeout(resolve,2));
  await radar.stop();
  assert.equal(maxActive,2,'deep worker count must stay at the configured bound');
  assert.equal(completedRows,8,'all four selected symbols must complete in each of two cycles');
  assert.equal(radar.lastCoverage.cycle,2,'the pending cycle must run after the active cycle completes');
  assert.equal(radar.lastCoverage.deep_attempted,4);
  assert.equal(radar.lastCoverage.unattempted,0);
  const reports=logs.filter(x=>x.startsWith('[RADARX_SCHEDULER_REPORT]')).map(x=>JSON.parse(x.slice(x.indexOf('{'))));
  assert.equal(reports.length,2);
  for(const report of reports){
    assert.equal(report.deep_selected,4);
    assert.equal(report.deep_attempted,4);
    assert.equal(report.duplicate_selected_count,0);
    assert.equal(report.deep_concurrency,2);
    assert.equal(report.micro_scan_status,'NOT_APPLICABLE_RADAR_9_HAS_NO_MICRO_STAGE');
    assert.ok(report.deep_scan_wall_ms>0);
    assert.ok(Number.isFinite(report.scheduler_archive_write_ms));
    assert.equal(report.paper_trading,true);
    assert.equal(report.real_order_execution,false);
  }
  assert.ok(archive.some(x=>x.stage==='CYCLE'&&x.reason_code==='RADAR9_CYCLE_TIMINGS'));
});

test('Radar 9 records separate deep fetch, signal analysis, signal archive and result-send timings',async()=>{
  const now=Date.now(),calls=[];
  const radar=new WhaleAccumulationRadar({
    rest:{
      klines:async(symbol,interval)=>{calls.push('kline:'+interval);return{candles:[],source:'fixture'};},
      request:async(path)=>{calls.push(path);return{data:[],source:'fixture'};},
      depth:async()=>{calls.push('depth');return{data:{bids:[['1','100']],asks:[['1.01','100']]},source:'fixture'};}
    },
    store:{},clock:()=>now,logger:{info(){},warn(){}}
  });
  await radar.scanRow({symbol:'TIMINGUSDT',lastPrice:1,priceChange24h:.2,quoteVolume24h:2_000_000});
  const timing=radar.lastRowTimings.get('TIMINGUSDT');
  assert.ok(timing);
  assert.ok(Number.isFinite(timing.data_fetch_ms)&&timing.data_fetch_ms>=0);
  assert.ok(Number.isFinite(timing.signal_analysis_ms)&&timing.signal_analysis_ms>=0);
  assert.equal(timing.signal_archive_write_ms,0);
  assert.equal(timing.result_send_ms,0);
  assert.ok(Number.isFinite(timing.row_total_ms)&&timing.row_total_ms>=timing.data_fetch_ms);
  assert.equal(calls.filter(x=>x==='kline:1m').length,1);
  assert.equal(calls.filter(x=>x==='kline:5m').length,1);
});


test('Radar 9 uses a bounded five-worker Deep batch to meet its 60-second cadence without dropping selected symbols',async()=>{
  const archive=[],logs=[];
  const store={
    async readScanSchedulerEvents({radar=null}={}){return archive.filter(x=>!radar||x.radar===radar);},
    async appendScanSchedulerEvents(events){archive.push(...events);return{written:events.length};}
  };
  const radar=new WhaleAccumulationRadar({
    rest:{},store,clock:()=>Date.now(),logger:{
      info(message){logs.push(String(message));},warn(message){logs.push(String(message));}
    },
    config:{topAnchors:3,rotationBatchSize:3,deepConcurrency:5,pollMs:60000,universeRefreshMs:3600000,
      schedulerFastPathSlots:0,schedulerQuietAnchorSlots:0}
  });
  const rows=Array.from({length:8},(_,i)=>({
    symbol:`FAST${i}USDT`,lastPrice:1+i,priceChange24h:.2+i*.1,
    quoteVolume24h:5_000_000-i*100_000,tradeCount24h:20_000
  }));
  radar.universe=rows.map(x=>x.symbol);radar.universeAt=Date.now();
  radar.refreshUniverse=async()=>{};
  radar.tickerRows=async()=>rows;
  radar.updateFastSnapshot=row=>({volume_accel_ratio:1.01,trade_accel_ratio:1.01,price_acceleration_pct:.01});
  let active=0,maxActive=0,completedRows=0;
  radar.scanRow=async row=>{
    active++;maxActive=Math.max(maxActive,active);
    await new Promise(resolve=>setTimeout(resolve,10));
    active--;completedRows++;
    radar.lastRowTimings.set(row.symbol,{symbol:row.symbol,data_fetch_ms:2,signal_analysis_ms:1,signal_archive_write_ms:0,result_send_ms:0,row_total_ms:3});
    return{eligible:false,potential_label:'WATCH',data_status:'LIVE_DATA',whale_accumulation:{stage:'WATCH'}};
  };
  radar.running=true;
  await radar.tick();
  await radar.stop();
  assert.equal(maxActive,5,'Radar 9 may run at most five concurrent deep workers');
  assert.equal(completedRows,6,'all six selected symbols must finish');
  assert.equal(radar.lastCoverage.deep_attempted,6);
  assert.equal(radar.lastCoverage.deep_completed,6);
  const report=logs.filter(x=>x.startsWith('[RADARX_SCHEDULER_REPORT]')).map(x=>JSON.parse(x.slice(x.indexOf('{')))).at(-1);
  assert.equal(report.deep_concurrency,5);
  assert.equal(report.deep_selected,6);
  assert.equal(report.deep_completed,6);
  assert.equal(report.failed,0);
  assert.equal(report.paper_trading,true);
  assert.equal(report.real_order_execution,false);
});
