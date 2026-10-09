import test from 'node:test';
import assert from 'node:assert/strict';
import {buildFastMarketPulse,updateMarketPulseHistory} from '../core/falcon-market-pulse.mjs';

const base=(symbol,lastPrice,quoteVolume24h=1000000,tradeCount24h=10000)=>({symbol,lastPrice,quoteVolume24h,tradeCount24h,priceChange24h:1,highPrice24h:lastPrice*1.03,lowPrice24h:lastPrice*.97});

test('fast pulse warms up, then detects abnormal participation',()=>{
  const h=new Map();
  const t=1_900_000_000_000;
  let x=updateMarketPulseHistory([base('AAAUSDT',100)],h,t);
  assert.equal(x.rows[0].market_pulse.ready,false);
  x=updateMarketPulseHistory([base('AAAUSDT',100.03,1_000_000,10004)],h,t+30_000);
  assert.equal(x.rows[0].market_pulse.ready,true);
  assert.ok(Number.isFinite(x.rows[0].market_pulse.score));
  x=updateMarketPulseHistory([base('AAAUSDT',100.35,1_001_500,10180)],h,t+60_000);
  assert.ok(x.rows[0].market_pulse.fast_trigger);
  assert.ok(['WAKING','IGNITING','EVENT'].includes(x.rows[0].market_pulse.stage));
  assert.ok(x.rows[0].market_pulse.volumeBurstRatio>0);
});

test('fast pulse preserves broad market coverage without requiring deep candles',()=>{
  const h=new Map(),t=1_900_000_000_000;
  const rows=Array.from({length:100},(_,i)=>base('C'+i+'USDT',1+i));
  const out=updateMarketPulseHistory(rows,h,t+30_000);
  assert.equal(out.coverage,100);
  assert.equal(h.size,100);
});


test('market pulse exposes compression, higher-low and participation evidence for a quiet base',()=>{
  const history=new Map(),t=2_000_000_000_000;
  const prices=[100,100.5,99.8,100.4,100.0,100.1,100.2,100.25];
  let last=null;
  for(let i=0;i<prices.length;i++){
    const row={...base('QUIETUSDT',prices[i],1_000_000+i*550,10_000+i*5),priceChange24h:.5};
    last=updateMarketPulseHistory([row],history,t+i*30_000).rows[0].market_pulse;
  }
  assert.equal(last.ready,true);
  assert.ok(Number.isFinite(last.compressionScore));
  assert.ok(Number.isFinite(last.higherLowScore));
  assert.ok(Number.isFinite(last.participationScore));
  assert.ok(last.compressionScore>=78);
  assert.ok(last.higherLowScore>=70);
  assert.ok(last.participationScore>=58);
  assert.equal(last.fast_trigger,false);
});

test('market pulse preserves missing daily change as unknown',()=>{
  const history=new Map(),t=2_100_000_000_000;
  const row=base('UNKNOWN24HUSDT',1);
  updateMarketPulseHistory([{...row,priceChange24h:.5}],history,t);
  const out=updateMarketPulseHistory([{...row,priceChange24h:null,lastPrice:1.001}],history,t+30_000);
  assert.equal(out.rows[0].market_pulse.ready,true);
  assert.equal(out.rows[0].market_pulse.priceChange24h,null);
});
