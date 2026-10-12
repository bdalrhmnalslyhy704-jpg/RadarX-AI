const clamp=(value,min=0,max=100)=>Math.max(min,Math.min(max,Number.isFinite(Number(value))?Number(value):0));
const n=(value)=>value===null||value===undefined||value===''||!Number.isFinite(Number(value))?null:Number(value);

const SOFT_STRICT_FAILURES=new Set([
  'SCORE_BELOW_STRICT_THRESHOLD',
  'ELITE_GATE_NOT_ELIGIBLE',
  'RISK:24H_ALREADY_EXTENDED',
  'RISK:ALREADY_EXTENDED_24H',
  'RISK:ADVANCED_CHASE_RISK'
]);
const MISSING_3S_FAILURE='THREE_SECOND_TAKER_BUY_RATIO_GT_70_PERCENT';

/**
 * Conservative second lane for an informative pre-expansion warning.
 * It does not make a strict/entry gate pass: it allows only well-supported, fresh,
 * upward ignition candidates where the strict lane is blocked by extension scoring,
 * or where the only missing evidence is the completed 3-second flow bucket and the
 * longer-window microstructure evidence is exceptionally strong.
 */
export function evaluateDynamicEarlyWarningGate(alert={},row={},{
  now=Date.now(),
  alertScore=alert?.strong_move?.score,
  minQuoteVolume24h=1_000_000,
  strictFailures=[],
  coreTriggerFailures=[],
  lastAlertAt=0,
  earlyCooldownMs=30*60*1000
}={}){
  const a=alert?.strong_move||{};
  const m=a.metrics||{};
  const failures=[];
  const softFailures=[];
  const score=n(alertScore)??n(a.score)??n(m.flash_score)??0;
  const direction=String(alert?.direction??a.direction??'').toUpperCase();
  const return1=n(m.return_1m);
  const return3=n(m.return_3m);
  const acceleration=n(m.acceleration);
  const volumeRatio=n(m.volume_ratio);
  const tradeRatio=n(m.trade_ratio);
  const takerRatio=n(m.taker_buy_ratio);
  const taker3s=n(m.three_second_taker_buy_ratio??m.three_second_liquidity?.taker_buy_ratio);
  const confirmations=n(m.independent_confirmations)??0;
  const priceChange24h=n(row?.priceChange24h??alert?.price_change_24h);
  const quoteVolume=n(row?.quoteVolume24h);
  const minQuote=Math.max(1,n(row?.minQuoteVolume24h)??n(minQuoteVolume24h)??1_000_000);
  const sourceClose=n(a.source_candle_close_at??alert?.source_candle_close_at??alert?.source_event_at);
  const sourceAgeMs=sourceClose===null?null:Number(now)-sourceClose;
  const risks=[...(Array.isArray(alert?.risk_flags)?alert.risk_flags:[]),...(Array.isArray(alert?.elite_gate?.risk_flags)?alert.elite_gate.risk_flags:[])].map(x=>String(x).toUpperCase());
  const triggerCodes=(Array.isArray(coreTriggerFailures)?coreTriggerFailures:[]).map(x=>String(x));
  const flow3Available=m.three_second_liquidity?.available===true&&taker3s!==null;
  const missing3sOnly=!flow3Available&&triggerCodes.length===1&&triggerCodes[0]===MISSING_3S_FAILURE;
  const fallback=missing3sOnly&&takerRatio!==null&&takerRatio>=0.85&&score>=84&&confirmations>=8&&
    (volumeRatio??0)>=2&&(tradeRatio??0)>=1.8&&(return1??0)>=0.45&&(return3??0)>=0.45&&
    (acceleration??0)>=0.25&&(m.breakout_up===true||m.micro_breakout===true);

  if(!direction.startsWith('UP'))failures.push('EARLY_WARNING_DIRECTION_NOT_UP');
  if(score<82)failures.push('EARLY_WARNING_SCORE_TOO_LOW');
  if(!alert?.eligible&&!fallback)failures.push('EARLY_WARNING_CORE_GATE_FAILED');
  if(!(return1>0.25))failures.push('EARLY_WARNING_1M_MOMENTUM_WEAK');
  if(!(return3>=0.60))failures.push('EARLY_WARNING_3M_MOMENTUM_WEAK');
  if(!(acceleration>=0.25))failures.push('EARLY_WARNING_ACCELERATION_WEAK');
  if(!(volumeRatio>=1.6))failures.push('EARLY_WARNING_VOLUME_SURGE_WEAK');
  if(!(tradeRatio>=1.35))failures.push('EARLY_WARNING_TRADE_SURGE_WEAK');
  if(!(confirmations>=7))failures.push('EARLY_WARNING_CONFIRMATIONS_LOW');
  if(!(m.breakout_up===true||m.micro_breakout===true))failures.push('EARLY_WARNING_NO_BREAKOUT_EVIDENCE');
  if(takerRatio===null||takerRatio<(fallback?0.85:0.70))failures.push('EARLY_WARNING_BUY_FLOW_NOT_CONFIRMED');
  if(!flow3Available&&!fallback)failures.push('EARLY_WARNING_3S_FLOW_UNAVAILABLE');
  if(flow3Available&&!(taker3s>0.70))failures.push('EARLY_WARNING_3S_BUY_FLOW_NOT_CONFIRMED');
  if(sourceClose===null||sourceAgeMs===null||sourceAgeMs<0||sourceAgeMs>90_000)failures.push('EARLY_WARNING_SOURCE_CANDLE_STALE');
  if(quoteVolume===null||quoteVolume<minQuote)failures.push('EARLY_WARNING_LIQUIDITY_BELOW_MINIMUM');
  if(priceChange24h===null||priceChange24h>35)failures.push('EARLY_WARNING_24H_EXTENSION_TOO_LARGE');
  if(risks.some(x=>/SELLING_PRESSURE_HIGH|TAKER_BUY_PRESSURE_NOT_CONFIRMED|DATA_QUALITY|FUTURE_DATA|STALE_DATA|CANDLE_STALE|CANDLE_GAP|WIDE_SPREAD|LOW_LIQUIDITY|LIQUIDITY_TOO_WEAK|NO_PRIMARY_TRIGGER|FLOW_WITHOUT_RELATIVE_SUPPORT|VOLUME_WITHOUT_PRICE_FOLLOW_THROUGH|DISJOINTED_SIGNAL/.test(x))) {
    failures.push('EARLY_WARNING_HARD_RISK_PRESENT');
  }
  const last=Number(lastAlertAt)||0;
  if(last>0&&Number(now)-last<Math.max(earlyCooldownMs,0))failures.push('EARLY_WARNING_SYMBOL_COOLDOWN');

  const unknownStrictFailures=[];
  for(const code of [...new Set((Array.isArray(strictFailures)?strictFailures:[]).map(String))]){
    if(SOFT_STRICT_FAILURES.has(code))softFailures.push(code);
    else if(code==='BASE_ALERT_NOT_ELIGIBLE'&&fallback)softFailures.push(code);
    else unknownStrictFailures.push(code);
  }
  if(unknownStrictFailures.length)failures.push(...unknownStrictFailures.map(x=>'EARLY_WARNING_STRICT_BLOCKER:'+x));
  if(fallback)softFailures.push('STRICT_CORE_MISSING_COMPLETED_3S_BUCKET_HIGHER_FLOW_EVIDENCE_USED');
  if(priceChange24h>=20)softFailures.push('24H_MOVE_EXTENSION_SOFT_RISK');
  if(risks.includes('VOLATILITY_EXTREME'))softFailures.push('VOLATILITY_EXTREME_SOFT_RISK');

  const flow1Score=takerRatio===null?0:clamp(70+(takerRatio-0.70)*200);
  const flow3Score=flow3Available?clamp(70+((taker3s??0)-0.70)*200):78;
  const momentumScore=clamp(55+Math.max(0,return3??0)*8+Math.max(0,return1??0)*2);
  const accelerationScore=clamp(55+Math.max(0,acceleration??0)*10);
  const volumeScore=clamp(50+Math.max(0,(volumeRatio??0)-1)*25);
  const tradeScore=clamp(50+Math.max(0,(tradeRatio??0)-1)*20);
  const confirmationScore=clamp(confirmations*10);
  const breakoutScore=m.breakout_up===true?100:m.micro_breakout===true?80:0;
  const components={
    strong_move_score:clamp(score),buy_flow_1m_3m:flow1Score,buy_flow_3s:flow3Score,
    momentum:momentumScore,acceleration:accelerationScore,volume:volumeScore,
    trades:tradeScore,confirmations:confirmationScore,breakout:breakoutScore
  };
  let dynamicScore=components.strong_move_score*0.20+components.buy_flow_1m_3m*0.14+
    components.buy_flow_3s*0.12+components.momentum*0.15+components.acceleration*0.10+
    components.volume*0.10+components.trades*0.08+components.confirmations*0.07+
    components.breakout*0.04;
  if(priceChange24h>=20)dynamicScore-=2;
  if(risks.includes('VOLATILITY_EXTREME'))dynamicScore-=1;
  if(fallback)dynamicScore-=3;
  dynamicScore=Number(clamp(dynamicScore).toFixed(1));
  const minDynamicScore=fallback?77.5:77.5;
  if(dynamicScore<minDynamicScore)failures.push('EARLY_WARNING_DYNAMIC_SCORE_BELOW_MINIMUM');

  const uniqueFailures=[...new Set(failures)];
  return {
    eligible:uniqueFailures.length===0,
    mode:'DYNAMIC_EARLY_WARNING',
    alert_class:'PRE_EXPANSION_WATCH',
    score:dynamicScore,
    min_score:minDynamicScore,
    components,
    fallback_3s_flow:fallback,
    flow_evidence:{taker_buy_ratio_1m_3m:takerRatio,taker_buy_ratio_3s:taker3s,three_second_bucket_available:flow3Available},
    timing:{source_candle_close_at:sourceClose,source_data_age_ms:sourceAgeMs,decision_at:Number(now)},
    price_change_24h_pct:priceChange24h,
    soft_failures:[...new Set(softFailures)],
    failures:uniqueFailures,
    rationale:fallback
      ? 'تدفق شراء طويل النافذة شديد القوة مع اندفاع/حجم/صفقات/اختراق؛ حُوّل غياب سلة 3 ثوانٍ المكتملة إلى تحذير رصد فقط، وليس تأكيد دخول.'
      : 'توافق اندفاع سعري واتساع مشاركة وتدفق شراء على نافذتي الدقيقة/الثلاث ثواني؛ تحذير رصد مبكر وليس توصية تنفيذ.'
  };
}
