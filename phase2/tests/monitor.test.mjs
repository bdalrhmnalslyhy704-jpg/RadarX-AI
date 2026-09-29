import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MarketMonitor} from '../core/monitor.mjs';
import {TEST_FIXTURE,candle} from './fixtures.mjs';

const cfg={symbols:['BTCUSDT'],timeframes:['4h','1h','15m'],
  websocket:{urls:['wss://test'],initialBackoffMs:1,maxBackoffMs:2,jitterRatio:0,heartbeatTimeoutMs:1000,maxConnectionMs:1000},
  monitoring:{bootstrapKlines:10,repairKlines:20,periodicRepairMs:100000,pushRetryMs:100000,maxSeriesLength:50,
    maxStaleTriggerMs:1800000,minDataQuality:70,minLiquidityQuality:60}};

class Rest{
  constructor(){this.lastSuccessAt=Date.now();this.calls=0;}
  health(){return{state:'LIVE',last_success_at:this.lastSuccessAt,last_error:null,rate_limited_until:null,current_base_url:'TEST_FIXTURE'};}
  async klines(_s,tf){this.calls++;const step=tf==='4h'?14400000:tf==='1h'?3600000:900000;return{source:'TEST_FIXTURE',candles:[candle(1700000000000,{tf,price:100,closed:true}),candle(1700000000000+step,{tf,price:101,closed:true})]};}
  async depth(){return{data:{bids:[['100','1000']],asks:[['100.01','1000']]}};}
  async ticker24h(){return{data:{quoteVolume:'100000000',count:10000}};}
}
class WS{start(){}stop(){}health(){return{state:'LIVE',last_message_at:Date.now(),last_connected_at:Date.now(),reconnect_attempts:0,url:'TEST_FIXTURE'}}}

test('TEST_FIXTURE: incomplete websocket candle never triggers analysis; closed candle does',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'radarx-phase2-monitor-')),store=new (await import('../core/store.mjs')).DurableStore({dir});
  await store.init();const rest=new Rest();const analyzed=[];
  const m=new MarketMonitor({config:cfg,rest,wsFactory:()=>new WS(),signalService:{evaluateSnapshot:async x=>{analyzed.push(x);return{};}},store,pushManager:null,logger:{info(){},warn(){},error(){}}});
  m.running=true;m.bootstrapDone=true;m.wsState='LIVE';m.getSeries('BTCUSDT','4h').merge([candle(1700000000000,{tf:'4h',closed:true})]);
  m.getSeries('BTCUSDT','1h').merge([candle(1700000000000,{tf:'1h',closed:true})]);
  m.getSeries('BTCUSDT','15m').merge([candle(1700000000000,{tf:'15m',closed:true})]);
  await m.onCandle(candle(1700000900000,{tf:'15m',closed:false,price:102}));assert.equal(analyzed.length,0);
  await m.onCandle({...candle(1700000900000,{tf:'15m',closed:true,price:102}),symbol:'BTCUSDT'});assert.equal(analyzed.length,1);
});

test('TEST_FIXTURE: websocket disconnect is reflected and REST remains available for repair',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'radarx-phase2-monitor-')),store=new (await import('../core/store.mjs')).DurableStore({dir});
  await store.init();const rest=new Rest(),m=new MarketMonitor({config:cfg,rest,wsFactory:()=>new WS(),signalService:{evaluateSnapshot:async()=>({})},store,pushManager:null,logger:{info(){},warn(){},error(){}}});
  m.running=true;m.wsState='BACKING_OFF';await m.repairOne('BTCUSDT','15m');assert.ok(rest.calls>0);assert.equal(m.isGap('BTCUSDT','15m'),false);
});
