import test from 'node:test';
import assert from 'node:assert/strict';
import {SymbolDeepAnalyzer,normalizeDeepScanSymbol} from '../core/symbol-deep-analyzer.mjs';
import {createApiServer} from '../http/api.mjs';

function fixtureCandles(count=240){
  const now=Date.now();
  return Array.from({length:count},(_,i)=>{
    const base=100+i*0.08+Math.sin(i/8)*0.6;
    const open=base;
    const close=base+0.12;
    const high=close+0.35;
    const low=open-0.22;
    return {
      openTime:now-((count-i)*15*60*1000)-15*60*1000,
      open,high,low,close,volume:1000+i*2,closeTime:now-((count-i)*15*60*1000),quoteVolume:(1000+i*2)*close,
      tradeCount:100,takerBuyBaseVolume:700,takerBuyQuoteVolume:700*close,closed:true
    };
  });
}

function mockRest(){
  const candles=fixtureCandles();
  return {
    async klines(){return {source:'https://api.binance.com',receivedAt:Date.now(),candles};},
    async ticker24h(){return {source:'https://api.binance.com',data:{
      symbol:'SANDUSDT',lastPrice:'119.32',priceChangePercent:'4.2',highPrice:'121',lowPrice:'112',
      quoteVolume:'3500000',takerBuyQuoteVolume:'2100000'
    }};},
    async depth(){return {source:'https://api.binance.com',data:{
      bids:[['119.2','1000'],['119.1','900'],['119','800']],
      asks:[['119.4','500'],['119.5','450'],['119.6','400']]
    }};}
  };
}

test('TEST_FIXTURE: deep symbol scan normalizes symbols and uses closed candles only',async()=>{
  assert.equal(normalizeDeepScanSymbol('sand'),'SANDUSDT');
  assert.equal(normalizeDeepScanSymbol('SAND/USDT'),'SANDUSDT');
  assert.throws(()=>normalizeDeepScanSymbol(''),/INVALID_SYMBOL/);

  const result=await new SymbolDeepAnalyzer({rest:mockRest()}).scan('SAND');
  assert.equal(result.status,'ok');
  assert.equal(result.symbol,'SANDUSDT');
  assert.equal(result.market,'SPOT');
  assert.equal(result.meta.paper_trading,true);
  assert.equal(result.meta.real_order_execution,false);
  assert.equal(result.data_quality.no_open_candles_used,true);
  assert.equal(result.data_quality.per_timeframe['15m'],240);
  assert.ok(Number.isFinite(result.assessment.direction_score));
  assert.ok(Number.isFinite(result.liquidity.score));
  assert.ok(Number.isFinite(result.pressure.score));
  assert.ok(result.timeframes['4h'].ema20 != null);
  assert.ok(result.zones);
});

test('TEST_FIXTURE: deep symbol scan API is public GET-only and does not create orders',async(t)=>{
  const monitor={rest:mockRest(),health:()=>({database:{state:'LIVE'},websocket:{state:'LIVE'},rest:{state:'LIVE'}})};
  const config={auth:{secret:'',allowedOrigins:[]},api:{rateLimitPerMinute:1000,maxBodyBytes:65536}};
  const analyzer=new SymbolDeepAnalyzer({rest:mockRest()});
  const server=createApiServer({config,store:{},monitor:{health:()=>({database:{state:'LIVE'},websocket:{state:'LIVE'},rest:{state:'LIVE'}})},pushProvider:{status:()=>({})},symbolDeepAnalyzer:analyzer});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+server.address().port;
  const closeServer=()=>new Promise(resolve=>server.close(resolve));
  // Always release the test server, even when an assertion fails.
  t.after(async()=>{if(server.listening)await closeServer();});
  const res=await fetch(base+'/api/symbol-deep-scan?symbol=SAND');
  assert.equal(res.status,200);
  const body=await res.json();
  assert.equal(body.status,'ok');
  assert.equal(body.symbol,'SANDUSDT');
  assert.equal(body.meta?.paper_trading,true);
  assert.equal(body.meta?.real_order_execution,false);
  assert.doesNotMatch(JSON.stringify(body),/createOrder|placeOrder|withdraw|apiKey|secret/i);
  await new Promise(resolve=>server.close(resolve));
});
