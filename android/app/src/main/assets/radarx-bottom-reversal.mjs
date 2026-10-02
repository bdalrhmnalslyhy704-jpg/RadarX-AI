const clamp=(n,min=0,max=100)=>Math.max(min,Math.min(max,Number(n)||0));
const scoreOf=(c,id)=> {
  const row=(c?.strategies||[]).find(x=>String(x.id).toUpperCase()===id);
  return Number.isFinite(Number(row?.score?.value))?Number(row.score.value):null;
};
const stateOf=(c,id)=>String((c?.strategies||[]).find(x=>String(x.id).toUpperCase()===id)?.signal_state||'').toUpperCase();
const fpOf=c=>c?.pre_breakout_fingerprint||{};
const evidenceScore=(c,key,fallback=50)=>{
  const x=fpOf(c)?.evidence?.[key];
  return Number.isFinite(Number(x?.score))?clamp(x.score):fallback;
};
const evidenceStatus=(c,key)=>String(fpOf(c)?.evidence?.[key]?.status||'').toUpperCase();

function minDefined(values,fallback=50){
  const xs=values.filter(Number.isFinite);
  return xs.length?Math.min(...xs):fallback;
}
function avgDefined(values,fallback=50){
  const xs=values.filter(Number.isFinite);
  return xs.length?xs.reduce((a,b)=>a+b,0)/xs.length:fallback;
}

export const BOTTOM_STRATEGIES=Object.freeze([
  {id:'MEAN_REVERSION',name:'Filtered Mean Reversion',role:'يبحث عن ارتداد بعد ضغط هبوطي مع فلتر الاتجاه'},
  {id:'BOLLINGER_BAND_REVERSION',name:'Bollinger + RSI',role:'يراقب وصول السعر لمناطق الانكماش/الطرف السفلي مع RSI'},
  {id:'VCP_PRE_BREAKOUT',name:'VCP Pre-Breakout',role:'يراقب انكماش النطاق وجفاف العرض قبل توسع محتمل'},
  {id:'RELATIVE_VOLUME_SURGE',name:'Relative Volume Surge',role:'يبحث عن استيقاظ الحجم مع حركة سعر مؤكدة'},
  {id:'VWAP_REVERSION',name:'VWAP Reversion',role:'يراقب الانحراف عن VWAP والعودة نحوه'},
  {id:'MACD_TREND_CONTINUATION',name:'MACD Momentum',role:'يتحقق من عودة الزخم واتجاه المدرج'},
  {id:'EMA_RIBBON_ALIGNMENT',name:'EMA Ribbon Alignment',role:'يتحقق من تحول ترتيب المتوسطات لصالح الاتجاه'},
  {id:'ADX_TREND_STRENGTH',name:'ADX Trend Strength',role:'يفحص هل الزخم أصبح قويًا بما يكفي للاستمرار'},
  {id:'ATR_EXPANSION',name:'ATR Expansion',role:'يراقب انتقال الحركة من هدوء إلى توسع'},
  {id:'MTF_TREND',name:'Multi-Timeframe Trend',role:'يربط الإطار 4h و1h و15m حتى لا يعتمد القرار على إطار واحد'}
]);

function strategySignal(c,id){
  const s=scoreOf(c,id);
  const accepted=['CANDIDATE','CONFIRMED'].includes(stateOf(c,id));
  return accepted && Number.isFinite(s)?s:Math.max(0,Number.isFinite(s)?s-12:0);
}

export function scoreBottomCandidate(c){
  const change=Number(c?.price_change_24h);
  const drawdown = Number.isFinite(change)
    ? clamp(50 - change*6 + (change<0 ? 18 : change<=2 ? 6 : 0))
    : 35;

  const sellingExhaustion=avgDefined([
    evidenceScore(c,'structure'),
    evidenceScore(c,'compression'),
    scoreOf(c,'MEAN_REVERSION'),
    scoreOf(c,'BOLLINGER_BAND_REVERSION')
  ],45);

  const buyingPressure=avgDefined([
    evidenceScore(c,'order_flow'),
    evidenceScore(c,'relative_power'),
    evidenceScore(c,'volume'),
    scoreOf(c,'RELATIVE_VOLUME_SURGE')
  ],45);

  const momentumAwakening=avgDefined([
    scoreOf(c,'MACD_TREND_CONTINUATION'),
    scoreOf(c,'ADX_TREND_STRENGTH'),
    scoreOf(c,'ATR_EXPANSION'),
    scoreOf(c,'MTF_TREND')
  ],40);

  const compression=avgDefined([
    scoreOf(c,'VCP_PRE_BREAKOUT'),
    evidenceScore(c,'compression')
  ],45);

  const structure=avgDefined([
    evidenceScore(c,'structure'),
    scoreOf(c,'EMA_RIBBON_ALIGNMENT'),
    scoreOf(c,'MTF_TREND')
  ],45);

  const vwap=scoreOf(c,'VWAP_REVERSION');
  const confirmation=avgDefined([
    vwap,
    scoreOf(c,'MACD_TREND_CONTINUATION'),
    scoreOf(c,'EMA_RIBBON_ALIGNMENT'),
    evidenceScore(c,'resistance')
  ],45);

  const trapQuality=100-clamp(fpOf(c)?.trapRisk,100);
  const liquidity=clamp(c?.liquidity_quality,0,100);
  const dataQuality=clamp(c?.data_quality,0,100);

  let raw=
    drawdown*0.13+
    sellingExhaustion*0.13+
    buyingPressure*0.20+
    momentumAwakening*0.17+
    compression*0.10+
    structure*0.10+
    confirmation*0.07+
    trapQuality*0.05+
    liquidity*0.03+
    dataQuality*0.02;

  const hardReject =
    dataQuality<70 ||
    liquidity<60 ||
    fpOf(c)?.stage==='EXHAUSTED-HIGH-RISK' ||
    fpOf(c)?.stage==='FALSE-BREAKOUT' ||
    (Number.isFinite(change) && change>12 && buyingPressure<55);

  if(hardReject) raw=Math.min(raw,49);

  const supporting=[
    ['ضغط سعري/قرب من القاع',drawdown],
    ['انحسار ضغط البيع',sellingExhaustion],
    ['كمية/قوة الشراء',buyingPressure],
    ['استيقاظ الزخم',momentumAwakening],
    ['انكماش قبل الحركة',compression],
    ['تحسن الهيكل',structure],
    ['تأكيد VWAP/الزخم',confirmation],
    ['جودة ضد فخ',trapQuality]
  ];

  const strategyRows=BOTTOM_STRATEGIES.map(s=>{
    const score=scoreOf(c,s.id);
    const state=stateOf(c,s.id);
    return {...s,score,signal_state:state,used:Number.isFinite(score)};
  });

  const stage =
    raw>=82 ? 'EARLY-BUILD' :
    raw>=72 ? 'REVERSAL-WATCH' :
    raw>=62 ? 'BOTTOMING-WATCH' :
    raw>=50 ? 'UNCONFIRMED' : 'NO-SETUP';

  const trendBias = avgDefined([
    scoreOf(c,'MTF_TREND'),
    scoreOf(c,'MACD_TREND_CONTINUATION'),
    scoreOf(c,'EMA_RIBBON_ALIGNMENT')
  ],45);

  const path =
    trendBias>=72 && buyingPressure>=72 ? 'تحسن زخم: راقب استعادة المقاومة القريبة ثم استمرار الحجم' :
    buyingPressure>=65 && compression>=65 ? 'مرحلة بناء: راقب خروجًا من النطاق مع حجم أعلى' :
    sellingExhaustion>=68 ? 'ارتداد محتمل: راقب شمعة تأكيد قبل اعتبار الحركة مستمرة' :
    'ما زال التكوين غير مكتمل؛ انتظر تحسن القوة الشرائية والهيكل';

  const horizons=[
    {window:'1–2 يوم',watch:clamp(raw+Math.max(-8,Math.min(8,momentumAwakening-65))),condition:'تتابع الإغلاق فوق المقاومة القريبة + تحسن الحجم'},
    {window:'3–5 أيام',watch:clamp(raw+Math.max(-10,Math.min(10,trendBias-60))),condition:'ثبات القيعان الأعلى وارتفاع Relative Volume'},
    {window:'5–7 أيام',watch:clamp(raw+Math.max(-12,Math.min(12,structure-60))),condition:'استمرار التدفق الإيجابي وعدم ظهور فخ/فشل اختراق'}
  ];

  return {
    symbol:String(c?.symbol||''),
    price:Number(c?.last_price),
    change24h:change,
    score:Math.round(clamp(raw)*10)/10,
    stage,
    path,
    horizons,
    supporting,
    strategyRows,
    buyingPressure:Math.round(buyingPressure*10)/10,
    momentumAwakening:Math.round(momentumAwakening*10)/10,
    sellingExhaustion:Math.round(sellingExhaustion*10)/10,
    compression:Math.round(compression*10)/10,
    structure:Math.round(structure*10)/10,
    trapQuality:Math.round(trapQuality*10)/10,
    liquidity,
    dataQuality,
    priceZoneNote:'مناطق المراقبة مبنية على شروط السوق الحالية وليست أسعارًا مستقبلية مضمونة.'
  };
}

export function rankBottomCandidates(body){
  const candidates=Array.isArray(body?.candidates)?body.candidates:[];
  return candidates
    .filter(c=>c?.data_status?.data_valid===true && Number.isFinite(Number(c?.last_price)))
    .map(scoreBottomCandidate)
    .sort((a,b)=>b.score-a.score||b.buyingPressure-a.buyingPressure)
    .slice(0,10);
}
