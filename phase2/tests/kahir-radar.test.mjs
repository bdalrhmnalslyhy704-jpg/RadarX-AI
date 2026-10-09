import test from 'node:test';
import assert from 'node:assert/strict';
import {buildKahirAnalysis,KahirRadar} from '../core/kahir-radar.mjs';

const NOW=1800000000000;
function candles(count,stepMs,base=100,moveLast=0.004){
  const out=[];
  for(let i=0;i<count;i++){
    const open=base*(1+i*0.00005);
    const move=i===count-1?moveLast:(i%5===0?0.00004:0.00001);
    const close=open*(1+move);
    out.push({
      openTime:NOW-count*stepMs+i*stepMs,
      closeTime:NOW-count*stepMs+(i+1)*stepMs-1,
      open,high:Math.max(open,close)*1.0004,low:Math.min(open,close)*0.9995,close,
      volume:i===count-1?5000:1600,
      quoteVolume:i===count-1?500000:160000,
      tradeCount:i===count-1?500:160,
      closed:true
    });
  }
  return out;
}
function fiveMinuteImpulse(){
  return Array.from({length:70},(_,i)=>{
    const open=100+i*0.01;
    const last=i>=62?open*1.0018:open*1.00005;
    return {
      openTime:NOW-70*300000+i*300000,
      closeTime:NOW-70*300000+(i+1)*300000-1,
      open,high:Math.max(open,last)*1.0007,low:Math.min(open,last)*0.9994,close:last,
      volume:i>=62?4200:1500,quoteVolume:i>=62?420000:150000,tradeCount:i>=62?420:150,
      closed:true
    };
  });
}

test('Kahir detects an unusual self-referenced acceleration with participation and efficiency',()=>{
  const m5=fiveMinuteImpulse();
  const result=buildKahirAnalysis({
    oneMinute:candles(150,60000),
    fiveMinute:m5,
    ticker:{lastPrice:101.2,priceChange24h:3,quoteVolume24h:5000000},
    selfHistory:[
      {price:100,velocity_bps:1, selfChangePct:0.01},
      {price:100.05,velocity_bps:2, selfChangePct:0.05}
    ],
    marketVelocityBps:1,
    now:NOW
  });
  assert.equal(result.closed_candles_only,true);
  assert.equal(result.direction,'UP');
  assert.ok(Number.isFinite(result.score));
  assert.ok(result.metrics.volume_ratio>=1.35);
  assert.ok(result.metrics.efficiency>=0.52);
  assert.ok(result.metrics.relative_acceleration_bps>1.5);
});

test('Kahir refuses an already-extended daily move even when short-term momentum is strong',()=>{
  const result=buildKahirAnalysis({
    oneMinute:candles(150,60000),
    fiveMinute:fiveMinuteImpulse(),
    ticker:{lastPrice:101.2,priceChange24h:18,quoteVolume24h:5000000},
    selfHistory:[{price:100,velocity_bps:1,selfChangePct:0.01},{price:100.05,velocity_bps:2,selfChangePct:0.05}],
    marketVelocityBps:1,
    now:NOW
  });
  assert.equal(result.eligible,false);
});

test('Kahir scans a full Spot universe before selecting a bounded deep set',async()=>{
  const symbols=Array.from({length:50},(_,i)=>'C'+i+'USDT');
  const calls=[];
  const info={symbols:symbols.map(symbol=>({symbol,status:'TRADING',baseAsset:symbol.slice(0,-4),quoteAsset:'USDT',isSpotTradingAllowed:true}))};
  const ticker=symbols.map((symbol,i)=>({
    symbol,lastPrice:String(100+i),priceChangePercent:String(i%9),quoteVolume:String(1000000+i*10000),
    count:1000+i,highPrice:String(110+i),lowPrice:String(90+i)
  }));
  const rest={
    async request(path){
      calls.push(['request',path]);
      if(path==='/api/v3/exchangeInfo')return{data:info,source:'TEST_FIXTURE'};
      if(path==='/api/v3/ticker/24hr')return{data:ticker,source:'TEST_FIXTURE'};
      throw new Error('UNEXPECTED_REQUEST_'+path);
    },
    async klines(){calls.push(['klines']);return{candles:candles(150,60000),source:'TEST_FIXTURE'};},
    health(){return{state:'LIVE'};}
  };
  const store={appendKahirAlert:async()=>{},readKahirAlerts:async()=>[]};
  const radar=new KahirRadar({rest,store,config:{pollMs:60000,universeRefreshMs:300000,minQuoteVolume24h:500000,deepCandidates:4,deepConcurrency:2},clock:()=>NOW,logger:{warn(){}}});
  radar.running=true;
  await radar.refreshUniverse();
  await radar.tick();
  assert.equal(radar.universe.length,50);
  assert.equal(radar.lastResult.universe.scanned,50);
  assert.equal(radar.lastResult.universe.deep_scanned,4);
  assert.equal(calls.filter(x=>x[0]==='klines').length,8);
  assert.equal(radar.health().radar,'KAHIR_RADAR');
  assert.equal(radar.health().closed_candles_only,true);
  await radar.stop();
});



test('Kahir rotates deep-scan slots beyond the same highest-activity candidates',()=>{
  const radar=new KahirRadar({rest:{},store:{},config:{deepCandidates:4,deepRotationReserve:2,deepConcurrency:2},clock:()=>NOW,logger:{warn(){}}});
  const rows=Array.from({length:12},(_,i)=>({
    symbol:`KH${String(i).padStart(2,'0')}USDT`,lastPrice:1+i,
    quoteVolume24h:500_000*(12-i),priceChange24h:8-i*0.8
  }));
  const updates=rows.map((row,i)=>({
    symbol:row.symbol,selfChangePct:0.35-i*0.05,velocityBps:35-i*5,
    marketVelocityBps:0,relativeVelocityBps:35-i*5,at:NOW
  }));
  const covered=new Set();
  for(let cycle=0;cycle<3;cycle++){
    const selected=radar.selectDeep(rows,updates);
    assert.equal(selected.length,4);
    assert.equal(new Set(selected.map(x=>x.symbol)).size,4);
    for(const row of selected)covered.add(row.symbol);
  }
  assert.ok(covered.size>=8,`expected rotating deep scans to cover at least 8 of 12 symbols; got ${covered.size}`);
  assert.equal(radar.deepCursor,6);
});

test('Kahir keeps its loop alive when a transient market request fails',async()=>{
  let calls=0;
  const rest={
    async request(){calls++; throw new Error('TRANSIENT_BINANCE_FAILURE');},
    async klines(){throw new Error('TRANSIENT_BINANCE_FAILURE');},
    health(){return{state:'ERROR'};}
  };
  const radar=new KahirRadar({rest,store:{appendKahirAlert:async()=>{}},config:{pollMs:60000},logger:{warn(){}}});
  radar.running=true;
  const ok=await radar.tick();
  assert.equal(ok,false);
  assert.equal(radar.health().running,true);
  assert.match(radar.health().last_error,/TRANSIENT_BINANCE_FAILURE/);
  assert.ok(calls>=1);
  await radar.stop();
});
