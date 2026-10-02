import { evaluateVCP } from '../vcp-strategy.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePreBreakoutFingerprint } from '../prebreakout-fingerprint.mjs';
import { evaluateSymbolSnapshot } from '../engine.mjs';

function candles(n=140){
  const out=[];
  for(let i=0;i<n;i++){
    let base=100;
    if(i<35) base=115-i*.7;
    else if(i<80) base=90+(i%6)*1.1;
    else if(i<115) base=95+(i%5)*.7;
    else base=98+(i%3)*.35;
    const range=i<80?1.8:(i<115?.9:.45);
    const open=base-(i%2?.18:-.18);
    const close=base+(i%3===0?.22:-.05);
    const high=Math.max(open,close)+range*.55;
    const low=Math.min(open,close)-range*.45;
    const volume=i<115?1000+i%7*25:1100+(i-115)*180;
    out.push({openTime:i*900000,closeTime:(i+1)*900000,open,high,low,close,volume,takerBuyBaseVolume:volume*(i>=115?.62:.50),closed:true});
  }
  // Repeated resistance tests and a confirmed near-resistance close.
  for(const i of [118,124,130,135]) out[i].high=100.3;
  out[n-1].close=100.05;
  out[n-1].high=100.35;
  out[n-1].low=99.65;
  out[n-1].volume=3200;
  return out;
}

const btc=candles(140).map((c,i)=>({...c,close:100+i*.01,open:100+i*.01,high:100.5+i*.01,low:99.5+i*.01}));

test('pre-breakout fingerprint returns an auditable 8-part evidence contract',()=>{
  const series=candles();
  const result=evaluatePreBreakoutFingerprint({series15m:series,series1h:series,series4h:series,btc15m:btc,book:{obi:.12}});
  assert.equal(result.version,'prebreakout-fingerprint.v1');
  assert.ok(['NORMAL','BUILDING','PRE-BREAKOUT','BREAKOUT','RETEST','EXHAUSTED','FALSE_BREAKOUT'].includes(result.stage));
  for(const key of ['structure','compression','volume','relative_power','resistance','order_flow','regime','trigger']){
    assert.ok(Object.hasOwn(result.evidence,key));
  }
  assert.equal(typeof result.evidenceCount,'number');
  assert.ok(Array.isArray(result.sequence));
  assert.ok(result.historical && Array.isArray(result.historical.analogs));
});

test('snapshot exposes the fingerprint without changing the paper-only signal contract',()=>{
  const series=candles(250);
  const result=evaluateSymbolSnapshot({
    symbol:'SANDUSDT',
    series4h:series,
    series1h:series,
    series15m:series,
    btc15m:btc,
    bookRaw:{bids:[['100','200']],asks:[['100.1','100']]},
    ticker24hRaw:{quoteVolume:'1000000',count:1000},
    source:'TEST',
    now:Date.now()
  });
  assert.equal(result.signal.paper_trading,true);
  assert.equal(result.signal.paper_trade.real_order_execution,false);
  assert.equal(result.signal.scores.confidence_score,'UNKNOWN');
  assert.ok(result.fingerprint);
  assert.equal(result.signal.pre_breakout_fingerprint.version,'prebreakout-fingerprint.v1');
});

test('VCP strategy detects a pre-breakout contraction or safely rejects it',()=>{
  const series=candles(180);
  const result=evaluateVCP({series15m:series,series4h:series});
  assert.equal(result.strategy,'VCP_PRE_BREAKOUT');
  assert.ok(['CANDIDATE','CONFIRMED','REJECTED'].includes(result.state));
  assert.ok(Object.hasOwn(result.evidence,'contractions'));
  assert.ok(Object.hasOwn(result.evidence,'volume'));
  assert.ok(Object.hasOwn(result.evidence,'pivot'));
  assert.equal(result.confidence_score,'UNKNOWN');
});
