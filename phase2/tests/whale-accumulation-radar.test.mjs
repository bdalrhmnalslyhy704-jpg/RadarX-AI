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
