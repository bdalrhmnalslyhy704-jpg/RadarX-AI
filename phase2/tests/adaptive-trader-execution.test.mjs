import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {
  readAdaptiveTraderExecutionConfig,
  buildAdaptiveTraderPaperValidationProfile,
  evaluateAdaptiveTraderLiveCandidate,
  BinanceSpotSignedClient,
  AdaptiveTraderExecutionController,
  roundDownToStep,
  roundUpToStep
} from '../core/adaptive-trader-execution.mjs';

const goodEnv={
  RADARX_ADAPTIVE_TRADER_LIVE_ENABLED:'true',
  RADARX_ADAPTIVE_TRADER_NETWORK:'TESTNET',
  BINANCE_SPOT_API_KEY:'test-api-key-not-secret',
  BINANCE_SPOT_API_SECRET:'test-secret-only',
  RADARX_ADAPTIVE_TRADER_MAX_ORDER_USDT:'10',
  RADARX_ADAPTIVE_TRADER_DAILY_LOSS_LIMIT_USDT:'2'
};
function fakeStore(initial=null){
  let state=initial;
  return {
    async getAdaptiveTraderExecutionState(){return state?structuredClone(state):null;},
    async putAdaptiveTraderExecutionState(value){state=structuredClone(value);return state;},
    get state(){return state?structuredClone(state):null;}
  };
}
function candidate(now=Date.now(),overrides={}){
  return {
    symbol:'TESTUSDT',price:1,quote_volume_24h:5_000_000,change_24h_pct:2,
    data_valid:true,data_stale:false,closed_candles_only:true,candle_age_ms:60_000,
    candle_close_time:now-60_000,as_of:new Date(now).toISOString(),
    score:82,tier:'EARLY_SETUP',paper_candidate:true,entry_eligible:false,
    thresholds:{no_chase:true},
    features:{volume_ratio:2.1,trade_ratio:1.7,taker_buy_ratio:0.59,close_location:0.72,
      relative_strength_vs_btc_pct:0.8,hourly_return_pct:1.1},
    ...overrides
  };
}
function snapshot(now=Date.now(),rows=[candidate(now)]){
  return {status:'LIVE_DATA',as_of:new Date(now).toISOString(),candidates:rows,
    meta:{live:true,paper_trading:true,real_order_execution:false,closed_candles_only:true,engine:'ADAPTIVE_TRADER_SIDECAR_V1'}};
}
const learningProfile={ready:true,resolved_samples:120,positive_outcome_rate_pct:56.2,
  adjustments:{volume:1,buyer_flow:1,structure:1,compression:1}};
function fakeExchange({ocoError=null,ocoResponse=null,closedOco=null,exitOrder=null}={}){
  const calls={buys:0,sells:0,ocos:0,preflights:0};
  return {
    calls,
    async preflight(){calls.preflights++;return {checked_at:Date.now()};},
    async symbolFilters(){return {symbol:'TESTUSDT',baseAsset:'TEST',quoteAsset:'USDT',
      stepSize:0.01,marketStepSize:0.01,tickSize:0.01,minQty:0.01,minMarketQty:0.01,
      maxQty:100000,maxMarketQty:100000,minNotional:6,quoteOrderQtyMarketAllowed:true};},
    async account(){return {balances:[{asset:'USDT',free:'100'}]};},
    async placeMarketBuy(args){
      calls.buys++;
      return {symbol:args.symbol,orderId:123,clientOrderId:args.clientOrderId,status:'FILLED',
        executedQty:'10',cummulativeQuoteQty:'10',fills:[{price:'1',qty:'10',commission:'0.01',commissionAsset:'TEST'}]};
    },
    async placeProtectiveOco(args){
      calls.ocos++;
      if(ocoError)throw ocoError;
      if(ocoResponse)return ocoResponse;
      return {orderListId:99,listOrderStatus:'EXECUTING',listStatusType:'EXEC_STARTED',orders:[]};
    },
    async placeMarketSell(args){
      calls.sells++;
      return {symbol:args.symbol,orderId:124,clientOrderId:args.clientOrderId,status:'FILLED',
        executedQty:args.quantity,cummulativeQuoteQty:'9.7',fills:[]};
    },
    async getOrder(){throw new Error('ORDER_NOT_FOUND');},
    async getOrderList(){if(closedOco)return closedOco;throw new Error('ORDER_LIST_NOT_FOUND');},
    async getOrderById(){if(exitOrder)return exitOrder;throw new Error('ORDER_NOT_FOUND');}
  };
}

test('live mode is paper-only by default and never constructs a private client without explicit configuration',()=>{
  const config=readAdaptiveTraderExecutionConfig({});
  assert.equal(config.enabled,false);
  assert.equal(config.mode,'PAPER_ONLY');
  assert.equal(config.max_order_quote_usdt,null);
  const missing=readAdaptiveTraderExecutionConfig({...goodEnv,BINANCE_SPOT_API_SECRET:''});
  assert.equal(missing.enabled,false);
  assert.ok(missing.block_reasons.includes('BINANCE_SPOT_API_SECRET_MISSING'));
  const tooLarge=readAdaptiveTraderExecutionConfig({...goodEnv,RADARX_ADAPTIVE_TRADER_MAX_ORDER_USDT:'200'});
  assert.equal(tooLarge.enabled,false);
  assert.ok(tooLarge.block_reasons.includes('ORDER_CAP_MUST_BE_6_TO_25_USDT'));
});
test('mainnet requires an explicit confirmation string and a small order/loss cap',()=>{
  const config=readAdaptiveTraderExecutionConfig({...goodEnv,RADARX_ADAPTIVE_TRADER_NETWORK:'LIVE'});
  assert.equal(config.enabled,false);
  assert.ok(config.block_reasons.includes('EXPLICIT_LIVE_CONFIRMATION_MISSING'));
  const enabled=readAdaptiveTraderExecutionConfig({...goodEnv,RADARX_ADAPTIVE_TRADER_NETWORK:'LIVE',
    RADARX_ADAPTIVE_TRADER_LIVE_CONFIRMATION:'RADARX_SPOT_LIVE_TRADING_CONFIRMED'});
  assert.equal(enabled.enabled,true);
  assert.equal(enabled.max_order_quote_usdt,10);
  assert.equal(enabled.daily_loss_limit_usdt,2);
  assert.equal(JSON.stringify(enabled).includes('test-secret-only'),false);
});
test('mainnet remains locked until the server paper portfolio proves minimum performance',async()=>{
  const store=fakeStore();const exchange=fakeExchange();
  const env={...goodEnv,RADARX_ADAPTIVE_TRADER_NETWORK:'LIVE',
    RADARX_ADAPTIVE_TRADER_LIVE_CONFIRMATION:'RADARX_SPOT_LIVE_TRADING_CONFIRMED'};
  const controller=new AdaptiveTraderExecutionController({store,env,clientFactory:()=>exchange,logger:{warn(){},error(){}}});
  assert.equal(controller.snapshot().mode,'WAITING_FOR_PAPER_VALIDATION');
  const result=await controller.processSnapshot(snapshot(),{
    learningProfile,
    paperValidationProfile:{ready:false,resolved_paper_trades:99,win_rate_pct:60,net_pnl_usdt:10,max_drawdown_pct:1}
  });
  assert.equal(result.status,'WAITING_FOR_PAPER_VALIDATION');
  assert.equal(exchange.calls.preflights,0);
  assert.equal(exchange.calls.buys,0);
});
test('server paper validation requires 100 closed trades, at least 55 percent wins, positive net PnL and bounded drawdown',()=>{
  const trade=(i,profit)=>({closed_at:i+1,net_pnl:profit,net_return_pct:profit, paper_trading:true,real_order_execution:false});
  const notEnough=buildAdaptiveTraderPaperValidationProfile({
    starting_balance:10000,closed_trades:Array.from({length:99},(_,i)=>trade(i,i%5===0?-1:2))
  });
  assert.equal(notEnough.ready,false);
  assert.equal(notEnough.gate_conditions.minimum_trades_met,false);
  const good=buildAdaptiveTraderPaperValidationProfile({
    starting_balance:10000,closed_trades:Array.from({length:100},(_,i)=>trade(i,i%5===0?-1:2))
  });
  assert.equal(good.ready,true);
  assert.equal(good.resolved_paper_trades,100);
  assert.equal(good.gate_conditions.net_profit_positive,true);
  const bad=buildAdaptiveTraderPaperValidationProfile({
    starting_balance:10000,closed_trades:Array.from({length:100},(_,i)=>trade(i,i<55?1:-3))
  });
  assert.equal(bad.ready,false);
  assert.equal(bad.gate_conditions.net_profit_positive,false);
});
test('a strong old paper history cannot hide a losing most-recent validation window',()=>{
  const row=(i,pnl)=>({closed_at:i+1,net_pnl:pnl,net_return_pct:pnl,paper_trading:true,real_order_execution:false});
  const history=[
    ...Array.from({length:100},(_,i)=>row(i,2)),
    ...Array.from({length:100},(_,i)=>row(100+i,-1))
  ];
  const profile=buildAdaptiveTraderPaperValidationProfile({starting_balance:10000,closed_trades:history});
  assert.equal(profile.resolved_paper_trades,200);
  assert.equal(profile.evaluation_window_trades,100);
  assert.equal(profile.win_rate_pct,0);
  assert.equal(profile.ready,false);
  assert.equal(profile.gate_conditions.net_profit_positive,false);
});
test('live entry gates reject weak setups and require mature resolved observations',()=>{
  const now=Date.now();
  assert.equal(evaluateAdaptiveTraderLiveCandidate(candidate(now),{learningProfile:{ready:true,resolved_samples:99},now,snapshotAsOf:new Date(now).toISOString()}).reason,
    'INSUFFICIENT_RESOLVED_MARKET_OUTCOMES');
  assert.equal(evaluateAdaptiveTraderLiveCandidate(candidate(now,{change_24h_pct:12}),
    {learningProfile,now,snapshotAsOf:new Date(now).toISOString()}).reason,'DAILY_MOVE_OUTSIDE_ENTRY_WINDOW');
  const valid=evaluateAdaptiveTraderLiveCandidate(candidate(now),
    {learningProfile,now,snapshotAsOf:new Date(now).toISOString()});
  assert.equal(valid.eligible,true);
  assert.equal(valid.symbol,'TESTUSDT');
});
test('quantity and price rounding obey exchange filters without rounding quantity up',()=>{
  assert.equal(roundDownToStep(1.239,0.01),1.23);
  assert.equal(roundDownToStep(1.239,0.1),1.2);
  assert.equal(roundUpToStep(1.231,0.01),1.24);
  assert.equal(roundDownToStep(1,0),null);
});
test('signed Binance client signs the exact timestamped payload and only uses the allowlisted origin',async()=>{
  let captured=null;
  const clock=()=>1700000000000;
  const client=new BinanceSpotSignedClient({apiKey:'test-key',apiSecret:'test-secret',clock,
    fetchImpl:async(url,options)=>{captured={url:new URL(url),options};return new Response(JSON.stringify({canTrade:true}),{status:200});}});
  await client.request('GET','/api/v3/account',{}, {signed:true});
  assert.equal(captured.options.headers['X-MBX-APIKEY'],'test-key');
  const params=new URLSearchParams(captured.url.search);
  const signature=params.get('signature');
  params.delete('signature');
  const expected=createHmac('sha256','test-secret').update(params.toString()).digest('hex');
  assert.equal(signature,expected);
  assert.equal(params.get('timestamp'),'1700000000000');
  assert.throws(()=>new BinanceSpotSignedClient({apiKey:'k',apiSecret:'s',baseUrl:'https://attacker.invalid'}),/ORIGIN_NOT_ALLOWED/);
  await assert.rejects(()=>client.request('POST','/api/v3/account',{}, {signed:true}),/ENDPOINT_NOT_ALLOWED/);
});
test('Spot Testnet preflight does not call unsupported Mainnet SAPI permission endpoints',async()=>{
  const requested=[];
  const client=new BinanceSpotSignedClient({apiKey:'testnet-key',apiSecret:'testnet-secret',baseUrl:'https://testnet.binance.vision',
    clock:()=>1700000000000,
    fetchImpl:async(url)=> {
      const parsed=new URL(url);requested.push(parsed.pathname);
      const value=parsed.pathname==='/api/v3/time'?{serverTime:1700000000000}:{canTrade:true,balances:[]};
      return new Response(JSON.stringify(value),{status:200});
    }});
  const result=await client.preflight();
  assert.equal(result.mode,'SPOT_TESTNET');
  assert.equal(result.restrictions,null);
  assert.ok(requested.includes('/api/v3/account'));
  assert.equal(requested.some(path=>path.startsWith('/sapi/')),false);
});
test('exchange preflight rejects keys with withdrawal or derivatives permissions',async()=>{
  let restrictions={ipRestrict:true,enableSpotAndMarginTrading:true,enableWithdrawals:false,enableFutures:false,enableMargin:false};
  const client=new BinanceSpotSignedClient({apiKey:'key',apiSecret:'secret',clock:()=>1700000000000,
    fetchImpl:async(url)=> {
      const path=new URL(url).pathname;
      const value=path==='/api/v3/time'?{serverTime:1700000000000}:
        path==='/api/v3/account'?{canTrade:true}:restrictions;
      return new Response(JSON.stringify(value),{status:200});
    }});
  const good=await client.preflight();
  assert.equal(good.restrictions.enableSpotAndMarginTrading,true);
  restrictions={...restrictions,enableWithdrawals:true};
  const unsafeClient=new BinanceSpotSignedClient({apiKey:'key',apiSecret:'secret',clock:()=>1700000000000,
    fetchImpl:async(url)=> {
      const path=new URL(url).pathname;
      const value=path==='/api/v3/time'?{serverTime:1700000000000}:
        path==='/api/v3/account'?{canTrade:true}:restrictions;
      return new Response(JSON.stringify(value),{status:200});
    }});
  await assert.rejects(()=>unsafeClient.preflight(),/WITHDRAWAL_PERMISSION_MUST_BE_DISABLED/);
});
test('reconciled net trade outcomes produce their own bounded score-calibration profile',async()=>{
  const history=Array.from({length:40},(_,i)=>{
    const profitable=i%2===0;
    return {id:'SELL:'+i,symbol:'TESTUSDT',side:'SELL',status:'FILLED',
      outcome:profitable?'UP':'DOWN',realized_pnl_usdt:profitable?0.2:-0.1,
      entry_features:{volume_ratio:profitable?2.1:0.8,trade_ratio:profitable?1.8:0.9,
        taker_buy_ratio:profitable?0.6:0.45,close_location:profitable?0.75:0.3,
        higher_low:profitable,breakout_above_prior_high:false,
        compression_ratio:profitable?0.7:1.2,hourly_return_pct:1,
        relative_strength_vs_btc_pct:profitable?0.9:-0.6}};
  });
  const store=fakeStore({version:1,trade_history:history});
  const controller=new AdaptiveTraderExecutionController({store,env:goodEnv,clientFactory:()=>fakeExchange(),logger:{warn(){},error(){}}});
  await controller.initialize();
  const status=controller.snapshot();
  assert.equal(status.resolved_trade_outcomes,40);
  assert.equal(status.trade_learning_profile.ready,true);
  assert.ok(status.trade_learning_profile.adjustments.volume>0);
  assert.ok(status.trade_learning_profile.adjustments.buyer_flow>0);
});
test('explicit testnet config can place one tiny market buy only after 100 resolved outcomes and attach an exchange OCO',async()=>{
  const store=fakeStore();const exchange=fakeExchange();
  const controller=new AdaptiveTraderExecutionController({store,env:goodEnv,clientFactory:()=>exchange,logger:{warn(){},error(){}}});
  const now=Date.now();
  const result=await controller.processSnapshot(snapshot(now),{learningProfile});
  assert.equal(result.status,'BUY_FILLED_AND_OCO_PROTECTED');
  assert.equal(exchange.calls.buys,1);
  assert.equal(exchange.calls.ocos,1);
  assert.equal(exchange.calls.sells,0);
  assert.equal(controller.snapshot().open_position.protection_status,'ACTIVE');
  assert.equal(controller.snapshot().real_order_execution,false);
  assert.equal(store.state.daily_trade_count,1);
  assert.equal(store.state.open_position.oco_order_list_id,99);
  assert.equal(store.state.open_position.entry_features.volume_ratio,2.1);
  assert.equal(store.state.open_position.entry_score,82);
});
test('a definitive OCO rejection triggers an emergency market sell and halts new entries',async()=>{
  const store=fakeStore();const exchange=fakeExchange({ocoError:new Error('BINANCE_HTTP_400_-1013')});
  const controller=new AdaptiveTraderExecutionController({store,env:goodEnv,clientFactory:()=>exchange,logger:{warn(){},error(){}}});
  const now=Date.now();
  const result=await controller.processSnapshot(snapshot(now),{learningProfile});
  assert.equal(result.status,'EMERGENCY_LIQUIDATION_FILLED');
  assert.equal(exchange.calls.buys,1);
  assert.equal(exchange.calls.ocos,1);
  assert.equal(exchange.calls.sells,1);
  assert.equal(controller.snapshot().halted,true);
  assert.equal(controller.snapshot().open_position,null);
});
test('confirmed OCO close saves net outcome plus entry features for later trade learning',async()=>{
  const features={volume_ratio:2.1,trade_ratio:1.7,taker_buy_ratio:0.59,close_location:0.72,
    higher_low:true,breakout_above_prior_high:false,compression_ratio:0.7,hourly_return_pct:1.1,
    relative_strength_vs_btc_pct:0.8};
  const store=fakeStore({version:1,utc_day:new Date().toISOString().slice(0,10),daily_trade_count:1,
    daily_realized_pnl_usdt:0,halted:false,halt_reason:null,trade_history:[],pending_buy:null,
    open_position:{symbol:'TESTUSDT',base_asset:'TEST',quantity:10,entry_price:1,entry_quote_usdt:10,
      entry_score:82,entry_features:features,entry_order_id:123,entry_client_order_id:'ATB:TEST',
      oco_client_order_id:'ATX:TEST',opened_at:Date.now()-60_000,stop_loss_price:0.98,take_profit_price:1.03,
      stop_loss_pct:2,take_profit_pct:3,protection_status:'ACTIVE',oco_status:'EXECUTING'}});
  const exchange=fakeExchange({
    closedOco:{listOrderStatus:'ALL_DONE',listStatusType:'ALL_DONE',orders:[{orderId:456}]},
    exitOrder:{side:'SELL',status:'FILLED',orderId:456,cummulativeQuoteQty:'10.2'}
  });
  const controller=new AdaptiveTraderExecutionController({store,env:goodEnv,clientFactory:()=>exchange,logger:{warn(){},error(){}}});
  await controller.initialize();
  await controller.reconcilePosition();
  assert.equal(store.state.open_position,null);
  const sell=store.state.trade_history.find(row=>row.side==='SELL');
  assert.equal(sell.outcome,'UP');
  assert.equal(sell.entry_features.volume_ratio,2.1);
  assert.ok(sell.realized_pnl_usdt>0);
  assert.equal(controller.snapshot().resolved_trade_outcomes,1);
});
test('an unverified OCO response halts the bot without assuming protection or blindly selling',async()=>{
  const store=fakeStore();
  const exchange=fakeExchange({ocoResponse:{orderListId:0,listOrderStatus:'REJECT',listStatusType:'RESPONSE'}});
  const controller=new AdaptiveTraderExecutionController({store,env:goodEnv,clientFactory:()=>exchange,logger:{warn(){},error(){}}});
  const now=Date.now();
  const result=await controller.processSnapshot(snapshot(now),{learningProfile});
  assert.equal(result.status,'BUY_FILLED_PROTECTION_REQUIRES_RECONCILIATION');
  assert.equal(exchange.calls.buys,1);
  assert.equal(exchange.calls.ocos,1);
  assert.equal(exchange.calls.sells,0);
  assert.equal(controller.snapshot().halted,true);
  assert.equal(controller.snapshot().open_position.protection_status,'UNKNOWN');
});
test('kill switch does not submit buys',async()=>{
  const store=fakeStore();const exchange=fakeExchange();
  const controller=new AdaptiveTraderExecutionController({store,env:{...goodEnv,RADARX_ADAPTIVE_TRADER_KILL_SWITCH:'true'},
    clientFactory:()=>exchange,logger:{warn(){},error(){}}});
  const now=Date.now();
  const result=await controller.processSnapshot(snapshot(now),{learningProfile});
  assert.equal(result.status,'HALTED');
  assert.equal(exchange.calls.buys,0);
});
test('disabled live mode performs no authenticated exchange calls',async()=>{
  const store=fakeStore();
  let constructed=false;
  const controller=new AdaptiveTraderExecutionController({store,env:{},clientFactory:()=>{constructed=true;throw new Error('SHOULD_NOT_BE_CREATED');}});
  const result=await controller.processSnapshot(snapshot(),{learningProfile});
  assert.equal(result.status,'PAPER_ONLY');
  assert.equal(constructed,false);
  assert.equal(controller.snapshot().real_order_execution,false);
});
