import test from 'node:test';
import assert from 'node:assert/strict';
import {WhaleAccumulationRadar,buildWhaleAccumulationAnalysis} from '../core/whale-accumulation-radar.mjs';

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
test('Whale scan excludes stablecoins, wrapped majors and tokenized equities before Deep selection',()=>{
  const radar=new WhaleAccumulationRadar({
    rest:{},store:{},clock:()=>Date.now(),
    config:{topAnchors:4,rotationBatchSize:4,quote:'USDT'}
  });
  const symbols=['PLUMEUSDT','RSRUSDT','CKBUSDT','RLUSDUSDT','USDCUSDT','FDUSDUSDT','USD1USDT','QQQBUSDT','SOXLBUSDT','WBTCUSDT'];
  radar.universe=symbols;
  const rows=symbols.map((symbol,i)=>({
    symbol,lastPrice:1+i,priceChange24h:.1+i*.03,
    quoteVolume24h:25_000_000-i*100_000,tradeCount24h:20000
  }));
  const selected=radar.selectBatch(rows);
  assert.ok(selected.length>0);
  assert.ok(selected.every(x=>!['RLUSDUSDT','USDCUSDT','FDUSDUSDT','USD1USDT',
    'QQQBUSDT','SOXLBUSDT','WBTCUSDT'].includes(x.symbol)));
  assert.ok(selected.some(x=>x.symbol==='PLUMEUSDT'));
  assert.ok(selected.some(x=>x.symbol==='RSRUSDT'));
  assert.ok(selected.some(x=>x.symbol==='CKBUSDT'));
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
    assert.equal(report.radar,'WHALE_ACCUMULATION_RADAR');
    assert.equal(report.micro_scan_status,'NOT_APPLICABLE_WHALE_ACCUMULATION_HAS_NO_MICRO_STAGE');
    assert.ok(report.deep_scan_wall_ms>0);
    assert.ok(Number.isFinite(report.scheduler_archive_write_ms));
    assert.equal(report.paper_trading,true);
    assert.equal(report.real_order_execution,false);
  }
  assert.ok(archive.some(x=>x.stage==='CYCLE'&&x.reason_code==='WHALE_ACCUMULATION_CYCLE_TIMINGS'));
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
  assert.equal(radar.lastCoverage.scanned_successfully,6);
  const report=logs.filter(x=>x.startsWith('[RADARX_SCHEDULER_REPORT]')).map(x=>JSON.parse(x.slice(x.indexOf('{')))).at(-1);
  assert.equal(report.deep_concurrency,5);
  assert.equal(report.deep_selected,6);
  assert.equal(report.deep_completed,6);
  assert.equal(report.failed,0);
  assert.equal(report.paper_trading,true);
  assert.equal(report.real_order_execution,false);
});

function candleWindow(count,intervalMs,now,offsetMs=0){
  return Array.from({length:count},(_,i)=>{
    const closeTime=now-offsetMs-(count-i-1)*intervalMs-1;
    const openTime=closeTime-intervalMs+1;
    return {openTime,closeTime,open:100,high:101,low:99,close:100,volume:100000,
      tradeCount:100,takerBuyBaseVolume:60000,closed:true};
  });
}

test('Whale radar fails closed when one-minute candle cache is stale',()=>{
  const now=Date.now();
  const result=buildWhaleAccumulationAnalysis({
    ticker:{symbol:'STALEUSDT',lastPrice:100,priceChange24h:0.2,quoteVolume24h:2_000_000},
    oneMinute:candleWindow(40,60_000,now,5*60_000),
    fiveMinute:candleWindow(10,300_000,now),
    aggTrades:[],book:{bids:[[99,100]],asks:[[101,100]]},now
  });
  assert.equal(result.eligible,false);
  assert.equal(result.stage,'DATA_STALE');
  assert.equal(result.score,null);
  assert.equal(result.data_stale,true);
  assert.ok(result.data_quality_reasons.includes('ONE_MINUTE_STALE_CLOSED_CANDLES'));
});

test('Whale radar rejects missing intervals in the candle windows it scores',()=>{
  const now=Date.now();
  const gapped=candleWindow(40,60_000,now).filter((_,i)=>i!==35);
  const result=buildWhaleAccumulationAnalysis({
    ticker:{symbol:'GAPUSDT',lastPrice:100,priceChange24h:0.2,quoteVolume24h:2_000_000},
    oneMinute:gapped,
    fiveMinute:candleWindow(10,300_000,now),
    aggTrades:[],book:{bids:[[99,100]],asks:[[101,100]]},now
  });
  assert.equal(result.eligible,false);
  assert.equal(result.stage,'DATA_GAP');
  assert.equal(result.score,null);
  assert.equal(result.data_stale,false);
  assert.ok(result.data_quality_reasons.includes('ONE_MINUTE_CLOSED_CANDLE_GAP'));
});


test('Whale rotation repays overdue Deep scans before secondary exceptional rows',()=>{
  const now=1_900_000_000_000;
  const radar=new WhaleAccumulationRadar({
    rest:{},store:{},clock:()=>now,
    config:{topAnchors:1,rotationBatchSize:3,schedulerFastPathSlots:1,schedulerQuietAnchorSlots:0}
  });
  const symbols=[
    'BURST1USDT','BURST2USDT','BURST3USDT','BURST4USDT','OVERDUEUSDT',
    'NORMAL1USDT','NORMAL2USDT','NORMAL3USDT','NORMAL4USDT'
  ];
  radar.universe=symbols;
  for(const symbol of symbols){
    const lastAt=symbol==='OVERDUEUSDT'?now-10*60_000:now-60_000;
    radar.scheduler.lastStartedAt.set('DEEP:'+symbol,lastAt);
    radar.scheduler.queuedAt.set('DEEP:'+symbol,now-12*60_000);
  }
  const rows=symbols.map((symbol,i)=>({
    symbol,lastPrice:1+i,priceChange24h:0.1,
    quoteVolume24h:20_000_000-i*100_000,
    _schedulerFast:{
      volume_accel_ratio:symbol.startsWith('BURST')?3.1:1.01,
      trade_accel_ratio:symbol.startsWith('BURST')?2.2:1.01,
      price_acceleration_pct:symbol.startsWith('BURST')?.2:.01
    }
  }));
  const selected=radar.selectBatch(rows,now);
  assert.equal(selected.length,4);
  assert.ok(selected.some(row=>row.symbol==='OVERDUEUSDT'&&row._selection_lane==='rotation'),
    'the old Deep scan must be selected in the fair rotation lane');
});
