import test from 'node:test';
import assert from 'node:assert/strict';
import {DurableStore} from '../core/store.mjs';
import {recordSignalPrediction,updateSignalOutcomes,getPredictionCalibration} from '../core/outcome-calibrator.mjs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

async function testStore(){
  const dir=await mkdtemp(join(tmpdir(),'radarx-cal-'));
  return {dir,store:await new DurableStore({dir}).init()};
}

test('outcome calibration records and resolves a winning UP prediction',async()=>{
  const {dir,store}=await testStore();
  try{
    await recordSignalPrediction(store,{symbol:'TESTUSDT',direction:'UP',entryPrice:100,score:90,strategy:'TEST',radar:'TEST_RADAR',now:1000});
    const r=await updateSignalOutcomes(store,{symbol:'TESTUSDT',price:102,now:61*60*1000});
    assert.equal(r.updated>=1,true);
    const c=await getPredictionCalibration(store,'TESTUSDT');
    assert.ok(c);
    assert.equal(c.stats['1h'].samples,1);
    assert.equal(c.stats['1h'].hits,1);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('outcome calibration marks a materially wrong UP prediction as a miss',async()=>{
  const {dir,store}=await testStore();
  try{
    await recordSignalPrediction(store,{symbol:'TESTUSDT',direction:'UP',entryPrice:100,score:90,strategy:'TEST',radar:'TEST_RADAR',now:1000});
    await updateSignalOutcomes(store,{symbol:'TESTUSDT',price:97,now:61*60*1000});
    const c=await getPredictionCalibration(store,'TESTUSDT');
    assert.equal(c.stats['1h'].samples,1);
    assert.equal(c.stats['1h'].hits,0);
    assert.equal(c.stats['1h'].misses,1);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('outcome calibration resolves only the horizon observed inside its bounded time window',async()=>{
  const {dir,store}=await testStore();
  try{
    await recordSignalPrediction(store,{symbol:'TESTUSDT',direction:'UP',entryPrice:100,score:80,strategy:'TEST',radar:'TEST_RADAR',now:1000});
    // 16 minutes after prediction: inside the 15m + 5m grace window, before the 1h horizon.
    const r=await updateSignalOutcomes(store,{symbol:'TESTUSDT',price:101,now:16*60*1000+1000});
    const raw=await store.getPredictionCalibration('TESTUSDT');
    assert.equal(r.updated,1);
    assert.equal(raw.predictions[0].outcomes['15m'],'HIT');
    assert.equal(raw.predictions[0].outcomes['1h'],undefined);
    assert.equal(raw.stats['15m'].samples,1);
    assert.equal(raw.stats['1h'].samples,0);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('late prices are not falsely reused for missed 15m, 1h, or 4h markouts',async()=>{
  const {dir,store}=await testStore();
  try{
    await recordSignalPrediction(store,{symbol:'TESTUSDT',direction:'UP',entryPrice:100,score:90,strategy:'TEST',radar:'TEST_RADAR',now:1000});
    const r=await updateSignalOutcomes(store,{symbol:'TESTUSDT',price:110,now:7*60*60*1000+1000});
    const raw=await store.getPredictionCalibration('TESTUSDT');
    assert.equal(r.updated,0,'a seven-hour-old price must not score any missed early horizon');
    assert.equal(r.unavailable,3);
    assert.equal(raw.predictions[0].outcomes['15m'],'UNAVAILABLE');
    assert.equal(raw.predictions[0].outcomes['1h'],'UNAVAILABLE');
    assert.equal(raw.predictions[0].outcomes['4h'],'UNAVAILABLE');
    assert.equal(raw.predictions[0].outcomes['24h'],undefined);
    for(const h of ['15m','1h','4h']){
      assert.equal(raw.stats[h].samples,0, h+' unavailable markout must not count as a sample');
      assert.equal(raw.stats[h].unavailable,1);
    }
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('late evaluation backfills each horizon from its own closed historical candle',async()=>{
  const {dir,store}=await testStore();
  try{
    const createdAt=1000;
    await recordSignalPrediction(store,{symbol:'TESTUSDT',direction:'UP',entryPrice:100,score:90,strategy:'TEST',radar:'TEST_RADAR',now:createdAt});
    const priceHistory=[
      {closed:true,closeTime:createdAt+15*60*1000,close:102},
      {closed:true,closeTime:createdAt+60*60*1000,close:103},
      {closed:true,closeTime:createdAt+4*60*60*1000,close:104}
    ];
    const r=await updateSignalOutcomes(store,{symbol:'TESTUSDT',price:110,now:createdAt+7*60*60*1000,priceHistory});
    const raw=await store.getPredictionCalibration('TESTUSDT');
    assert.equal(r.updated,3);
    assert.equal(raw.predictions[0].outcomes['15m'],'HIT');
    assert.equal(raw.predictions[0].outcomes['1h'],'HIT');
    assert.equal(raw.predictions[0].outcomes['4h'],'HIT');
    assert.equal(raw.predictions[0].outcomes['24h'],undefined);
    assert.equal(raw.predictions[0].returns['15m'],2);
    assert.equal(raw.predictions[0].returns['1h'],3);
    assert.equal(raw.predictions[0].returns['4h'],4);
    assert.equal(raw.predictions[0].markout_sources['15m'],'CLOSED_15M_CANDLE');
    assert.equal(raw.predictions[0].markout_sources['1h'],'CLOSED_15M_CANDLE');
    assert.equal(raw.predictions[0].markout_sources['4h'],'CLOSED_15M_CANDLE');
    assert.equal(raw.stats['15m'].samples,1);
    assert.equal(raw.stats['1h'].samples,1);
    assert.equal(raw.stats['4h'].samples,1);
  }finally{await rm(dir,{recursive:true,force:true});}
});
