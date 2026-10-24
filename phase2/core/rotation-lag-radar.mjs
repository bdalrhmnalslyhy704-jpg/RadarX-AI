import {buildSpotUniverse,normalizeTickerRow} from '../market/universe-scanner.mjs';
import {decorateRadarAlert} from './radar-alert-meta.mjs';
import {evaluateEliteGate} from './elite-confluence-gate.mjs';
import {evaluateRadarNotificationGate,rememberRadarAlert} from './radar-notification-gate.mjs';

const clamp=(x,lo=0,hi=100)=>Math.max(lo,Math.min(hi,Number(x)));
const finite=(v,d=null)=>Number.isFinite(Number(v))?Number(v):d;
const mean=xs=>{const a=xs.filter(Number.isFinite);return a.length?a.reduce((s,x)=>s+x,0)/a.length:null};
const pct=(a,b)=>Number.isFinite(a)&&Number.isFinite(b)&&b>0?(a-b)/b*100:null;
const sign=v=>Number.isFinite(v)?(v>0?1:v<0?-1:0):0;

async function mapLimit(items,limit,worker){
  const rows=Array.from(items||[]),out=Array(rows.length);let next=0;
  const concurrency=Math.max(1,Math.min(rows.length,Math.trunc(Number(limit)||1)));
  await Promise.all(Array.from({length:concurrency},async()=>{
    while(true){const index=next++;if(index>=rows.length)return;out[index]=await worker(rows[index],index);}
  }));
  return out;
}

function closedCandles(rows,now){
  return (Array.isArray(rows)?rows:[]).filter(c=>
    c?.closed!==false&&Number.isFinite(Number(c?.openTime))&&Number.isFinite(Number(c?.closeTime))&&
    Number(c.closeTime)<=now&&Number(c.open)>0&&Number(c.high)>=Number(c.low)&&Number(c.low)>0&&
    Number(c.close)>0&&Number(c.volume)>=0
  ).sort((a,b)=>Number(a.openTime)-Number(b.openTime));
}

function candleWindowIssue(rows, now, intervalMs, required, label) {
  if (rows.length < required) return null; // Preserve the existing insufficient-data result.
  const tail = rows.slice(-required);
  const latestClose = Number(tail.at(-1)?.closeTime);
  if (!Number.isFinite(latestClose) || latestClose > now ||
      now - latestClose > intervalMs * 2 + 10_000) {
    return {stage:'DATA_STALE', reason:label + '_STALE_CLOSED_CANDLES'};
  }
  for (let i = 1; i < tail.length; i++) {
    const delta = Number(tail[i].openTime) - Number(tail[i - 1].openTime);
    if (!Number.isFinite(delta) || Math.abs(delta - intervalMs) > 1000) {
      return {stage:'DATA_GAP', reason:label + '_CLOSED_CANDLE_GAP'};
    }
  }
  return null;
}

function invalidWindowResult(issue, counts) {
  return {eligible:false,watch_eligible:false,watch_blockers:[issue.reason],stage:issue.stage,score:null,activation_score:null,
    closed_candles_only:true,data_stale:issue.stage==='DATA_STALE',data_quality:0,data_quality_reasons:[issue.reason],counts};
}
function liquidityQualityFor(quoteVolume,minQuoteVolume=750000){
  const volume=quoteVolume===null||quoteVolume===undefined?null:Number(quoteVolume);
  if(!Number.isFinite(volume)||volume<=0)return 0;
  return clamp(70+Math.log10(Math.max(1,volume/Math.max(1,Number(minQuoteVolume)||750000)))*30);
}

function rollingVwap(candles,n){
  const rows=candles.slice(-n);
  let den=0,num=0;
  for(const c of rows){
    const v=Math.max(0,Number(c.volume)||0);
    const tp=(Number(c.high)+Number(c.low)+Number(c.close))/3;
    den+=v;num+=tp*v;
  }
  return den>0?num/den:null;
}

function rsi(values,period=14){
  const xs=values.map(Number).filter(Number.isFinite);
  if(xs.length<period+2)return null;
  let gain=0,loss=0;
  for(let i=1;i<=period;i++){const d=xs[i]-xs[i-1];if(d>=0)gain+=d;else loss-=d;}
  let ag=gain/period,al=loss/period;
  const out=[al===0?100:100-(100/(1+ag/al))];
  for(let i=period+1;i<xs.length;i++){
    const d=xs[i]-xs[i-1],g=Math.max(0,d),l=Math.max(0,-d);
    ag=(ag*(period-1)+g)/period;al=(al*(period-1)+l)/period;
    out.push(al===0?100:100-(100/(1+ag/al)));
  }
  return out.at(-1);
}

function moneyFlowIndex(candles,period=14){
  if(candles.length<period+1)return null;
  const rows=candles.slice(-(period+1));
  const tp=rows.map(c=>(Number(c.high)+Number(c.low)+Number(c.close))/3);
  let pos=0,neg=0;
  for(let i=1;i<tp.length;i++){
    const flow=tp[i]*Math.max(0,Number(rows[i].volume)||0);
    if(tp[i]>tp[i-1])pos+=flow;else if(tp[i]<tp[i-1])neg+=flow;
  }
  if(neg===0)return pos>0?100:50;
  return 100-(100/(1+pos/neg));
}

function stoch(candles,period=14){
  const rows=candles.slice(-period);
  if(rows.length<period)return null;
  const hi=Math.max(...rows.map(c=>Number(c.high)));
  const lo=Math.min(...rows.map(c=>Number(c.low)));
  if(!(hi>lo))return 50;
  return (Number(rows.at(-1).close)-lo)/(hi-lo)*100;
}

function avgRange(candles,n){
  const rows=candles.slice(-n);
  return mean(rows.map(c=>Number(c.high)-Number(c.low)));
}

function closeLocation(candles,n=20){
  const rows=candles.slice(-n);
  const hi=Math.max(...rows.map(c=>Number(c.high)));
  const lo=Math.min(...rows.map(c=>Number(c.low)));
  const last=Number(rows.at(-1)?.close);
  return hi>lo?clamp((last-lo)/(hi-lo)*100):50;
}

function persistence(candles,n=8){
  const rows=candles.slice(-(n+1)),changes=[];
  for(let i=1;i<rows.length;i++)changes.push(sign(Number(rows[i].close)-Number(rows[i-1].close)));
  const nonZero=changes.filter(Boolean);
  if(!nonZero.length)return 0.5;
  const pos=nonZero.filter(x=>x>0).length,neg=nonZero.length-pos;
  return Math.max(pos,neg)/nonZero.length;
}

function slope(values){
  const xs=values.filter(Number.isFinite);
  if(xs.length<4)return null;
  const n=xs.length,x=(n-1)/2;
  let num=0,den=0;
  for(let i=0;i<n;i++){num+=(i-x)*(xs[i]-mean(xs));den+=(i-x)**2;}
  return den>0?num/den:null;
}

function benchmarkReturn(series,n){
  const rows=closedCandles(series,Date.now());
  return rows.length>n?pct(Number(rows.at(-1).close),Number(rows.at(-(n+1)).close)):null;
}

function makeRelativeComponent(symbolRet,marketRet,dir){
  if(!Number.isFinite(symbolRet)||!Number.isFinite(marketRet))return 45;
  const spread=dir==='UP'?symbolRet-marketRet:marketRet-symbolRet;
  return clamp(50+spread*32);
}

export function buildRotationAnalysis(fifteenMin,oneHour,benchmarks,ticker,now=Date.now()){
  const m15=closedCandles(fifteenMin,now),h1=closedCandles(oneHour,now);
  const btc15=closedCandles(benchmarks?.BTCUSDT?.fifteen_min,now);
  const eth15=closedCandles(benchmarks?.ETHUSDT?.fifteen_min,now);
  const btc1h=closedCandles(benchmarks?.BTCUSDT?.one_hour,now);
  const eth1h=closedCandles(benchmarks?.ETHUSDT?.one_hour,now);

  const counts={fifteen_min:m15.length,one_hour:h1.length,btc15:btc15.length,eth15:eth15.length,btc1h:btc1h.length,eth1h:eth1h.length};
  if(m15.length<60||h1.length<30||btc15.length<12||eth15.length<12||btc1h.length<2||eth1h.length<2){
    return {eligible:false,watch_eligible:false,stage:'INSUFFICIENT_DATA',score:null,data_quality:0,data_quality_reasons:['INSUFFICIENT_CLOSED_CANDLES'],watch_blockers:['INSUFFICIENT_CLOSED_CANDLES'],closed_candles_only:true,counts};
  }

  const windows=[
    [m15,now,15*60_000,60,'SYMBOL_15M'],
    [h1,now,60*60_000,30,'SYMBOL_1H'],
    [btc15,now,15*60_000,12,'BTC_15M'],[eth15,now,15*60_000,12,'ETH_15M'],
    [btc1h,now,60*60_000,2,'BTC_1H'],[eth1h,now,60*60_000,2,'ETH_1H']
  ];
  for(const [rows,clock,interval,required,label] of windows){
    const issue=candleWindowIssue(rows,clock,interval,required,label);
    if(issue)return invalidWindowResult(issue,counts);
  }

  const close15=m15.map(c=>Number(c.close));
  const r15=pct(close15.at(-1),close15.at(-2));
  const r30=pct(close15.at(-1),close15.at(-3));
  const r60=pct(close15.at(-1),close15.at(-5));
  const r2h=pct(close15.at(-1),close15.at(-9));
  const hr=pct(Number(h1.at(-1).close),Number(h1.at(-3).close));

  const br15=[pct(Number(btc15.at(-1).close),Number(btc15.at(-2).close)),pct(Number(eth15.at(-1).close),Number(eth15.at(-2).close))].filter(Number.isFinite);
  const br30=[pct(Number(btc15.at(-1).close),Number(btc15.at(-3).close)),pct(Number(eth15.at(-1).close),Number(eth15.at(-3).close))].filter(Number.isFinite);
  const br60=[pct(Number(btc15.at(-1).close),Number(btc15.at(-5).close)),pct(Number(eth15.at(-1).close),Number(eth15.at(-5).close))].filter(Number.isFinite);
  const br2h=[pct(Number(btc15.at(-1).close),Number(btc15.at(-9).close)),pct(Number(eth15.at(-1).close),Number(eth15.at(-9).close))].filter(Number.isFinite);
  const market15=mean(br15),market30=mean(br30),market60=mean(br60),market2h=mean(br2h);
  const marketHour=mean([
    pct(Number(btc1h.at(-1)?.close),Number(btc1h.at(-2)?.close)),
    pct(Number(eth1h.at(-1)?.close),Number(eth1h.at(-2)?.close))
  ].filter(Number.isFinite));

  const upBias=mean([market30,market60,market2h,marketHour].filter(x=>Number.isFinite(x)))??0;
  let direction=upBias>=0?'UP_ROTATION':'DOWN_ROTATION';

  const range6=avgRange(m15,6),range24=avgRange(m15,24);
  const rangeRatio=Number.isFinite(range6)&&Number.isFinite(range24)&&range24>0?range6/range24:null;

  const recentWindow=m15.slice(-3),baselineWindow=m15.slice(-27,-3);
  const recentVol=mean(recentWindow.map(c=>Number(c.volume))),baseVol=mean(baselineWindow.map(c=>Number(c.volume)));
  const volumeRatio=Number.isFinite(recentVol)&&Number.isFinite(baseVol)&&baseVol>0?recentVol/baseVol:null;
  const recentTrades=mean(recentWindow.map(c=>c?.tradeCount==null?NaN:Number(c.tradeCount)));
  const baselineTrades=mean(baselineWindow.map(c=>c?.tradeCount==null?NaN:Number(c.tradeCount)));
  const tradeRatio=Number.isFinite(recentTrades)&&Number.isFinite(baselineTrades)&&baselineTrades>0?recentTrades/baselineTrades:null;
  const takerShare=rows=>{const valid=(Array.isArray(rows)?rows:[]).filter(c=>Number.isFinite(Number(c?.takerBuyBaseVolume))&&Number.isFinite(Number(c?.volume))&&Number(c.volume)>0);
    if(!valid.length)return null;const total=valid.reduce((sum,c)=>sum+Number(c.volume),0);return total>0?valid.reduce((sum,c)=>sum+Number(c.takerBuyBaseVolume),0)/total:null;};
  const takerBuyRatio=takerShare(recentWindow),baselineTakerBuyRatio=takerShare(baselineWindow);
  const takerBuyDelta=Number.isFinite(takerBuyRatio)&&Number.isFinite(baselineTakerBuyRatio)?takerBuyRatio-baselineTakerBuyRatio:null;

  const vwap=rollingVwap(m15,40);
  const vwapDistance=Number.isFinite(vwap)&&vwap>0?(Number(m15.at(-1).close)-vwap)/vwap*100:null;
  const priorClose=Number(m15.at(-2)?.close);
  const vwapReclaim=Number.isFinite(vwapDistance)&&Number.isFinite(priorClose)
    ?(Number(m15.at(-1).close)>vwap&&priorClose<=vwap*1.002?96:clamp(50+vwapDistance*30)):50;

  const hi20=Math.max(...m15.slice(-21,-1).map(c=>Number(c.high)));
  const lo20=Math.min(...m15.slice(-21,-1).map(c=>Number(c.low)));
  const last=Number(m15.at(-1).close);
  const mid20=(hi20+lo20)/2;
  const valueAcceptance=hi20>lo20?clamp(50+(last-mid20)/(hi20-lo20)*90):50;
  const loc=closeLocation(m15,20),dayMoveRaw=ticker?.priceChange24h??ticker?.price_change_24h;
  const dayMove=dayMoveRaw==null?null:finite(dayMoveRaw,null);
  const candleCoverageQuality=Math.round(clamp(Math.min(m15.length/80,1)*25+Math.min(h1.length/30,1)*20+Math.min(btc15.length/12,1)*15+Math.min(eth15.length/12,1)*15+Math.min(btc1h.length/2,1)*12.5+Math.min(eth1h.length/2,1)*12.5));
  const ownUpturn=Number.isFinite(volumeRatio)&&volumeRatio>=1.12&&((Number.isFinite(r15)&&r15>=0.03)||(Number.isFinite(r30)&&r30>=0.06))&&Number.isFinite(r60)&&r60>=-0.10&&loc>=52&&(vwapDistance===null||vwapDistance>=-0.15)&&(dayMove===null||Math.abs(dayMove)<=8);
  if(ownUpturn)direction='UP_ROTATION';
  const rs30=direction==='UP_ROTATION'?r30-market30:market30-r30;
  const rs2h=direction==='UP_ROTATION'?r2h-market2h:market2h-r2h;
  const lagScore=clamp(50+(Number.isFinite(rs30)?rs30*34:0)+(Number.isFinite(rs2h)?rs2h*11:0));

  const silentDislocation=Number.isFinite(volumeRatio)
    ?clamp(52+(volumeRatio-1)*22-(Math.abs(Number(r30)||0)*9))
    :45;

  const rsiNow=rsi(close15,14);
  const mfiNow=moneyFlowIndex(m15,14);
  const rsiValues=[];
  const mfiValues=[];
  for(let i=Math.max(20,m15.length-8);i<m15.length;i++){
    const rr=rsi(m15.slice(0,i+1).map(c=>Number(c.close)),14);
    const mm=moneyFlowIndex(m15.slice(0,i+1),14);
    if(Number.isFinite(rr))rsiValues.push(rr);
    if(Number.isFinite(mm))mfiValues.push(mm);
  }
  const rsiSlope=slope(rsiValues);
  const mfiSlope=slope(mfiValues);
  const rsiTurn=Number.isFinite(rsiNow)?clamp(55+(rsiSlope||0)*9-(rsiNow>68?(rsiNow-68)*2:0)):45;
  const mfiTurn=Number.isFinite(mfiNow)?clamp(52+(mfiSlope||0)*7-(mfiNow>78?(mfiNow-78)*1.3:0)):45;

  const stochNow=stoch(m15,14);
  const stochPrev=stoch(m15.slice(0,-1),14);
  const stochTurn=Number.isFinite(stochNow)&&Number.isFinite(stochPrev)
    ?(direction==='UP_ROTATION'
      ?clamp(50+(stochNow-stochPrev)*2+(stochNow>=20&&stochNow<=65?18:0))
      :clamp(50+(stochPrev-stochNow)*2+(stochNow>=35&&stochNow<=80?18:0)))
    :45;

  const pathPersistence=persistence(m15,8);
  const persistenceScore=clamp(35+pathPersistence*80+(direction==='UP_ROTATION'&&loc>=65?8:direction==='DOWN'&&loc<=35?8:0));

  const compressionScore=Number.isFinite(rangeRatio)
    ?clamp(rangeRatio<=0.9?82+(0.9-rangeRatio)*80:68-(rangeRatio-0.9)*80)
    :45;

  const reclaimOrReject=direction==='UP_ROTATION'
    ?clamp(45+(loc-50)*0.9+(Number.isFinite(vwapDistance)&&vwapDistance>0?15:0))
    :clamp(45+(50-loc)*0.9+(Number.isFinite(vwapDistance)&&vwapDistance<0?15:0));

  const resilience=direction==='UP_ROTATION'
    ?makeRelativeComponent(r2h,market2h,'UP')
    :makeRelativeComponent(r2h,market2h,'DOWN');

  const activation=clamp(
    silentDislocation*.22+
    reclaimOrReject*.18+
    valueAcceptance*.18+
    (direction==='UP_ROTATION'?rsiTurn:mfiTurn)*.12+
    (direction==='UP_ROTATION'?mfiTurn:rsiTurn)*.10+
    stochTurn*.08+
    persistenceScore*.07+
    compressionScore*.05
  );

  const score=clamp(
    lagScore*.24+
    resilience*.13+
    silentDislocation*.16+
    reclaimOrReject*.12+
    valueAcceptance*.10+
    rsiTurn*.07+
    mfiTurn*.06+
    stochTurn*.04+
    persistenceScore*.04+
    compressionScore*.04
  );

  const confirmations=[];
  const push=(ok,label)=>{if(ok)confirmations.push(label)};
  if(direction==='UP_ROTATION'){
    push(Number.isFinite(market30)&&market30>=0.25,'MARKET_UPSHIFT');
    push(Number.isFinite(rs30)&&rs30>=0.25,'LAG_TO_MARKET');
    push(Number.isFinite(volumeRatio)&&volumeRatio>=1.25,'SILENT_VOLUME');
    push(vwapReclaim>=68,'VWAP_RECLAIM');
    push(valueAcceptance>=70,'VALUE_ACCEPTANCE');
    push(rsiTurn>=68,'RSI_TURN');
    push(mfiTurn>=66,'MFI_TURN');
    push(stochTurn>=68,'STOCHASTIC_TURN');
    push(resilience>=64,'MARKET_RESILIENCE');
    push(persistenceScore>=68,'PRICE_PERSISTENCE');
  }else{
    push(Number.isFinite(market30)&&market30<=-0.25,'MARKET_DOWNSHIFT');
    push(Number.isFinite(rs30)&&rs30>=0.25,'LAG_TO_MARKET');
    push(Number.isFinite(volumeRatio)&&volumeRatio>=1.25,'DISTRIBUTION_VOLUME');
    push(vwapReclaim<=38,'VWAP_REJECTION');
    push(valueAcceptance<=30,'VALUE_REJECTION');
    push(rsiTurn>=68,'RSI_FALL');
    push(mfiTurn>=66,'MFI_FALL');
    push(stochTurn>=68,'STOCHASTIC_FALL');
    push(resilience>=64,'MARKET_PRESSURE');
    push(persistenceScore>=68,'PRICE_PERSISTENCE');
  }

  const rotationTrigger=candleCoverageQuality>=85&&score>=78&&confirmations.length>=4&&((direction==='UP_ROTATION'&&Number.isFinite(market30)&&market30>=0.25&&Number.isFinite(rs30)&&rs30>=0.20&&activation>=64)||(direction==='DOWN_ROTATION'&&Number.isFinite(market30)&&market30<=-0.25&&Number.isFinite(rs30)&&rs30>=0.20&&activation>=64));
  const priceWindowOk=dayMove!==null&&Math.abs(dayMove)<=8&&Number.isFinite(r30)&&r30>=-0.15&&r30<=1.6&&Number.isFinite(r60)&&r60<=2.8&&Number.isFinite(r2h)&&r2h<=5.5;
  const flowOk=Number.isFinite(tradeRatio)&&tradeRatio>=1.05&&((Number.isFinite(takerBuyRatio)&&takerBuyRatio>=0.52)||(Number.isFinite(takerBuyDelta)&&takerBuyDelta>=0.01));
  const earlyChecks=[Number.isFinite(volumeRatio)&&volumeRatio>=1.12,Number.isFinite(tradeRatio)&&tradeRatio>=1.05,(Number.isFinite(takerBuyRatio)&&takerBuyRatio>=0.52)||(Number.isFinite(takerBuyDelta)&&takerBuyDelta>=0.01),loc>=52,vwapReclaim>=60,rsiTurn>=56||mfiTurn>=56,stochTurn>=55,valueAcceptance>=56,persistenceScore>=58,lagScore>=52||resilience>=55];
  const earlyEvidenceCount=earlyChecks.filter(Boolean).length;
  const watchEligible=candleCoverageQuality>=85&&direction==='UP_ROTATION'&&score>=72&&activation>=60&&confirmations.length>=3&&Number.isFinite(volumeRatio)&&volumeRatio>=1.12&&flowOk&&loc>=52&&(vwapReclaim>=60||(Number.isFinite(vwapDistance)&&vwapDistance>=-0.15))&&priceWindowOk&&earlyEvidenceCount>=5&&(lagScore>=50||resilience>=55);
  const watchBlockers=[];
  if(candleCoverageQuality<85)watchBlockers.push('CLOSED_CANDLE_COVERAGE_LOW');if(direction!=='UP_ROTATION')watchBlockers.push('UPWARD_ROTATION_NOT_CONFIRMED');
  if(score<72)watchBlockers.push('EARLY_SCORE_BELOW_72');if(activation<60)watchBlockers.push('EARLY_ACTIVATION_BELOW_60');if(confirmations.length<3)watchBlockers.push('EARLY_CONFIRMATIONS_BELOW_3');
  if(!Number.isFinite(volumeRatio)||volumeRatio<1.12)watchBlockers.push('VOLUME_ACCELERATION_NOT_CONFIRMED');if(!Number.isFinite(tradeRatio)||tradeRatio<1.05)watchBlockers.push('TRADE_ACCELERATION_NOT_CONFIRMED');
  if(!((Number.isFinite(takerBuyRatio)&&takerBuyRatio>=0.52)||(Number.isFinite(takerBuyDelta)&&takerBuyDelta>=0.01)))watchBlockers.push('BUY_FLOW_NOT_CONFIRMED');
  if(loc<52)watchBlockers.push('PRICE_ACCEPTANCE_NOT_CONFIRMED');if(!(vwapReclaim>=60||(Number.isFinite(vwapDistance)&&vwapDistance>=-0.15)))watchBlockers.push('VWAP_RECLAIM_NOT_CONFIRMED');
  if(!priceWindowOk)watchBlockers.push('ANTI_CHASE_PRICE_WINDOW_BLOCKED');if(earlyEvidenceCount<5)watchBlockers.push('EARLY_EVIDENCE_BREADTH_LOW');if(lagScore<50&&resilience<55)watchBlockers.push('RELATIVE_SUPPORT_NOT_CONFIRMED');
  const stage=rotationTrigger?(score>=90?'ROTATION_BREAKOUT_READY':'ROTATION_READY'):watchEligible?'WATCH_EARLY':score>=70?'BUILDING_ROTATION':'WATCH';

  const reasons=confirmations.slice(0,10).map(x=>x.replaceAll('_',' '));
  const marketRegime=upBias>=0.4?'RISK_ON_SHIFT':upBias<=-0.4?'RISK_OFF_SHIFT':'MIXED';

  return {
    eligible:rotationTrigger,watch_eligible:watchEligible,watch_blockers:watchEligible?[]:watchBlockers,
    closed_candles_only:true,data_quality:candleCoverageQuality,data_quality_reasons:[],stage,direction,score:Math.round(score*10)/10,
    activation_score:Math.round(activation*10)/10,
    confirmations:confirmations.length,
    market_regime:marketRegime,
    counts:{
      fifteen_min:m15.length,
      one_hour:h1.length,
      btc15:btc15.length,
      eth15:eth15.length
    },
    metrics:{
      return_15m:r15,return_30m:r30,return_60m:r60,return_2h:r2h,return_1h:hr,
      market_return_15m:market15,market_return_30m:market30,market_return_60m:market60,
      market_return_2h:market2h,market_return_1h:marketHour,relative_30m_pct:rs30,relative_2h_pct:rs2h,volume_ratio:volumeRatio,trade_ratio:tradeRatio,
      taker_buy_ratio:takerBuyRatio,baseline_taker_buy_ratio:baselineTakerBuyRatio,taker_buy_delta:takerBuyDelta,range_ratio:rangeRatio,vwap,vwap_distance_pct:vwapDistance,vwap_reclaim_score:vwapReclaim,
      close_location_pct:loc,value_acceptance_score:valueAcceptance,
      rsi:rsiNow,rsi_slope:rsiSlope,mfi:mfiNow,mfi_slope:mfiSlope,
      stochastic:stochNow,stochastic_delta:Number.isFinite(stochNow)&&Number.isFinite(stochPrev)?stochNow-stochPrev:null,
      path_persistence:pathPersistence,resilience_score:resilience
    },
    component_scores:{
      lag:lagScore,resilience,silent_volume:silentDislocation,reclaim_or_reject:reclaimOrReject,
      value_acceptance:valueAcceptance,rsi_turn:rsiTurn,mfi_turn:mfiTurn,
      stochastic_turn:stochTurn,persistence:persistenceScore,compression:compressionScore
    },
    trigger:{
      min_score:78,min_confirmations:4,min_market_shift_pct:0.25,min_relative_edge_pct:0.20,min_activation_score:64,watch_min_score:72,watch_min_activation_score:60,watch_min_confirmations:3,watch_min_volume_ratio:1.12,watch_min_trade_ratio:1.05
    },
    confirmations,watch_evidence_count:earlyEvidenceCount,
    reasons,
    source:'Binance Public REST',
    detected_at:now,
    processed_at:now,
    paper_trading:true,
    real_order_execution:false,
    confidence_score:'UNKNOWN'
  };
}

export function buildRotationAlert(candidate,now=Date.now()){
  const ticker=candidate.ticker||{},a=buildRotationAnalysis(candidate.fifteen_min,candidate.one_hour,candidate.benchmarks,ticker,now);
  const symbol=String(ticker.symbol||'UNKNOWN').toUpperCase(),qv=ticker.quoteVolume24h??ticker.quote_volume_24h;
  const quoteVolume=qv==null?null:finite(qv,null),liquidityQuality=liquidityQualityFor(quoteVolume,Number(candidate.minQuoteVolume24h)||750000);
  const dataQuality=finite(a.data_quality,0),last=closedCandles(candidate.fifteen_min,now).at(-1)||null,closeTime=last?finite(last.closeTime,null):null;
  const watchOnly=a.eligible!==true&&a.watch_eligible===true,vr=finite(a.metrics?.volume_ratio,0),tr=finite(a.metrics?.trade_ratio,0),taker=finite(a.metrics?.taker_buy_ratio,0.5);
  const components={data_quality:dataQuality,liquidity:liquidityQuality,momentum:Math.max(finite(a.component_scores?.rsi_turn,50),finite(a.component_scores?.mfi_turn,50),finite(a.component_scores?.stochastic_turn,50)),
    volume:clamp(50+(vr-1)*40),volume_ratio:vr,trades:clamp(50+(tr-1)*40),trade_ratio:tr,taker:clamp(50+(taker-0.5)*300),taker_buy_ratio:taker,
    range:finite(a.component_scores?.compression,50),compression:finite(a.component_scores?.compression,50),breakout:finite(a.component_scores?.value_acceptance,50),
    ema:finite(a.component_scores?.reclaim_or_reject,50),vwap:finite(a.metrics?.vwap_reclaim_score,50),efficiency:finite(a.component_scores?.persistence,50),
    relative_strength:Math.max(finite(a.component_scores?.lag,50),finite(a.component_scores?.resilience,50)),structure:finite(a.component_scores?.value_acceptance,50)};
  return {id:'ROTATION:'+symbol+':'+a.direction+':'+now,event:a.eligible?'ROTATION_LAG_ALERT':watchOnly?'ROTATION_WATCH_ONLY_EARLY_TRACK':'ROTATION_OBSERVATION',
    radar:'ROTATION_LAG_RADAR',symbol,market:'SPOT',direction:a.direction,price:finite(ticker.lastPrice),price_change_24h:finite(ticker.priceChange24h),
    quote_volume_24h:quoteVolume,opportunity_score:a.score,potential_label:watchOnly?'WATCH_EARLY_ROTATION':a.stage,rotation:{...a,data_quality:dataQuality,liquidity_quality:liquidityQuality},
    reasons:a.reasons,watch_reason_codes:a.watch_blockers||[],risk_flags:[Math.abs(finite(ticker.priceChange24h,0))>8?'24H_ALREADY_EXTENDED':null,Number.isFinite(a.metrics?.volume_ratio)&&a.metrics.volume_ratio<0.8?'LOW_ACTIVITY':null,Number.isFinite(a.metrics?.range_ratio)&&a.metrics.range_ratio>1.8?'VOLATILITY_ELEVATED':null].filter(Boolean),
    components,volume_ratio:vr,trade_ratio:tr,taker_buy_ratio:taker,source:a.source,source_time:closeTime,detected_candle_close_time:closeTime,candle:{closed:true,close_time:closeTime,closeTime},
    data_status:{source:'BINANCE_PUBLIC_REST',data_valid:dataQuality>=85,stale:false,data_stale:false,future_data_detected:false,candle_closed:Boolean(closeTime!==null&&closeTime<=now),close_time:closeTime,source_time:closeTime,data_quality:dataQuality},
    data_quality:dataQuality,liquidity_quality:liquidityQuality,closed_candles_only:true,detected_at:now,processed_at:now,paper_trading:true,real_order_execution:false,
    confidence_score:'UNKNOWN',eligible:a.eligible,entry_eligible:a.eligible,watch_only:watchOnly,
    disclaimer:'الجوكر يرصد دوران السيولة والانعطاف النسبي المبكر. حالات WATCH_EARLY للمراقبة فقط وليست إشارة دخول أو ضمانًا للارتفاع.'};
}

const STABLE_BASES=new Set(['USDC','BUSD','FDUSD','TUSD','USDP','DAI','USDE','USD1']);

export class RotationLagRadar {
  constructor({rest,store,pushManager=null,config={},clock=()=>Date.now(),logger=console}={}){
    if(!rest)throw new Error('REST_CLIENT_REQUIRED');
    if(!store)throw new Error('STORE_REQUIRED');
    this.rest=rest;this.store=store;this.pushManager=pushManager;this.clock=clock;this.logger=logger;
    this.config={
      quote:'USDT',pollMs:20000,universeRefreshMs:5*60*1000,minQuoteVolume24h:750000,rotationBatchSize:12,topLaggers:3,rotationConcurrency:4,maxAbs24hMovePct:8,alertCooldownMs:10*60*1000,minScore:78,minConfirmations:4,...config
    };
    this.running=false;this.timer=null;this.universe=[];this.universeAt=0;this.cursor=0;this.lastScanAt=new Map();this.lastAlertAt=new Map();
    this.alertCount=0;this.watchAlertCount=0;this.scans=0;this.cycles=0;this.lastError=null;this.lastScanAtMs=null;this.busy=false;this.busySinceAt=null;this.latestCandidates=new Map();
    this.lastDecisionDiagnostics={evaluated:0,core_eligible:0,elite_gate_rejected:0,notification_gate_checked:0,notification_gate_rejected:0,notification_gate_accepted:0,watch_candidates:0,watch_notifications:0,alerts_stored:0,notifications_sent:0,cooldown_blocked:0,row_errors:0,duration_ms:0};this.decisionRejectionCounts={};
  }

  start(){
    if(this.running)return Promise.resolve();
    this.running=true;
    const initial=Promise.resolve()
      .then(()=>this.refreshUniverse())
      .then(()=>this.tick())
      .catch(e=>{this.noteError(e);});
    this.timer=setInterval(()=>this.tick().catch(e=>this.noteError(e)),this.config.pollMs);
    return initial;
  }

  async stop(){this.running=false;if(this.timer)clearInterval(this.timer);this.timer=null;}

  noteError(e){this.lastError=String(e?.message??e);this.logger.warn?.('ROTATION_LAG',this.lastError);}

  async refreshUniverse(){
    const r=await this.rest.request('/api/v3/exchangeInfo');
    const symbols=buildSpotUniverse(r.data,this.config.quote);
    this.universe=symbols.map(x=>x.symbol).filter(s=>{
      const base=s.endsWith(this.config.quote)?s.slice(0,-this.config.quote.length):s;
      return !STABLE_BASES.has(base);
    });
    this.universeAt=this.clock();this.cursor=this.universe.length?this.cursor%this.universe.length:0;
  }

  async tickerRows(){
    const r=await this.rest.request('/api/v3/ticker/24hr');
    return (Array.isArray(r.data)?r.data:[])
      .map(x=>normalizeTickerRow(x,this.config.quote)).filter(Boolean)
      .filter(x=>this.universe.includes(x.symbol))
      .filter(x=>x.quoteVolume24h>=this.config.minQuoteVolume24h)
      .filter(x=>Math.abs(x.priceChange24h)<=this.config.maxAbs24hMovePct);
  }

  async benchmarkData(){
    const symbols=['BTCUSDT','ETHUSDT'].filter(x=>x.endsWith(this.config.quote));
    const pairs=await Promise.all(symbols.map(async symbol=>{
      const [f,h]=await Promise.all([
        this.rest.klines(symbol,'15m',{limit:120}),
        this.rest.klines(symbol,'1h',{limit:60})
      ]);
      return [symbol,{fifteen_min:f.candles,one_hour:h.candles}];
    }));
    return Object.fromEntries(pairs);
  }

  selectBatch(rows){
    if(!Array.isArray(rows)||!rows.length)return [];
    const active=[...new Map(rows.filter(x=>x?.symbol).map(x=>[String(x.symbol).toUpperCase(),x])).values()].sort((a,b)=>{
      const sa=Math.abs(Number(a.priceChange24h)||0)*4-Math.log10(Math.max(1,Number(a.quoteVolume24h)||1))*1.5;
      const sb=Math.abs(Number(b.priceChange24h)||0)*4-Math.log10(Math.max(1,Number(b.quoteVolume24h)||1))*1.5;return sa-sb||Number(b.quoteVolume24h||0)-Number(a.quoteVolume24h||0);
    });
    if(!active.length)return [];const selected=[],seen=new Set(),take=row=>{const id=String(row?.symbol||'').toUpperCase();if(id&&!seen.has(id)){selected.push(row);seen.add(id);}};
    const topCount=Math.min(active.length,Math.max(0,Math.trunc(Number(this.config.topLaggers)||0))),n=Math.max(0,Math.trunc(Number(this.config.rotationBatchSize)||0));
    for(const row of active.slice(0,topCount))take(row);const pool=active.slice(topCount),count=Math.min(n,pool.length),start=pool.length?((Math.trunc(Number(this.cursor)||0)%pool.length)+pool.length)%pool.length:0;
    for(let i=0;i<count;i++)take(pool[(start+i)%pool.length]);this.cursor=pool.length?(start+Math.max(1,count))%pool.length:0;return selected;
  }
  recordDecisionRejections(reasons=[]){for(const reason of Array.isArray(reasons)?reasons:[]){const key=String(reason||'UNKNOWN_REJECTION').slice(0,120);this.decisionRejectionCounts[key]=(this.decisionRejectionCounts[key]||0)+1;}}
  analysisRejectionReasons(alert,eliteGate=null){const a=alert?.rotation||{},reasons=[];
    if(Number(a.data_quality)<85)reasons.push(...(Array.isArray(a.data_quality_reasons)?a.data_quality_reasons:['DATA_QUALITY_NOT_VALID']));
    if(alert?.eligible!==true&&a.watch_eligible!==true)reasons.push(...(Array.isArray(a.watch_blockers)&&a.watch_blockers.length?a.watch_blockers:['ROTATION_TRIGGER_NOT_CONFIRMED']));
    if(alert?.eligible===true&&eliteGate?.eligible!==true)reasons.push(...(Array.isArray(eliteGate?.risk_flags)&&eliteGate.risk_flags.length?eliteGate.risk_flags:['ELITE_GATE_NOT_ELIGIBLE']));
    return [...new Set(reasons)];
  }

  async scanRow(row,benchmarks){
    const symbol=String(row?.symbol||'').toUpperCase(),last=this.lastScanAt.get(symbol)||0;
    if(this.clock()-last<Math.max(10000,this.config.pollMs*0.75)){this.lastDecisionDiagnostics.cooldown_blocked++;this.recordDecisionRejections(['SYMBOL_SCAN_COOLDOWN']);return null;}
    this.lastScanAt.set(symbol,this.clock());const [f,h]=await Promise.all([this.rest.klines(symbol,'15m',{limit:120}),this.rest.klines(symbol,'1h',{limit:60})]);
    const alert=buildRotationAlert({ticker:row,fifteen_min:f.candles,one_hour:h.candles,benchmarks,minQuoteVolume24h:this.config.minQuoteVolume24h},this.clock());
    this.scans++;this.lastDecisionDiagnostics.evaluated++;const a=alert.rotation||{},cs=a.component_scores||{};
    const eliteGate=evaluateEliteGate({radar:'ROTATION_LAG_RADAR',direction:a.direction,baseScore:a.score,priceChange24h:row.priceChange24h,liquidityScore:alert.liquidity_quality,
      dataQualityScore:alert.data_quality,triggerScore:a.activation_score||50,structureScore:Math.max(Number(cs.reclaim_or_reject)||0,Number(cs.value_acceptance)||0),
      participationScore:Number(cs.silent_volume)||50,flowScore:Math.max(Number(cs.mfi_turn)||0,Number(cs.rsi_turn)||0),relativeScore:Math.max(Number(cs.lag)||0,Number(cs.resilience)||0),
      momentumScore:Math.max(Number(cs.stochastic_turn)||0,Number(cs.persistence)||0),compressionScore:Number(cs.compression)||50,confirmations:a.confirmations,minConfirmations:6,minScore:86,max24hMovePct:5,requireTrigger:true,minCategoryHits:5});
    alert.elite_gate=eliteGate;const strictCandidate=alert.eligible===true&&a.score>=this.config.minScore&&a.confirmations>=this.config.minConfirmations&&eliteGate.eligible===true;
    if(strictCandidate)this.lastDecisionDiagnostics.core_eligible++;else if(alert.eligible===true&&!eliteGate.eligible)this.lastDecisionDiagnostics.elite_gate_rejected++;
    if(!strictCandidate&&!a.watch_eligible)this.recordDecisionRejections(this.analysisRejectionReasons(alert,eliteGate));
    const now=this.clock(),lastAlert=this.lastAlertAt.get(symbol)||0,onCooldown=now-lastAlert<this.config.alertCooldownMs;
    const saveAndNotify=async(candidate,{watchOnly=false,gate}={})=>{
      if(onCooldown){this.lastDecisionDiagnostics.cooldown_blocked++;this.recordDecisionRejections(['ALERT_COOLDOWN_ACTIVE']);return false;}
      candidate.notification_gate=gate;candidate.notification_gate_mode=gate.mode;candidate.entry_eligible=!watchOnly;candidate.watch_only=watchOnly;
      if(watchOnly){candidate.event='ROTATION_WATCH_ONLY_EARLY_TRACK';candidate.potential_label='WATCH_EARLY_ROTATION';}
      rememberRadarAlert(candidate,now);this.lastAlertAt.set(symbol,now);await this.store.appendRotationAlert(candidate);this.lastDecisionDiagnostics.alerts_stored++;
      if(watchOnly){this.watchAlertCount++;this.lastDecisionDiagnostics.watch_notifications++;}else this.alertCount++;
      if(this.pushManager?.notifyRadarAlert){const notifications=await this.pushManager.notifyRadarAlert(candidate);if(Array.isArray(notifications)&&notifications.some(x=>x?.status==='SENT'||x?.status==='SENT_OR_ATTEMPTED'))this.lastDecisionDiagnostics.notifications_sent++;}
      return true;
    };
    if(strictCandidate){const decorated=decorateRadarAlert(alert,'Radar 3 — الجوكر');this.lastDecisionDiagnostics.notification_gate_checked++;const gate=evaluateRadarNotificationGate(decorated,{now,commit:false});
      if(gate.eligible&&gate.watch_only!==true){this.lastDecisionDiagnostics.notification_gate_accepted++;await saveAndNotify(decorated,{watchOnly:false,gate});this.latestCandidates.set(symbol,decorated);return decorated;}
      this.lastDecisionDiagnostics.notification_gate_rejected++;this.recordDecisionRejections(gate.failures.length?gate.failures:['NOTIFICATION_GATE_REJECTED']);}
    if(a.watch_eligible===true){this.lastDecisionDiagnostics.watch_candidates++;const watchAlert={...alert};delete watchAlert.elite_gate;
      watchAlert.eligible=false;watchAlert.entry_eligible=false;watchAlert.watch_only=true;watchAlert.event='ROTATION_WATCH_ONLY_EARLY_TRACK';watchAlert.potential_label='WATCH_EARLY_ROTATION';
      const decorated=decorateRadarAlert(watchAlert,'Radar 3 — الجوكر');this.lastDecisionDiagnostics.notification_gate_checked++;const gate=evaluateRadarNotificationGate(decorated,{now,commit:false});
      if(gate.eligible&&gate.watch_only===true){this.lastDecisionDiagnostics.notification_gate_accepted++;await saveAndNotify(decorated,{watchOnly:true,gate});this.latestCandidates.set(symbol,decorated);return decorated;}
      this.lastDecisionDiagnostics.notification_gate_rejected++;this.recordDecisionRejections(gate.failures.length?gate.failures:['EARLY_WATCH_GATE_NOT_QUALIFIED']);watchAlert.notification_gate=gate;this.latestCandidates.set(symbol,watchAlert);return watchAlert;}
    this.latestCandidates.set(symbol,alert);while(this.latestCandidates.size>60)this.latestCandidates.delete(this.latestCandidates.keys().next().value);return alert;
  }

  async tick(){
    if(!this.running||this.busy)return false;this.busy=true;this.busySinceAt=this.clock();const startedAt=this.clock();
    this.lastDecisionDiagnostics={evaluated:0,core_eligible:0,elite_gate_rejected:0,notification_gate_checked:0,notification_gate_rejected:0,notification_gate_accepted:0,watch_candidates:0,watch_notifications:0,alerts_stored:0,notifications_sent:0,cooldown_blocked:0,row_errors:0,duration_ms:0};
    this.decisionRejectionCounts={};this.lastError=null;
    try{if(this.clock()-this.universeAt>this.config.universeRefreshMs)await this.refreshUniverse();const [rows,benchmarks]=await Promise.all([this.tickerRows(),this.benchmarkData()]),selected=this.selectBatch(rows);
      await mapLimit(selected,Math.max(1,Math.min(6,this.config.rotationConcurrency)),async row=>{if(!this.running)return null;try{return await this.scanRow(row,benchmarks);}catch(e){this.lastDecisionDiagnostics.row_errors++;this.noteError(e);this.recordDecisionRejections(['SYMBOL_SCAN_FAILED']);return null;}});
      this.cycles++;this.lastScanAtMs=this.clock();this.lastDecisionDiagnostics.duration_ms=Math.max(0,this.lastScanAtMs-startedAt);return true;
    }catch(e){this.lastScanAtMs=this.clock();this.lastDecisionDiagnostics.duration_ms=Math.max(0,this.lastScanAtMs-startedAt);this.noteError(e);this.recordDecisionRejections(['RADAR_CYCLE_FAILED']);return false;}
    finally{this.busy=false;this.busySinceAt=null;}
  }

  snapshot(limit=20){const safeLimit=Math.max(1,Math.min(50,Math.trunc(Number(limit)||20)));return [...this.latestCandidates.values()].sort((a,b)=>Number(b.opportunity_score||b.rotation?.score||0)-Number(a.opportunity_score||a.rotation?.score||0)||Number(b.processed_at||b.detected_at||0)-Number(a.processed_at||a.detected_at||0)).slice(0,safeLimit);}
  health(){return {running:this.running,radar:'ROTATION_LAG_RADAR',universe:this.universe.length,last_universe_refresh_at:this.universeAt||null,last_scan_at:this.lastScanAtMs,
    scans:this.scans,cycles:this.cycles,alerts_emitted:this.alertCount,watch_alerts_emitted:this.watchAlertCount,candidate_count:this.latestCandidates.size,last_error:this.lastError,busy:this.busy,busy_since_at:this.busySinceAt,
    poll_ms:this.config.pollMs,min_quote_volume_24h:this.config.minQuoteVolume24h,rotation_cursor:this.cursor,batch_size:Number(this.config.topLaggers||0)+Number(this.config.rotationBatchSize||0),
    decision_diagnostics:{...this.lastDecisionDiagnostics,top_rejection_reasons:Object.entries(this.decisionRejectionCounts).sort((a,b)=>b[1]-a[1]).slice(0,15).map(([reason,count])=>({reason,count}))},rest:this.rest?.health?.()||null,
    algorithms:['CROSS_MARKET_LEAD_LAG','RELATIVE_STRENGTH_SPREAD','SILENT_VOLUME_PRICE_DISLOCATION','BUYER_TRADE_ACCELERATION','TAKER_BUY_PRESSURE','VWAP_RECLAIM_REJECTION','VALUE_ACCEPTANCE','RSI_MFI_TURN','STOCHASTIC_TURN','PRICE_PERSISTENCE','RANGE_COMPRESSION','ROTATING_UNIVERSE_COVERAGE'],
    source:'Binance Public REST',closed_candles_only:true,paper_trading:true,real_order_execution:false,confidence_score:'UNKNOWN'};}
}
