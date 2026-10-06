import {buildSpotUniverse,normalizeTickerRow} from '../market/universe-scanner.mjs';
import {decorateRadarAlert} from './radar-alert-meta.mjs';

const clamp=(x,lo=0,hi=100)=>Math.max(lo,Math.min(hi,Number(x)));
const finite=(v,d=null)=>Number.isFinite(Number(v))?Number(v):d;

function closedCandles(rows,now){
  return (Array.isArray(rows)?rows:[]).filter(c=>
    c?.closed!==false &&
    Number.isFinite(Number(c?.openTime)) &&
    Number.isFinite(Number(c?.closeTime)) &&
    Number(c.closeTime)<=now &&
    Number(c.open)>0 && Number(c.high)>=Number(c.low) && Number(c.low)>0 &&
    Number(c.close)>0
  ).sort((a,b)=>Number(a.openTime)-Number(b.openTime));
}

function ema(values,period=50){
  const xs=values.map(Number).filter(Number.isFinite);
  if(!xs.length)return null;
  const p=Math.max(2,Math.trunc(period));
  const seed=xs.slice(0,Math.min(p,xs.length)).reduce((s,x)=>s+x,0)/Math.min(p,xs.length);
  let out=seed;
  const alpha=2/(p+1);
  for(const v of xs.slice(Math.min(p,xs.length)))out=alpha*v+(1-alpha)*out;
  return out;
}

function emaPrev(values,period=50){
  if(values.length<3)return null;
  return ema(values.slice(0,-1),period);
}

function pivots(candles,left=2,right=2){
  const highs=[],lows=[];
  for(let i=left;i<candles.length-right;i++){
    const h=Number(candles[i].high),l=Number(candles[i].low);
    if(!Number.isFinite(h)||!Number.isFinite(l))continue;
    let ph=true,pl=true;
    for(let j=1;j<=left;j++){ph&&=h>=Number(candles[i-j].high);pl&&=l<=Number(candles[i-j].low);}
    for(let j=1;j<=right;j++){ph&&=h>=Number(candles[i+j].high);pl&&=l<=Number(candles[i+j].low);}
    if(ph)highs.push({index:i,price:h});
    if(pl)lows.push({index:i,price:l});
  }
  return {highs,lows};
}

function structureDirection(candles){
  const {highs,lows}=pivots(candles,2,2);
  const hs=highs.slice(-4),ls=lows.slice(-4);
  if(hs.length<2||ls.length<2)return {direction:'NEUTRAL',score:50,highs:hs,lows:ls,hh:false,hl:false,lh:false,ll:false};
  const hh=hs.at(-1).price>hs.at(-2).price;
  const hl=ls.at(-1).price>ls.at(-2).price;
  const lh=hs.at(-1).price<hs.at(-2).price;
  const ll=ls.at(-1).price<ls.at(-2).price;
  if(hh&&hl)return {direction:'UP',score:94,highs:hs,lows:ls,hh,hl,lh,ll};
  if(lh&&ll)return {direction:'DOWN',score:94,highs:hs,lows:ls,hh,hl,lh,ll};
  if(hh||hl)return {direction:'UP_BIAS',score:68,highs:hs,lows:ls,hh,hl,lh,ll};
  if(lh||ll)return {direction:'DOWN_BIAS',score:68,highs:hs,lows:ls,hh,hl,lh,ll};
  return {direction:'NEUTRAL',score:50,highs:hs,lows:ls,hh,hl,lh,ll};
}

function trendlineScore(candles,direction){
  const {highs,lows}=pivots(candles,2,2);
  const source=direction.startsWith('UP')?lows:highs;
  const pts=source.slice(-3);
  if(pts.length<2)return {score:50,slopePctPerBar:null};
  const a=pts.at(-2),b=pts.at(-1);
  const delta=b.price-a.price;
  const slopePctPerBar=a.price>0?delta/a.price*100/Math.max(1,b.index-a.index):0;
  const aligned=direction.startsWith('UP')?delta>0:delta<0;
  return {score:aligned?Math.min(100,78+Math.abs(slopePctPerBar)*180):32,slopePctPerBar};
}

function timeframeAnalysis(candles,maPeriod=50,now=Date.now()){
  const rows=closedCandles(candles,now);
  if(rows.length<Math.max(30,maPeriod+5))return {direction:'INSUFFICIENT',score:null,structure:null};
  const closes=rows.map(c=>Number(c.close));
  const current=closes.at(-1);
  const ma=ema(closes,maPeriod),prevMa=emaPrev(closes,maPeriod);
  const structure=structureDirection(rows.slice(-Math.min(rows.length,96)));
  const line=trendlineScore(rows.slice(-Math.min(rows.length,96)),structure.direction);
  const maUp=Number.isFinite(ma)&&Number.isFinite(prevMa)&&ma>prevMa;
  const maDown=Number.isFinite(ma)&&Number.isFinite(prevMa)&&ma<prevMa;
  const maDirection=current>ma?(maUp?'UP':'UP_BIAS'):current<ma?(maDown?'DOWN':'DOWN_BIAS'):'NEUTRAL';
  const structureMajor=structure.direction==='UP'?'UP':structure.direction==='DOWN'?'DOWN':'NEUTRAL';
  const parts=[];
  if(structureMajor==='UP')parts.push('MARKET_STRUCTURE_UP');
  if(structureMajor==='DOWN')parts.push('MARKET_STRUCTURE_DOWN');
  if(line.score>=70)parts.push('TRENDLINE_ALIGNED');
  if(maDirection.startsWith('UP'))parts.push('PRICE_ABOVE_MA');
  if(maDirection.startsWith('DOWN'))parts.push('PRICE_BELOW_MA');
  const direction=structureMajor!=='NEUTRAL'?structureMajor:(maDirection.startsWith('UP')?'UP':maDirection.startsWith('DOWN')?'DOWN':'NEUTRAL');
  const directionScore=direction==='UP'
    ?(structureMajor==='UP'?42:25)+(maDirection.startsWith('UP')?33:18)+(line.score>=70?25:10)
    :(direction==='DOWN'
      ?(structureMajor==='DOWN'?42:25)+(maDirection.startsWith('DOWN')?33:18)+(line.score>=70?25:10)
      :50);
  return {
    direction,score:clamp(directionScore),
    structure:{...structure,direction:structureMajor},
    trendline:line,
    moving_average:{period:maPeriod,value:ma,previous:prevMa,price_vs_ma_pct:Number.isFinite(ma)?(current-ma)/ma*100:null,direction:maDirection},
    confirmations:parts,
    latest_close:current,
    candle_count:rows.length
  };
}

export function buildAlMuqawimAnalysis(series,ticker,now=Date.now(),config={}){
  const maPeriod=Math.max(10,Math.trunc(Number(config.maPeriod)||50));
  const m15=timeframeAnalysis(series?.['15m']||[],maPeriod,now);
  const h1=timeframeAnalysis(series?.['1h']||[],maPeriod,now);
  const h4=timeframeAnalysis(series?.['4h']||[],maPeriod,now);
  const tfs=[h4,h1,m15];
  if(tfs.some(x=>x.direction==='INSUFFICIENT')){
    return {eligible:false,stage:'INSUFFICIENT_DATA',direction:'NONE',score:null,closed_candles_only:true,timeframes:{'4h':h4,'1h':h1,'15m':m15}};
  }
  const up=tfs.filter(x=>x.direction==='UP').length;
  const down=tfs.filter(x=>x.direction==='DOWN').length;
  const mixed=up>0&&down>0;
  const major=up>=2?'UP':down>=2?'DOWN':mixed?'CONFLICT':'NEUTRAL';
  const htfAligned=(h4.direction===h1.direction&&['UP','DOWN'].includes(h4.direction))?100:50;
  const lowerAgreement=(m15.direction===major)?100:(m15.direction==='NEUTRAL'?55:25);
  const structureAgreement=tfs.reduce((s,x)=>s+(x.structure?.direction===major?1:0),0);
  const structureScore=structureAgreement>=2?94:structureAgreement===1?66:40;
  const trendlineAgreement=tfs.reduce((s,x)=>s+(x.trendline?.score>=70?1:0),0);
  const trendlineScore=clamp(50+trendlineAgreement*16+(h4.trendline?.score>=80?8:0));
  const maAgreement=tfs.reduce((s,x)=>s+((major==='UP'&&x.moving_average?.direction?.startsWith('UP'))||(major==='DOWN'&&x.moving_average?.direction?.startsWith('DOWN'))?1:0),0);
  const maScore=clamp(40+maAgreement*20+(h4.moving_average?.direction===major?10:0));
  const score=clamp(
    structureScore*.30+
    htfAligned*.25+
    lowerAgreement*.15+
    trendlineScore*.15+
    maScore*.15
  );
  const entryRisk=major==='UP'
    ?(m15.direction==='DOWN'?'AGAINST_HTF_TREND':'ALIGNED')
    :(major==='DOWN'
      ?(m15.direction==='UP'?'AGAINST_HTF_TREND':'ALIGNED')
      :'UNCLEAR');
  const stage=score>=88&&htfAligned>=100&&structureScore>=90&&lowerAgreement>=90
    ?'STRONG_TREND'
    :score>=76&&major!=='CONFLICT'
      ?'TREND_CONFIRMED'
      :major==='CONFLICT'
        ?'CONFLICT'
        :'WATCH';
  const reasons=[
    major==='UP'?'HH + HL structure':
    major==='DOWN'?'LH + LL structure':'mixed market structure',
    htfAligned===100?'4H + 1H aligned':'higher timeframes not aligned',
    trendlineScore>=70?'trendline aligned':'trendline weak',
    maScore>=70?'price/MA aligned':'moving-average mixed',
    lowerAgreement>=90?'15m agrees with major direction':'15m conflicts or is neutral'
  ];
  return {
    eligible:score>=82&&major!=='CONFLICT'&&htfAligned===100&&structureScore>=90&&lowerAgreement>=90,
    closed_candles_only:true,
    direction:major,
    stage,
    score:Number(score.toFixed(1)),
    entry_risk:entryRisk,
    timeframes:{'4h':h4,'1h':h1,'15m':m15},
    components:{market_structure:structureScore,higher_timeframe_alignment:htfAligned,lower_timeframe_agreement:lowerAgreement,trendline:trendlineScore,moving_average:maScore},
    trigger:{min_score:82,required_htf_alignment:'4h+1h',required_structure:'HH+HL or LH+LL',ma_period:maPeriod,closed_candles_only:true},
    reasons,
    source:'Binance Public REST',
    detected_at:now,
    processed_at:now,
    paper_trading:true,
    real_order_execution:false,
    confidence_score:'UNKNOWN',
    latest_price:finite(ticker?.lastPrice)
  };
}

export function buildAlMuqawimAlert(ticker,series,now,config={}){
  const analysis=buildAlMuqawimAnalysis(series,ticker,now,config);
  const symbol=String(ticker?.symbol||'UNKNOWN').toUpperCase();
  return {
    id:'ALMUQAWIM:'+symbol+':'+analysis.direction+':'+now,
    event:'ALMUQAWIM_TREND_ALERT',
    radar:'ALMUQAWIM_RADAR',
    symbol,market:'SPOT',direction:analysis.direction,
    price:finite(ticker?.lastPrice),
    price_change_24h:finite(ticker?.priceChange24h),
    opportunity_score:analysis.score,
    potential_label:analysis.stage,
    almuqawim:analysis,
    reasons:analysis.reasons,
    risk_flags:analysis.entry_risk==='AGAINST_HTF_TREND'?['AGAINST_HIGHER_TIMEFRAME']:[],
    eligible:analysis.eligible,
    source:'Binance Public REST',
    detected_at:now,processed_at:now,
    paper_trading:true,real_order_execution:false,confidence_score:'UNKNOWN',
    disclaimer:'المقاوم لا يتنبأ بالسعر؛ يحدد اتجاه السوق من هيكل القمم والقيعان، خط الاتجاه، المتوسط المتحرك وتوافق الإطار الزمني الكبير.'
  };
}

const STABLE_BASES=new Set(['USDC','BUSD','FDUSD','TUSD','USDP','DAI','USDE','USD1']);

export class AlMuqawimRadar{
  constructor({rest,store,pushManager=null,config={},clock=()=>Date.now(),logger=console}={}){
    if(!rest)throw new Error('REST_CLIENT_REQUIRED');
    if(!store)throw new Error('STORE_REQUIRED');
    this.rest=rest;this.store=store;this.pushManager=pushManager;this.clock=clock;this.logger=logger;
    this.config={quote:'USDT',pollMs:60000,universeRefreshMs:5*60*1000,minQuoteVolume24h:750000,batchSize:5,alertCooldownMs:20*60*1000,minScore:82,maPeriod:50,...config};
    this.running=false;this.timer=null;this.universe=[];this.universeAt=0;this.cursor=0;this.lastAlertAt=new Map();this.alertCount=0;this.scans=0;this.lastError=null;this.lastScanAtMs=null;this.busy=false;
  }
  start(){
    if(this.running)return;
    this.running=true;
    this.refreshUniverse().then(()=>this.tick()).catch(e=>this.noteError(e));
    this.timer=setInterval(()=>this.tick().catch(e=>this.noteError(e)),this.config.pollMs);
  }
  async stop(){this.running=false;if(this.timer)clearInterval(this.timer);this.timer=null;}
  noteError(e){this.lastError=String(e?.message??e);this.logger.warn?.('ALMUQAWIM',this.lastError);}
  async refreshUniverse(){
    const r=await this.rest.request('/api/v3/exchangeInfo');
    const symbols=buildSpotUniverse(r.data,this.config.quote);
    this.universe=symbols.map(x=>x.symbol).filter(s=>{const base=s.endsWith(this.config.quote)?s.slice(0,-this.config.quote.length):s;return !STABLE_BASES.has(base);});
    this.universeAt=this.clock();this.cursor=0;
  }
  async tickerRows(){
    const r=await this.rest.request('/api/v3/ticker/24hr');
    return (Array.isArray(r.data)?r.data:[]).map(x=>normalizeTickerRow(x,this.config.quote)).filter(Boolean)
      .filter(x=>this.universe.includes(x.symbol))
      .filter(x=>x.quoteVolume24h>=this.config.minQuoteVolume24h);
  }
  selectBatch(rows){
    if(!rows.length)return[];
    const ranked=[...rows].sort((a,b)=>{
      const sa=Math.abs(a.priceChange24h)*3+Math.log10(Math.max(1,a.quoteVolume24h))*4;
      const sb=Math.abs(b.priceChange24h)*3+Math.log10(Math.max(1,b.quoteVolume24h))*4;
      return sb-sa||b.quoteVolume24h-a.quoteVolume24h;
    });
    const selected=ranked.slice(0,Math.min(3,ranked.length));
    for(let i=0;i<this.config.batchSize&&this.universe.length;i++){
      const symbol=this.universe[this.cursor%this.universe.length];this.cursor=(this.cursor+1)%this.universe.length;
      const row=rows.find(x=>x.symbol===symbol);if(row)selected.push(row);
    }
    return [...new Map(selected.map(x=>[x.symbol,x])).values()];
  }
  async scanRow(row){
    const [r4,r1,r15]=await Promise.all([
      this.rest.klines(row.symbol,'4h',{limit:100}),
      this.rest.klines(row.symbol,'1h',{limit:120}),
      this.rest.klines(row.symbol,'15m',{limit:160})
    ]);
    const alert=buildAlMuqawimAlert(row,{ '4h':r4.candles,'1h':r1.candles,'15m':r15.candles },this.clock(),this.config);
    this.scans++;
    if(!alert.eligible||Number(alert.opportunity_score)<this.config.minScore)return alert;
    const last=this.lastAlertAt.get(row.symbol)||0;
    if(this.clock()-last<this.config.alertCooldownMs)return alert;
    this.lastAlertAt.set(row.symbol,this.clock());
    const decorated=decorateRadarAlert(alert,'Radar 7 — المقاوم');
    await this.store.appendAlMuqawimAlert(decorated);
    if(this.pushManager?.notifyRadarAlert)await this.pushManager.notifyRadarAlert(decorated);
    this.alertCount++;
    return alert;
  }
  async tick(){
    if(!this.running||this.busy)return;
    this.busy=true;
    try{
      if(this.clock()-this.universeAt>this.config.universeRefreshMs)await this.refreshUniverse();
      const rows=await this.tickerRows();
      this.lastScanAtMs=this.clock();
      for(const row of this.selectBatch(rows)){
        if(!this.running)break;
        try{await this.scanRow(row);}catch(e){this.noteError(e);}
      }
    }finally{this.busy=false;}
  }
  health(){
    return {running:this.running,radar:'ALMUQAWIM_RADAR',universe:this.universe.length,last_universe_refresh_at:this.universeAt||null,last_scan_at:this.lastScanAtMs,scans:this.scans,alerts_emitted:this.alertCount,last_error:this.lastError,busy:this.busy,
      rest:this.rest?.health?.()||null,
      algorithms:['MARKET_STRUCTURE_HH_HL_LH_LL','TRENDLINE_DIRECTION','MOVING_AVERAGE_FILTER','HIGHER_TIMEFRAME_ALIGNMENT','LOWER_TIMEFRAME_RISK_GUARD'],
      source:'Binance Public REST',closed_candles_only:true,paper_trading:true,real_order_execution:false,confidence_score:'UNKNOWN'};
  }
}
