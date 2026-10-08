import test from 'node:test';
import assert from 'node:assert/strict';
import {DurableStore} from '../core/store.mjs';
import {recordSignalPrediction,updateSignalOutcomes,getPredictionCalibration} from '../core/outcome-calibrator.mjs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('outcome calibration records and resolves a winning UP prediction',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'radarx-cal-'));
  try{
    const store=await new DurableStore({dir}).init();
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
  const dir=await mkdtemp(join(tmpdir(),'radarx-cal-'));
  try{
    const store=await new DurableStore({dir}).init();
    await recordSignalPrediction(store,{symbol:'TESTUSDT',direction:'UP',entryPrice:100,score:90,strategy:'TEST',radar:'TEST_RADAR',now:1000});
    await updateSignalOutcomes(store,{symbol:'TESTUSDT',price:97,now:61*60*1000});
    const c=await getPredictionCalibration(store,'TESTUSDT');
    assert.equal(c.stats['1h'].samples,1);
    assert.equal(c.stats['1h'].hits,0);
  }finally{await rm(dir,{recursive:true,force:true});}
});
