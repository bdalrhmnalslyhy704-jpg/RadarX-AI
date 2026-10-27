import {createHash,createHmac} from 'node:crypto';
import {buildAdaptiveLearningProfile,applyAdaptiveLearning} from './adaptive-trader-engine.mjs';

const LIVE_CONFIRMATION='RADARX_SPOT_LIVE_TRADING_CONFIRMED';
const MIN_ORDER_USDT=6;
const MAX_ORDER_USDT=25;
const MAX_DAILY_LOSS_USDT=5;
const MIN_DAILY_LOSS_USDT=1;
const MIN_LIVE_OUTCOMES=100;
const MAX_OPEN_POSITIONS=1;
const MAX_TRADES_PER_UTC_DAY=2;
const DEFAULT_STOP_LOSS_PCT=2;
const DEFAULT_TAKE_PROFIT_PCT=3;
const FEE_ESTIMATE_RATE=0.001;
const MAX_SNAPSHOT_AGE_MS=2*60*1000;
const MAX_ENTRY_CANDLE_AGE_MS=20*60*1000;
const ALLOWED_ORIGINS=new Set(['https://api.binance.com','https://testnet.binance.vision']);
const FINITE=value=>{
  if(value===null||value===undefined||value==='')return null;
  const number=Number(value);
  return Number.isFinite(number)?number:null;
};
const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
const cleanText=(value,max=180)=>String(value??'').replace(/[\r\n\t]/g,' ').slice(0,max);
const safeSymbol=value=>String(value||'').trim().toUpperCase();
const isLeveraged=value=>/(?:UP|DOWN|BULL|BEAR)USDT$/.test(safeSymbol(value));
const sha=value=>createHash('sha256').update(String(value)).digest('hex');
const clientId=(prefix,value)=>prefix+sha(value).slice(0,28);

export function buildAdaptiveTraderPaperValidationProfile(portfolio,{minTrades=100,minWinRatePct=55,maxDrawdownPct=8}={}){
  const rows=(Array.isArray(portfolio?.closed_trades)?portfolio.closed_trades:[])
    .filter(row=>row&&row.paper_trading===true&&row.real_order_execution===false&&
      FINITE(row.net_pnl)!==null&&FINITE(row.net_return_pct)!==null)
    .map(row=>({closed_at:FINITE(row.closed_at)??0,net_pnl:FINITE(row.net_pnl),net_return_pct:FINITE(row.net_return_pct)}))
    .sort((a,b)=>a.closed_at-b.closed_at);
  let wins=0,totalNet=0,equity=FINITE(portfolio?.starting_balance)||10000,peak=equity,maxDrawdownPct=0;
  for(const row of rows){
    if(row.net_pnl>0)wins++;
    totalNet+=row.net_pnl;equity+=row.net_pnl;peak=Math.max(peak,equity);
    if(peak>0)maxDrawdownPct=Math.max(maxDrawdownPct,(peak-equity)/peak*100);
  }
  const winRatePct=rows.length?wins/rows.length*100:0;
  const ready=rows.length>=Math.max(100,Math.trunc(Number(minTrades)||100))&&
    winRatePct>=Math.max(55,Number(minWinRatePct)||55)&&totalNet>0&&
    maxDrawdownPct<=Math.min(8,Math.max(0,Number(maxDrawdownPct)||8));
  return {
    ready,resolved_paper_trades:rows.length,required_paper_trades:Math.max(100,Math.trunc(Number(minTrades)||100)),
    wins,win_rate_pct:Number(winRatePct.toFixed(2)),net_pnl_usdt:Number(totalNet.toFixed(2)),
    max_drawdown_pct:Number(maxDrawdownPct.toFixed(2)),max_allowed_drawdown_pct:Math.min(8,Math.max(0,Number(maxDrawdownPct)||8)),
    gate_conditions:{minimum_trades_met:rows.length>=Math.max(100,Math.trunc(Number(minTrades)||100)),
      win_rate_met:winRatePct>=Math.max(55,Number(minWinRatePct)||55),
      net_profit_positive:totalNet>0,
      drawdown_within_limit:maxDrawdownPct<=Math.min(8,Math.max(0,Number(maxDrawdownPct)||8))},
    note:ready?'PAPER_VALIDATION_PASSED_NOT_A_PROFIT_GUARANTEE':'LIVE_MAINNET_LOCKED_UNTIL_PAPER_VALIDATION_PASSES'
  };
}

export function readAdaptiveTraderExecutionConfig(env=process.env){
  const requested=String(env.RADARX_ADAPTIVE_TRADER_LIVE_ENABLED||'').trim().toLowerCase()==='true';
  const network=String(env.RADARX_ADAPTIVE_TRADER_NETWORK||'').trim().toUpperCase();
  const apiKey=String(env.BINANCE_SPOT_API_KEY||'').trim();
  const apiSecret=String(env.BINANCE_SPOT_API_SECRET||'').trim();
  const confirmation=String(env.RADARX_ADAPTIVE_TRADER_LIVE_CONFIRMATION||'').trim();
  const orderQuote=FINITE(env.RADARX_ADAPTIVE_TRADER_MAX_ORDER_USDT);
  const dailyLoss=FINITE(env.RADARX_ADAPTIVE_TRADER_DAILY_LOSS_LIMIT_USDT);
  const issues=[];
  if(requested&&network!=='LIVE'&&network!=='TESTNET')issues.push('NETWORK_MUST_BE_EXPLICIT_LIVE_OR_TESTNET');
  if(requested&&!apiKey)issues.push('BINANCE_SPOT_API_KEY_MISSING');
  if(requested&&!apiSecret)issues.push('BINANCE_SPOT_API_SECRET_MISSING');
  if(requested&&!(orderQuote>=MIN_ORDER_USDT&&orderQuote<=MAX_ORDER_USDT))issues.push('ORDER_CAP_MUST_BE_6_TO_25_USDT');
  if(requested&&!(dailyLoss>=MIN_DAILY_LOSS_USDT&&dailyLoss<=MAX_DAILY_LOSS_USDT))issues.push('DAILY_LOSS_CAP_MUST_BE_1_TO_5_USDT');
  if(requested&&network==='LIVE'&&confirmation!==LIVE_CONFIRMATION)issues.push('EXPLICIT_LIVE_CONFIRMATION_MISSING');
  if(requested&&network==='TESTNET'&&confirmation&&confirmation!==LIVE_CONFIRMATION)issues.push('LIVE_CONFIRMATION_VALUE_INVALID');
  const enabled=requested&&issues.length===0;
  const result={
    requested,enabled,network:network==='LIVE'||network==='TESTNET'?network:'NOT_CONFIGURED',
    mode:!requested?'PAPER_ONLY':enabled?(network==='LIVE'?'LIVE_SPOT_GATED':'SPOT_TESTNET'):'BLOCKED_CONFIGURATION',
    block_reasons:issues,
    max_order_quote_usdt:orderQuote!==null?orderQuote:null,
    daily_loss_limit_usdt:dailyLoss!==null?dailyLoss:null,
    min_resolved_outcomes:MIN_LIVE_OUTCOMES,
    max_open_positions:MAX_OPEN_POSITIONS,
    max_trades_per_utc_day:MAX_TRADES_PER_UTC_DAY,
    withdraw_permission_required:false,margin_required:false,futures_required:false
  };
  Object.defineProperty(result,'_credentials',{value:enabled?{apiKey,apiSecret}:null,enumerable:false,writable:false});
  return Object.freeze(result);
}

export function roundDownToStep(value,step){
  const n=FINITE(value),s=FINITE(step);
  if(!(n>=0)||!(s>0))return null;
  const precision=Math.min(12,Math.max(
    (String(step).split('.')[1]||'').length,
    (String(value).split('.')[1]||'').length
  ));
  const units=Math.floor((n+Number.EPSILON*s)/s);
  return Number((units*s).toFixed(precision));
}
export function roundUpToStep(value,step){
  const n=FINITE(value),s=FINITE(step);
  if(!(n>=0)||!(s>0))return null;
  const precision=Math.min(12,Math.max((String(step).split('.')[1]||'').length,(String(value).split('.')[1]||'').length));
  const units=Math.ceil((n-Number.EPSILON*s)/s);
  return Number((units*s).toFixed(precision));
}
function formatNumber(value,step){
  const rounded=roundDownToStep(value,step);
  if(!(rounded>0))return null;
  const decimals=Math.min(12,(String(step).split('.')[1]||'').length);
  return rounded.toFixed(decimals);
}
function positiveStep(filter,key){
  const n=FINITE(filter?.[key]);
  return n!==null&&n>0?n:null;
}
function parseSymbolFilters(info,symbol){
  const row=Array.isArray(info?.symbols)?info.symbols.find(item=>safeSymbol(item?.symbol)===symbol):null;
  if(!row||row.status!=='TRADING'||row.quoteAsset!=='USDT'||row.isSpotTradingAllowed===false||
     (Array.isArray(row.permissions)&&row.permissions.length&&!row.permissions.includes('SPOT'))){
    throw new Error('SPOT_SYMBOL_NOT_TRADABLE');
  }
  const filters=Array.isArray(row.filters)?row.filters:[];
  const lot=filters.find(item=>item.filterType==='LOT_SIZE');
  const marketLot=filters.find(item=>item.filterType==='MARKET_LOT_SIZE')||lot;
  const priceFilter=filters.find(item=>item.filterType==='PRICE_FILTER');
  const minNotionalFilter=filters.find(item=>item.filterType==='NOTIONAL')||filters.find(item=>item.filterType==='MIN_NOTIONAL');
  const stepSize=positiveStep(lot,'stepSize');
  const marketStepSize=positiveStep(marketLot,'stepSize')||stepSize;
  const tickSize=positiveStep(priceFilter,'tickSize');
  const minQty=FINITE(lot?.minQty);
  const marketMinQty=FINITE(marketLot?.minQty);
  const minNotional=FINITE(minNotionalFilter?.minNotional)??MIN_ORDER_USDT;
  if(!(stepSize>0)||!(marketStepSize>0)||!(tickSize>0)||minQty===null||minQty<0||!(minNotional>0))
    throw new Error('SPOT_SYMBOL_FILTERS_INVALID');
  return {symbol,baseAsset:String(row.baseAsset||''),quoteAsset:'USDT',stepSize,marketStepSize,tickSize,
    minQty,minMarketQty:marketMinQty!==null?marketMinQty:minQty,
    maxQty:FINITE(lot?.maxQty),maxMarketQty:FINITE(marketLot?.maxQty),minNotional,
    quoteOrderQtyMarketAllowed:row.quoteOrderQtyMarketAllowed!==false};
}

export function evaluateAdaptiveTraderLiveCandidate(candidate,{learningProfile,now=Date.now(),snapshotAsOf=null}={}){
  const reasons=[];
  const reject=(reason)=>({eligible:false,reason,reasons:[...reasons,reason]});
  if(!candidate||candidate.data_valid!==true)return reject('MARKET_DATA_INVALID');
  if(candidate.data_stale===true||candidate.closed_candles_only!==true)return reject('MARKET_DATA_STALE_OR_OPEN_CANDLE');
  const symbol=safeSymbol(candidate.symbol);
  if(!/^[A-Z0-9]{5,30}$/.test(symbol)||!symbol.endsWith('USDT')||isLeveraged(symbol))return reject('SPOT_USDT_SYMBOL_REQUIRED');
  const age=FINITE(candidate.candle_age_ms);
  if(age===null||age<0||age>MAX_ENTRY_CANDLE_AGE_MS)return reject('CLOSED_CANDLE_TOO_OLD');
  const asOf=Date.parse(String(snapshotAsOf||candidate.as_of||''));
  if(!Number.isFinite(asOf)||asOf>Number(now)+5000||Number(now)-asOf>MAX_SNAPSHOT_AGE_MS)return reject('MARKET_SNAPSHOT_STALE');
  if(candidate.tier!=='EARLY_SETUP'||candidate.paper_candidate!==true||candidate.thresholds?.no_chase!==true)
    return reject('STRICT_EARLY_SETUP_GATE_FAILED');
  const score=FINITE(candidate.score);
  if(score===null||score<75)return reject('SCORE_BELOW_LIVE_THRESHOLD');
  const f=candidate.features||{};
  const requirements=[
    ['volume_ratio',1.75,'VOLUME_ACCELERATION_WEAK'],
    ['trade_ratio',1.5,'TRADE_ACCELERATION_WEAK'],
    ['taker_buy_ratio',0.56,'BUY_FLOW_WEAK'],
    ['close_location',0.65,'CLOSE_LOCATION_WEAK'],
    ['relative_strength_vs_btc_pct',0.25,'RELATIVE_STRENGTH_WEAK']
  ];
  for(const [key,minimum,reason] of requirements){
    const value=FINITE(f[key]);
    if(value===null||value<minimum)return reject(reason);
  }
  const daily=FINITE(candidate.change_24h_pct);
  const hourly=FINITE(f.hourly_return_pct);
  if(daily===null||daily< -3||daily>7)return reject('DAILY_MOVE_OUTSIDE_ENTRY_WINDOW');
  if(hourly===null||hourly>3.5||hourly< -2.5)return reject('HOURLY_MOVE_OUTSIDE_ENTRY_WINDOW');
  if(learningProfile?.ready!==true||Number(learningProfile?.resolved_samples||0)<MIN_LIVE_OUTCOMES)
    return reject('INSUFFICIENT_RESOLVED_MARKET_OUTCOMES');
  return {eligible:true,reason:null,reasons:['LIVE_ELIGIBILITY_RULES_PASSED'],symbol,score,price:FINITE(candidate.price),
    candle_close_time:FINITE(candidate.candle_close_time),candidate_features:{...f}};
}

export class BinanceSpotSignedClient{
  constructor({apiKey,apiSecret,baseUrl='https://api.binance.com',fetchImpl=globalThis.fetch,clock=()=>Date.now()}={}){
    if(!apiKey||!apiSecret)throw new Error('BINANCE_SPOT_CREDENTIALS_REQUIRED');
    if(!ALLOWED_ORIGINS.has(String(baseUrl).replace(/\/+$/,'')))throw new Error('BINANCE_SPOT_ORIGIN_NOT_ALLOWED');
    if(typeof fetchImpl!=='function')throw new Error('BINANCE_FETCH_UNAVAILABLE');
    this.apiKey=String(apiKey);this.apiSecret=String(apiSecret);this.baseUrl=String(baseUrl).replace(/\/+$/,'');
    this.fetchImpl=fetchImpl;this.clock=clock;this.timeOffsetMs=0;this.lastTimeSyncAt=0;
  }
  async request(method,path,params={}, {signed=false}={}){
    const verb=String(method||'GET').toUpperCase();
    const allowed=new Set([
      'GET /api/v3/time','GET /api/v3/account','GET /sapi/v1/account/apiRestrictions',
      'GET /api/v3/exchangeInfo','GET /api/v3/ticker/price','GET /api/v3/orderList',
      'GET /api/v3/order','POST /api/v3/order','POST /api/v3/orderList/oco'
    ]);
    if(!allowed.has(verb+' '+path))throw new Error('BINANCE_SPOT_ENDPOINT_NOT_ALLOWED');
    if((path==='/api/v3/time'||path==='/api/v3/exchangeInfo'||path==='/api/v3/ticker/price')&&signed)
      throw new Error('UNEXPECTED_SIGNATURE_FOR_PUBLIC_ENDPOINT');
    if((path==='/api/v3/account'||path==='/sapi/v1/account/apiRestrictions'||path==='/api/v3/orderList'||path==='/api/v3/order')&&!signed)
      throw new Error('SIGNATURE_REQUIRED_FOR_PRIVATE_ENDPOINT');
    const query=new URLSearchParams();
    for(const [key,value] of Object.entries(params||{})){
      if(value!==undefined&&value!==null)query.set(key,String(value));
    }
    if(signed){
      query.set('timestamp',String(Math.trunc(this.clock()+this.timeOffsetMs)));
      query.set('recvWindow','5000');
      const payload=query.toString();
      query.set('signature',createHmac('sha256',this.apiSecret).update(payload).digest('hex'));
    }
    const url=this.baseUrl+path+(query.size?'?'+query.toString():'');
    let response;
    try{
      response=await this.fetchImpl(url,{method:verb,headers:{'X-MBX-APIKEY':this.apiKey,'accept':'application/json'}});
    }catch{
      const error=new Error('BINANCE_NETWORK_ERROR');
      error.indeterminate=verb==='POST';
      throw error;
    }
    let payload;
    try{payload=await response.json();}
    catch{payload=null;}
    if(!response.ok||!payload||typeof payload!=='object'){
      const error=new Error('BINANCE_HTTP_'+Number(response.status||0)+'_'+cleanText(payload?.code??'INVALID_RESPONSE',40));
      error.exchangeCode=FINITE(payload?.code);
      error.indeterminate=verb==='POST'&&Number(response.status)>=500;
      throw error;
    }
    if(typeof payload.code==='number'&&payload.code<0){
      const error=new Error('BINANCE_REJECTED_'+payload.code);
      error.exchangeCode=payload.code;
      error.indeterminate=verb==='POST'&&payload.code===-1007;
      throw error;
    }
    return payload;
  }
  async syncTime(){
    const payload=await this.request('GET','/api/v3/time');
    const serverTime=FINITE(payload?.serverTime);
    if(serverTime===null)throw new Error('BINANCE_SERVER_TIME_INVALID');
    this.timeOffsetMs=serverTime-this.clock();this.lastTimeSyncAt=this.clock();
    return {offset_ms:this.timeOffsetMs,as_of:serverTime};
  }
  async preflight(){
    if(!this.lastTimeSyncAt||this.clock()-this.lastTimeSyncAt>30*60*1000)await this.syncTime();
    const account=await this.request('GET','/api/v3/account',{}, {signed:true});
    if(account?.canTrade!==true)throw new Error('BINANCE_ACCOUNT_TRADING_NOT_ENABLED');
    if(this.baseUrl==='https://testnet.binance.vision'){
      return {account,restrictions:null,checked_at:this.clock(),mode:'SPOT_TESTNET'};
    }
    const restrictions=await this.request('GET','/sapi/v1/account/apiRestrictions',{}, {signed:true});
    if(restrictions?.enableSpotAndMarginTrading!==true)throw new Error('BINANCE_SPOT_TRADE_PERMISSION_NOT_ENABLED');
    if(restrictions?.enableWithdrawals!==false)throw new Error('BINANCE_WITHDRAWAL_PERMISSION_MUST_BE_DISABLED');
    if(restrictions?.enableFutures!==false)throw new Error('BINANCE_FUTURES_PERMISSION_MUST_BE_DISABLED');
    if(restrictions?.enableMargin!==false)throw new Error('BINANCE_MARGIN_PERMISSION_MUST_BE_DISABLED');
    if(restrictions?.ipRestrict!==true)throw new Error('BINANCE_API_KEY_IP_RESTRICTION_REQUIRED');
    return {account,restrictions,checked_at:this.clock(),mode:'LIVE_SPOT_GATED'};
  }
  async symbolFilters(symbol){
    return parseSymbolFilters(await this.request('GET','/api/v3/exchangeInfo',{symbol}),symbol);
  }
  async account(){
    return this.request('GET','/api/v3/account',{}, {signed:true});
  }
  async placeMarketBuy({symbol,quoteOrderQty,clientOrderId:orderId}){
    return this.request('POST','/api/v3/order',{
      symbol,side:'BUY',type:'MARKET',quoteOrderQty:String(quoteOrderQty),
      newClientOrderId:orderId,newOrderRespType:'FULL'
    },{signed:true});
  }
  async placeMarketSell({symbol,quantity,clientOrderId:orderId}){
    return this.request('POST','/api/v3/order',{
      symbol,side:'SELL',type:'MARKET',quantity:String(quantity),
      newClientOrderId:orderId,newOrderRespType:'FULL'
    },{signed:true});
  }
  async placeProtectiveOco({symbol,quantity,stopPrice,takeProfitPrice,listClientOrderId:orderId}){
    return this.request('POST','/api/v3/orderList/oco',{
      symbol,side:'SELL',quantity:String(quantity),
      aboveType:'TAKE_PROFIT_LIMIT',aboveStopPrice:String(takeProfitPrice),
      abovePrice:String(takeProfitPrice),aboveTimeInForce:'GTC',
      belowType:'STOP_LOSS',belowStopPrice:String(stopPrice),
      listClientOrderId:orderId,newOrderRespType:'RESULT'
    },{signed:true});
  }
  async getOrder({symbol,origClientOrderId}){
    return this.request('GET','/api/v3/order',{symbol,origClientOrderId},{signed:true});
  }
  async getOrderList({origClientOrderId}){
    return this.request('GET','/api/v3/orderList',{origClientOrderId},{signed:true});
  }
  async getOrderById({symbol,orderId}){
    return this.request('GET','/api/v3/order',{symbol,orderId},{signed:true});
  }
}

export class AdaptiveTraderExecutionController{
  constructor({store,env=process.env,clientFactory=(config)=>new BinanceSpotSignedClient({
    apiKey:config._credentials?.apiKey,apiSecret:config._credentials?.apiSecret,
    baseUrl:config.network==='TESTNET'?'https://testnet.binance.vision':'https://api.binance.com'
  }),logger=console,clock=()=>Date.now()}={}){
    if(!store||typeof store.getAdaptiveTraderExecutionState!=='function'||typeof store.putAdaptiveTraderExecutionState!=='function')
      throw new Error('ADAPTIVE_TRADER_EXECUTION_STORE_REQUIRED');
    this.store=store;this.config=readAdaptiveTraderExecutionConfig(env);this.logger=logger;this.clock=clock;this.env=env;
    this.client=this.config.enabled?clientFactory(this.config):null;
    this.state={version:1,utc_day:null,daily_trade_count:0,daily_realized_pnl_usdt:0,halted:false,halt_reason:null,
      last_event:'NOT_STARTED',last_error:null,last_preflight_at:0,preflight_status:'NOT_CHECKED',
      pending_buy:null,open_position:null,trade_history:[]};
    this.initialized=false;this.inFlight=false;this.readyInfo=null;this.lastSnapshot=null;
  }
  safeConfiguration(){
    const { _credentials, ...safe }=this.config;
    return {...safe,live_key_configured:Boolean(this.config._credentials),real_order_execution:this.config.mode==='LIVE_SPOT_GATED'&&this.config.enabled,
      paper_trading:!(this.config.mode==='LIVE_SPOT_GATED'&&this.config.enabled)};
  }
  tradeLearningProfile(){
    const rows=(Array.isArray(this.state.trade_history)?this.state.trade_history:[])
      .filter(row=>row&&row.side==='SELL'&&row.status==='FILLED'&&
        ['UP','DOWN','FLAT'].includes(row.outcome)&&row.entry_features&&typeof row.entry_features==='object')
      .map(row=>({outcome:row.outcome,features:row.entry_features}));
    return buildAdaptiveLearningProfile(rows);
  }
  snapshot(){
    const tradeLearningProfile=this.tradeLearningProfile();
    return {
      mode:this.currentMode(),enabled:this.config.enabled,requested:this.config.requested,
      network:this.config.network,block_reasons:[...this.config.block_reasons],
      max_order_quote_usdt:this.config.max_order_quote_usdt,daily_loss_limit_usdt:this.config.daily_loss_limit_usdt,
      daily_trade_count:this.state.daily_trade_count,daily_realized_pnl_usdt:Number((Number(this.state.daily_realized_pnl_usdt)||0).toFixed(4)),
      halted:this.state.halted===true,halt_reason:this.state.halt_reason,
      preflight_status:this.state.preflight_status,last_preflight_at:this.state.last_preflight_at||null,
      pending_order_reconciliation:Boolean(this.state.pending_buy),
      resolved_trade_outcomes:tradeLearningProfile.resolved_samples,
      trade_learning_profile:tradeLearningProfile,
      paper_validation_profile:this.state.paper_validation_profile||null,
      open_position:this.state.open_position?{symbol:this.state.open_position.symbol,opened_at:this.state.open_position.opened_at,
        entry_price:this.state.open_position.entry_price,quantity:this.state.open_position.quantity,
        protection_status:this.state.open_position.protection_status,oco_status:this.state.open_position.oco_status}:null,
      last_event:this.state.last_event,last_error:this.state.last_error,
      min_resolved_outcomes:MIN_LIVE_OUTCOMES,max_open_positions:MAX_OPEN_POSITIONS,
      paper_trading:this.currentMode()!=='LIVE_SPOT_GATED',real_order_execution:this.currentMode()==='LIVE_SPOT_GATED'
    };
  }
  currentMode(){
    if(!this.config.requested)return 'PAPER_ONLY';
    if(!this.config.enabled)return 'BLOCKED_CONFIGURATION';
    if(String(this.state.halt_reason||'')==='KILL_SWITCH')return 'HALTED';
    if(this.state.halted)return 'HALTED';
    if(this.state.preflight_status==='REJECTED')return 'BLOCKED_EXCHANGE_PERMISSIONS';
    if(this.state.preflight_status==='READY'){
      if(this.config.network==='LIVE'&&this.state.paper_validation_ready!==true)return 'WAITING_FOR_PAPER_VALIDATION';
      return this.config.network==='LIVE'?'LIVE_SPOT_GATED':'SPOT_TESTNET';
    }
    return 'WAITING_FOR_PREFLIGHT';
  }
  async initialize(){
    if(this.initialized)return this.snapshot();
    const saved=await this.store.getAdaptiveTraderExecutionState();
    if(saved&&saved.version===1){
      this.state={...this.state,...saved,
        trade_history:Array.isArray(saved.trade_history)?saved.trade_history.slice(-500):[],
        pending_buy:saved.pending_buy&&typeof saved.pending_buy==='object'?saved.pending_buy:null,
        open_position:saved.open_position&&typeof saved.open_position==='object'?saved.open_position:null};
    }
    this.rollUtcDay();
    this.initialized=true;
    await this.persist();
    return this.snapshot();
  }
  async persist(){
    await this.store.putAdaptiveTraderExecutionState({...this.state,version:1});
  }
  rollUtcDay(){
    const day=new Date(this.clock()).toISOString().slice(0,10);
    if(this.state.utc_day!==day){
      this.state.utc_day=day;this.state.daily_trade_count=0;this.state.daily_realized_pnl_usdt=0;
      if(this.state.halt_reason==='DAILY_LOSS_LIMIT') {this.state.halted=false;this.state.halt_reason=null;}
    }
  }
  async ensurePreflight(){
    if(this.state.preflight_status==='READY'&&this.clock()-Number(this.state.last_preflight_at||0)<30*60*1000)return true;
    try{
      const result=await this.client.preflight();
      this.readyInfo=result;this.state.preflight_status='READY';this.state.last_preflight_at=this.clock();
      this.state.last_error=null;await this.persist();return true;
    }catch(error){
      this.state.preflight_status='REJECTED';this.state.last_preflight_at=this.clock();
      this.state.last_error=cleanText(error?.message||'EXCHANGE_PREFLIGHT_FAILED');
      this.state.last_event='LIVE_PREFLIGHT_REJECTED';await this.persist();
      this.logger.warn?.('[ADAPTIVE_TRADER_PREFLIGHT_BLOCKED] '+this.state.last_error);
      return false;
    }
  }
  async processSnapshot(snapshot,{learningProfile=null,paperValidationProfile=null}={}){
    if(this.inFlight)return {status:'BUSY',execution:this.snapshot()};
    if(!this.initialized)await this.initialize();
    this.rollUtcDay();
    if(!this.config.requested){this.state.last_event='PAPER_ONLY_LIVE_EXECUTION_NOT_REQUESTED';await this.persist();return {status:'PAPER_ONLY',execution:this.snapshot()};}
    if(!this.config.enabled){this.state.last_event='LIVE_CONFIGURATION_BLOCKED';this.state.last_error=this.config.block_reasons.join(',');await this.persist();return {status:'BLOCKED',execution:this.snapshot()};}
    const killSwitch=String(this.env.RADARX_ADAPTIVE_TRADER_KILL_SWITCH||'').trim().toLowerCase()==='true';
    if(killSwitch&&!this.state.halted){
      this.state.halted=true;this.state.halt_reason='KILL_SWITCH';this.state.last_event='KILL_SWITCH_ACTIVE';await this.persist();
    }
    if(!snapshot||snapshot.status!=='LIVE_DATA'||snapshot.meta?.live!==true||
       snapshot.meta?.paper_trading!==true||snapshot.meta?.real_order_execution!==false||
       snapshot.meta?.closed_candles_only!==true||snapshot.meta?.engine!=='ADAPTIVE_TRADER_SIDECAR_V1'){
      this.state.last_event='INVALID_LIVE_SNAPSHOT';this.state.last_error='LIVE_SNAPSHOT_CONTRACT_FAILED';await this.persist();
      return {status:'BLOCKED',execution:this.snapshot()};
    }
    const asOf=Date.parse(String(snapshot.as_of||''));
    if(!Number.isFinite(asOf)||asOf>this.clock()+5000||this.clock()-asOf>MAX_SNAPSHOT_AGE_MS){
      this.state.last_event='STALE_LIVE_SNAPSHOT';this.state.last_error='MARKET_SNAPSHOT_STALE';await this.persist();
      return {status:'BLOCKED',execution:this.snapshot()};
    }
    this.state.paper_validation_ready=paperValidationProfile?.ready===true;
    this.state.paper_validation_profile=paperValidationProfile&&typeof paperValidationProfile==='object'?paperValidationProfile:null;
    if(this.config.network==='LIVE'&&this.state.paper_validation_ready!==true){
      this.state.last_event='WAITING_FOR_PAPER_VALIDATION';
      this.state.last_error=null;await this.persist();
      return {status:'WAITING_FOR_PAPER_VALIDATION',execution:this.snapshot()};
    }
    if(!await this.ensurePreflight())return {status:'BLOCKED',execution:this.snapshot()};
    this.inFlight=true;
    try{
      if(this.state.pending_buy){
        await this.reconcilePendingBuy();
        return {status:'PENDING_RECONCILIATION',execution:this.snapshot()};
      }
      if(this.state.open_position){
        await this.reconcilePosition();
        return {status:'POSITION_MONITORED',execution:this.snapshot()};
      }
      if(killSwitch||this.state.halted)return {status:'HALTED',execution:this.snapshot()};
      if(this.state.daily_realized_pnl_usdt<=-Math.abs(this.config.daily_loss_limit_usdt)){
        this.state.halted=true;this.state.halt_reason='DAILY_LOSS_LIMIT';this.state.last_event='DAILY_LOSS_LIMIT_REACHED';
        await this.persist();return {status:'HALTED',execution:this.snapshot()};
      }
      if(this.state.daily_trade_count>=MAX_TRADES_PER_UTC_DAY){
        this.state.last_event='DAILY_TRADE_LIMIT_REACHED';await this.persist();
        return {status:'RISK_LIMIT',execution:this.snapshot()};
      }
      if(learningProfile?.ready!==true||Number(learningProfile?.resolved_samples||0)<MIN_LIVE_OUTCOMES){
        this.state.last_event='WAITING_FOR_LEARNING_EVIDENCE';await this.persist();
        return {status:'WAITING_FOR_LEARNING',execution:this.snapshot()};
      }
      const tradeLearningProfile=this.tradeLearningProfile();
      const latestCandidates=[...(snapshot.candidates||[])].map(candidate=>{
        const baseScore=FINITE(candidate?.score);
        const learnedScore=applyAdaptiveLearning(baseScore,candidate?.features||{},tradeLearningProfile);
        return baseScore===null||learnedScore===null?candidate:{...candidate,execution_base_score:baseScore,
          score:learnedScore,trade_learning_adjustment:Number((learnedScore-baseScore).toFixed(2))};
      }).sort((a,b)=>(Number(b.score)||0)-(Number(a.score)||0));
      let selected=null;
      for(const candidate of latestCandidates){
        const result=evaluateAdaptiveTraderLiveCandidate(candidate,{learningProfile,now:this.clock(),snapshotAsOf:snapshot.as_of});
        if(result.eligible){selected={candidate,decision:result};break;}
      }
      if(!selected){
        this.state.last_event='NO_CANDIDATE_PASSED_LIVE_GATES';this.state.last_error=null;await this.persist();
        return {status:'NO_TRADE',execution:this.snapshot()};
      }
      const result=await this.openProtectedPosition(selected.candidate,selected.decision,snapshot);
      this.state.last_event=result.status;this.state.last_error=result.error||null;await this.persist();
      return {status:result.status,execution:this.snapshot()};
    }catch(error){
      this.state.last_error=cleanText(error?.message||'LIVE_EXECUTION_FAILED');
      this.state.last_event='LIVE_EXECUTION_ERROR';await this.persist();
      this.logger.error?.('[ADAPTIVE_TRADER_EXECUTION_ERROR] '+this.state.last_error);
      return {status:'ERROR',execution:this.snapshot()};
    }finally{this.inFlight=false;}
  }
  async openProtectedPosition(candidate,decision,snapshot){
    const symbol=decision.symbol;
    const closeAt=Number(candidate.candle_close_time)||Date.parse(snapshot.as_of);
    const buyId=clientId('ATB',symbol+':'+String(closeAt));
    if(this.state.trade_history.some(row=>row?.id===buyId&&row?.side==='BUY')){
      this.state.last_event='SIGNAL_CANDLE_ALREADY_TRADED';
      return {status:'NO_TRADE_DUPLICATE_CLOSED_CANDLE'};
    }
    const filters=await this.client.symbolFilters(symbol);
    if(!filters.quoteOrderQtyMarketAllowed)throw new Error('SYMBOL_MARKET_QUOTE_ORDER_QTY_UNAVAILABLE');
    const account=await this.client.account();
    const freeUsdt=Number((account?.balances||[]).find(row=>row.asset==='USDT')?.free||0);
    let quoteAmount=Math.min(Number(this.config.max_order_quote_usdt),Math.max(0,freeUsdt-2));
    const referencePrice=FINITE(candidate.price);
    if(filters.maxQty!==null&&filters.maxQty>0&&referencePrice>0&&quoteAmount/referencePrice>filters.maxQty)
      quoteAmount=Math.min(quoteAmount,filters.maxQty*referencePrice*0.98);
    const minOrder=Math.max(MIN_ORDER_USDT,filters.minNotional);
    if(!(quoteAmount>=minOrder))throw new Error('INSUFFICIENT_FREE_USDT_OR_MIN_NOTIONAL');
    const positionIntent={symbol,client_order_id:buyId,requested_quote_usdt:Number(quoteAmount.toFixed(2)),
      created_at:this.clock(),status:'PENDING_BUY_RECONCILIATION',candle_close_time:closeAt,
      candidate_features:{...(candidate.features||{})},entry_score:FINITE(candidate.score)};
    this.state.pending_buy=positionIntent;await this.persist();
    let buy;
    try{
      buy=await this.client.placeMarketBuy({symbol,quoteOrderQty:quoteAmount.toFixed(2),clientOrderId:buyId});
    }catch(error){
      if(error?.indeterminate)throw new Error('BUY_ORDER_STATUS_UNKNOWN_NO_RETRY');
      this.state.pending_buy=null;await this.persist();throw error;
    }
    return this.acceptFilledBuy(candidate,buy,positionIntent,filters);
  }
  async acceptFilledBuy(candidate,buy,intent,filters){
    const filledQty=FINITE(buy?.executedQty),quoteSpent=FINITE(buy?.cummulativeQuoteQty);
    if(!(filledQty>0)||!(quoteSpent>0)||!['FILLED','PARTIALLY_FILLED'].includes(String(buy?.status||''))){
      this.state.pending_buy={...intent,status:'ORDER_RESPONSE_NEEDS_RECONCILIATION'};
      await this.persist();return {status:'BUY_RESPONSE_UNCERTAIN',error:'BUY_FILL_NOT_CONFIRMED'};
    }
    const baseAsset=filters.baseAsset;
    const baseFees=(Array.isArray(buy.fills)?buy.fills:[]).filter(fill=>String(fill.commissionAsset||'')===baseAsset)
      .reduce((sum,fill)=>sum+(FINITE(fill.commission)||0),0);
    const netQty=roundDownToStep(filledQty-baseFees,filters.stepSize);
    if(!(netQty>=filters.minQty)|| (filters.maxQty!==null&&netQty>filters.maxQty)){
      this.state.pending_buy={...intent,status:'FILLED_QUANTITY_BELOW_MARKET_MINIMUM'};
      await this.persist();return {status:'BUY_FILLED_NEEDS_MANUAL_RECONCILIATION',error:'FILLED_QUANTITY_BELOW_MARKET_MINIMUM'};
    }
    const entryPrice=quoteSpent/filledQty;
    const stopRaw=entryPrice*(1-DEFAULT_STOP_LOSS_PCT/100);
    const targetRaw=entryPrice*(1+DEFAULT_TAKE_PROFIT_PCT/100);
    const stop=roundDownToStep(stopRaw,filters.tickSize);
    const target=roundUpToStep(targetRaw,filters.tickSize);
    if(!(stop>0&&target>entryPrice))throw new Error('PROTECTIVE_PRICES_INVALID');
    const ocoId=clientId('ATX',intent.client_order_id);
    this.state.open_position={
      symbol:intent.symbol,base_asset:baseAsset,quantity:netQty,entry_price:entryPrice,
      entry_quote_usdt:quoteSpent,entry_score:FINITE(candidate?.score)??FINITE(intent.entry_score),
      entry_features:{...(candidate?.features||intent.candidate_features||{})},
      entry_order_id:buy.orderId,entry_client_order_id:intent.client_order_id,
      oco_client_order_id:ocoId,opened_at:this.clock(),stop_loss_price:stop,take_profit_price:target,
      stop_loss_pct:DEFAULT_STOP_LOSS_PCT,take_profit_pct:DEFAULT_TAKE_PROFIT_PCT,
      protection_status:'PENDING',oco_status:'PENDING'
    };
    this.state.pending_buy=null;this.state.daily_trade_count=(Number(this.state.daily_trade_count)||0)+1;
    this.state.trade_history.unshift({id:intent.client_order_id,symbol:intent.symbol,side:'BUY',status:'FILLED',
      order_id:buy.orderId,price:entryPrice,quote_usdt:quoteSpent,at:this.clock(),real_order_execution:this.config.network==='LIVE'});
    this.state.trade_history=this.state.trade_history.slice(0,500);await this.persist();
    try{
      const oco=await this.client.placeProtectiveOco({symbol:intent.symbol,quantity:formatNumber(netQty,filters.stepSize),
        stopPrice:formatNumber(stop,filters.tickSize),takeProfitPrice:formatNumber(target,filters.tickSize),listClientOrderId:ocoId});
      const ocoIdValue=FINITE(oco?.orderListId);
      const ocoStatus=String(oco?.listOrderStatus||'');
      const ocoType=String(oco?.listStatusType||'');
      if(!(ocoIdValue>0)||!['EXECUTING','EXECUTED','ALL_DONE'].includes(ocoStatus)||!['EXEC_STARTED','EXEC_FINISHED'].includes(ocoType)){
        const error=new Error('PROTECTIVE_ORDER_RESPONSE_UNVERIFIED');
        error.indeterminate=true;
        throw error;
      }
      this.state.open_position.protection_status='ACTIVE';
      this.state.open_position.oco_status=ocoStatus;
      this.state.open_position.oco_order_list_id=ocoIdValue;
      this.state.last_error=null;await this.persist();
      return {status:'BUY_FILLED_AND_OCO_PROTECTED',position:this.state.open_position};
    }catch(error){
      this.state.open_position.protection_status=error?.indeterminate?'UNKNOWN':'FAILED';
      this.state.open_position.oco_status='RECONCILIATION_REQUIRED';
      this.state.halted=true;this.state.halt_reason='PROTECTIVE_ORDER_NOT_CONFIRMED';
      this.state.last_error=cleanText(error?.message||'PROTECTIVE_ORDER_NOT_CONFIRMED');
      await this.persist();
      if(!error?.indeterminate){
        try{
          const liquidation=await this.client.placeMarketSell({symbol:intent.symbol,
            quantity:formatNumber(roundDownToStep(netQty,filters.marketStepSize),filters.marketStepSize),clientOrderId:clientId('ATS',intent.client_order_id)});
          if(liquidation?.status==='FILLED'&&Number(liquidation?.executedQty)>0&&Number(liquidation?.cummulativeQuoteQty)>0){
            const proceeds=Number(liquidation.cummulativeQuoteQty),fees=(quoteSpent+proceeds)*FEE_ESTIMATE_RATE;
            const pnl=proceeds-quoteSpent-fees;
            this.state.daily_realized_pnl_usdt=Number((Number(this.state.daily_realized_pnl_usdt||0)+pnl).toFixed(4));
            this.state.trade_history.unshift({id:clientId('ATS',intent.client_order_id),symbol:intent.symbol,side:'SELL',
              status:'FILLED',order_id:liquidation.orderId,quote_usdt:proceeds,realized_pnl_usdt:Number(pnl.toFixed(4)),
              net_return_pct:quoteSpent>0?Number((pnl/quoteSpent*100).toFixed(3)):null,
              outcome:pnl>0?'UP':'DOWN',entry_score:FINITE(this.state.open_position?.entry_score),
              entry_features:{...(this.state.open_position?.entry_features||{})},
              at:this.clock(),exit_source:'EMERGENCY_AFTER_OCO_REJECTION',real_order_execution:this.config.network==='LIVE'});
            this.state.trade_history=this.state.trade_history.slice(0,500);
            this.state.open_position=null;this.state.halt_reason='PROTECTIVE_ORDER_REJECTED_AFTER_ENTRY';
            this.state.last_event='EMERGENCY_SELL_FILLED_AFTER_OCO_REJECTION';
            await this.persist();
            return {status:'EMERGENCY_LIQUIDATION_FILLED',error:this.state.last_error};
          }
          this.state.open_position.protection_status='EMERGENCY_SELL_UNCONFIRMED';
          this.state.last_error='EMERGENCY_SELL_FILL_NOT_CONFIRMED';
        }catch(liquidationError){
          this.state.open_position.protection_status=liquidationError?.indeterminate?'EMERGENCY_SELL_UNKNOWN':'EMERGENCY_SELL_FAILED';
          this.state.last_error=cleanText(liquidationError?.message||'EMERGENCY_SELL_FAILED');
        }
        this.state.halt_reason='PROTECTIVE_ORDER_REJECTED_AFTER_ENTRY';
        await this.persist();
      }
      return {status:'BUY_FILLED_PROTECTION_REQUIRES_RECONCILIATION',error:this.state.last_error};
    }
  }
  async reconcilePendingBuy(){
    const pending=this.state.pending_buy;
    if(!pending)return;
    try{
      const order=await this.client.getOrder({symbol:pending.symbol,origClientOrderId:pending.client_order_id});
      if(['FILLED','PARTIALLY_FILLED'].includes(String(order?.status||''))){
        const filters=await this.client.symbolFilters(pending.symbol);
        await this.acceptFilledBuy({symbol:pending.symbol},order,pending,filters);
      }else if(['REJECTED','EXPIRED','CANCELED'].includes(String(order?.status||''))){
        this.state.pending_buy=null;this.state.last_event='BUY_ORDER_NOT_FILLED';this.state.last_error=null;await this.persist();
      }else{
        this.state.pending_buy={...pending,status:'ORDER_STILL_OPEN_OR_UNKNOWN'};
        this.state.last_event='BUY_ORDER_STILL_PENDING';await this.persist();
      }
    }catch(error){
      // Unknown order is deliberately not retried: a lost HTTP response must never create a duplicate buy.
      this.state.pending_buy={...pending,status:'MANUAL_OR_EXCHANGE_RECONCILIATION_REQUIRED'};
      this.state.last_error=cleanText(error?.message||'BUY_ORDER_STATUS_UNKNOWN');
      this.state.last_event='BUY_ORDER_STATUS_UNKNOWN';await this.persist();
    }
  }
  async reconcilePosition(){
    const position=this.state.open_position;
    if(!position)return;
    try{
      const oco=await this.client.getOrderList({origClientOrderId:position.oco_client_order_id});
      const status=String(oco?.listOrderStatus||'');
      position.oco_status=status||String(oco?.listStatusType||'UNKNOWN');
      if(status!=='ALL_DONE'){
        await this.persist();return;
      }
      const orderIds=(Array.isArray(oco.orders)?oco.orders:[]).map(row=>row?.orderId).filter(Boolean);
      const orders=[];
      for(const orderId of orderIds){
        try{orders.push(await this.client.getOrderById({symbol:position.symbol,orderId}));}catch{}
      }
      const exit=orders.find(row=>row?.side==='SELL'&&row?.status==='FILLED');
      if(exit){
        const proceeds=FINITE(exit.cummulativeQuoteQty)||0;
        const entryCost=Number(position.entry_quote_usdt)||0;
        const feesEstimate=(entryCost+proceeds)*FEE_ESTIMATE_RATE;
        const pnl=proceeds-entryCost-feesEstimate;
        this.state.daily_realized_pnl_usdt=Number((Number(this.state.daily_realized_pnl_usdt||0)+pnl).toFixed(4));
        this.state.trade_history.unshift({id:position.oco_client_order_id,symbol:position.symbol,side:'SELL',
          status:'FILLED',order_id:exit.orderId,quote_usdt:proceeds,realized_pnl_usdt:Number(pnl.toFixed(4)),
          net_return_pct:entryCost>0?Number((pnl/entryCost*100).toFixed(3)):null,
          outcome:pnl>0?'UP':'DOWN',entry_score:FINITE(position.entry_score),
          entry_features:{...(position.entry_features||{})},
          at:this.clock(),exit_source:'EXCHANGE_OCO',real_order_execution:this.config.network==='LIVE'});
        this.state.trade_history=this.state.trade_history.slice(0,500);
        this.state.open_position=null;this.state.last_event='OCO_EXIT_RECONCILED';this.state.last_error=null;
        if(this.state.daily_realized_pnl_usdt<=-Math.abs(this.config.daily_loss_limit_usdt)){
          this.state.halted=true;this.state.halt_reason='DAILY_LOSS_LIMIT';
        }
        await this.persist();return;
      }
      // If the OCO completed without a filled exit, never assume the acquired asset was sold.
      position.protection_status='FAILED';
      this.state.halted=true;this.state.halt_reason='POSITION_REQUIRES_MANUAL_RECONCILIATION';
      this.state.last_event='OCO_CLOSED_WITHOUT_CONFIRMED_SELL';
      this.state.last_error='POSITION_REQUIRES_MANUAL_RECONCILIATION';
      await this.persist();
    }catch(error){
      position.oco_status='RECONCILIATION_RETRY';
      this.state.last_error=cleanText(error?.message||'OCO_RECONCILIATION_FAILED');
      await this.persist();
    }
  }
}
export const ADAPTIVE_TRADER_EXECUTION_POLICY=Object.freeze({
  liveConfirmation:LIVE_CONFIRMATION,minOrderUsdt:MIN_ORDER_USDT,maxOrderUsdt:MAX_ORDER_USDT,
  minDailyLossUsdt:MIN_DAILY_LOSS_USDT,maxDailyLossUsdt:MAX_DAILY_LOSS_USDT,
  minLiveOutcomes:MIN_LIVE_OUTCOMES,maxOpenPositions:MAX_OPEN_POSITIONS,
  maxTradesPerUtcDay:MAX_TRADES_PER_UTC_DAY,stopLossPct:DEFAULT_STOP_LOSS_PCT,
  takeProfitPct:DEFAULT_TAKE_PROFIT_PCT,feeEstimateRate:FEE_ESTIMATE_RATE
});
