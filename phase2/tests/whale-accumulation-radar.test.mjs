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
