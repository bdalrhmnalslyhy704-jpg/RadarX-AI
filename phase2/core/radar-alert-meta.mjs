import {buildRadarIntelligenceV3} from './radar-intelligence-v3.mjs';

export const RADAR_NAMES=Object.freeze({
  EARLY_MOVE_RADAR:'Radar 1 — المدمر',
  STRONG_MOVE_RADAR:'Radar 2 — ملك الظلام',
  ROTATION_LAG_RADAR:'Radar 3 — الجوكر',
  LIQUIDITY_ABSORPTION_RADAR:'Radar 4 — الكاسح',
  KAHIR_RADAR:'Radar 5 — القاهر',
  DOOMSDAY_RADAR:'Radar 6 — يوم القيامة',
  PROFESSOR_RADAR:'البروفيسور — استخبارات عامة',
  ALMUQAWIM_RADAR:'Radar 7 — المقاوم'
});
export const RADAR_PROFILES=Object.freeze({
  EARLY_MOVE_RADAR:Object.freeze({
    name:RADAR_NAMES.EARLY_MOVE_RADAR,icon:'☠️',color:'#ff3b30',
    mission:'صياد ما قبل الانفجار: يلتقط العملة وهي هادئة قبل تمدد الحركة.',
    strength:'الأفضل لاكتشاف الاستيقاظ المبكر بدل مطاردة الارتفاع بعد حدوثه.',
    strategy:'Pre-Breakout Fingerprint + Relative Strength + Compression + Strategy Confluence',
    timeframes:['1m','5m','15m'],algorithms:['Fast Impulse','RVOL Awakening','Taker Flow','EMA Reclaim','S/R Proximity','RSI Turn','OBV Accumulation','Wyckoff Spring','MTF Alignment','Adaptive V3 Quality Gate'],
    guardrails:['يمنع العملة الممتدة','يرفض ضعف جودة البيانات','لا يدخل الشمعة غير المغلقة','يستخدم تنوع الأدلة قبل تمرير التنبيه']
  }),
  STRONG_MOVE_RADAR:Object.freeze({
    name:RADAR_NAMES.STRONG_MOVE_RADAR,icon:'🌑',color:'#7c3aed',
    mission:'كشف الانفجار الجاري: يقيس تسارع السعر والحجم والتداول والاتساع في الدقيقة مع تأكيد 5m.',
    strength:'الأقوى عندما تكون الحركة قد بدأت فعلًا ويظهر توسع حقيقي وليس مجرد شمعة منفردة.',
    strategy:'Momentum Burst + Flash Acceleration + Volume/Trade Climax + Breakout + VWAP/BB/ATR',
    timeframes:['1m','5m'],algorithms:['Momentum Burst','Flash Acceleration','Volume Climax','Trade Count Surge','Taker Flow Acceleration','Donchian Breakout','EMA Burst','VWAP Displacement','Bollinger Expansion','Efficiency Ratio','ATR Expansion','Adaptive V3 Quality Gate'],
    guardrails:['يغلق شموعًا فقط','يمنع الحركة المتطرفة جدًا','يحتاج أكثر من دليل قبل التنبيه','يخصم خطر المطاردة بعد التمدد']  }),
  ROTATION_LAG_RADAR:Object.freeze({
    name:RADAR_NAMES.ROTATION_LAG_RADAR,icon:'🃏',color:'#f59e0b',
    mission:'صائد الدوران: يبحث عن عملة متأخرة عن BTC/ETH ثم تبدأ في استعادة القوة النسبية.',
    strength:'يفيد قبل انتقال السيولة من القادة إلى العملات المتأخرة.',
    strategy:'Cross-Market Lead/Lag + Relative Spread + Value Acceptance + Momentum Turn',
    timeframes:['15m','1h'],algorithms:['BTC/ETH Lead-Lag','Relative Strength Spread','Silent Volume Dislocation','VWAP Reclaim/Rejection','Value Acceptance','RSI/MFI Turn','Stochastic Turn','Price Persistence','Range Compression','Adaptive V3 Quality Gate'],
    guardrails:['يرفض الحركة اليومية الممتدة','يحتاج توافق السوق والعملة','لا يعتبر التأخر وحده إشارة','يمنع اختلاف الأدلة']  }),
  LIQUIDITY_ABSORPTION_RADAR:Object.freeze({
    name:RADAR_NAMES.LIQUIDITY_ABSORPTION_RADAR,icon:'🧹',color:'#06b6d4',
    mission:'كاسح السيولة: يلتقط امتصاص البيع واختلال دفتر الأوامر وتحرر البائعين قبل التحول.',
    strength:'الأقوى عند القيعان والنطاقات عندما يكون الحجم مرتفعًا لكن الحركة الصافية ما زالت صغيرة.',
    strategy:'Seller Absorption + Depth Imbalance/Vacuum + Trapped Sellers + Auction Balance',
    timeframes:['1m','5m'],algorithms:['Seller Absorption','Depth Imbalance/Vacuum','Trapped Seller Release','Microstructure Dislocation','Local Auction Balance','Fractal Micro-Structure','5m Confirmation','Adaptive V3 Quality Gate'],
    guardrails:['يرفض السبريد الواسع','يرفض الحركة اليومية الممتدة','يشترط حجمًا وامتصاصًا حقيقيين','لا يقبل الحجم وحده دون بنية سعرية']  }),
  KAHIR_RADAR:Object.freeze({
    name:RADAR_NAMES.KAHIR_RADAR,icon:'👑',color:'#22c55e',
    mission:'مسح السوق الكامل ومقارنة كل عملة بخط أساسها الذاتي لاكتشاف التسارع غير المعتاد.',
    strength:'الأقوى في ترتيب السوق كاملًا والبحث عن تحولات مبكرة غير عادية.',
    strategy:'Self-Baseline Z + Participation Regime + Volatility Shift + Kaufman Efficiency + Range Acceptance',
    timeframes:['1m','5m'],algorithms:['Self-Baseline Z','Participation Regime','Volatility Regime Shift','Kaufman Efficiency','Range Acceptance','Impulse Persistence','Market Speed Spread','Adaptive V3 Quality Gate'],
    guardrails:['Spot فقط','Paper فقط','لا أسعار مستقبلية صناعية','يفضّل التسارع الذاتي المدعوم بالمشاركة']  }),
  DOOMSDAY_RADAR:Object.freeze({
    name:RADAR_NAMES.DOOMSDAY_RADAR,icon:'☄️',color:'#ff4d3d',
    mission:'صياد الاستيقاظ المفاجئ: يلتقط انتقال السوق من الهدوء إلى الشرارة والانفجار قبل أن تصبح الحركة اليومية ممتدة.',
    strength:'مخصص للحالات التي تنطلق فجأة عبر تسارع الحجم والصفقات وتدفق الشراء والانكماش والاختراق والقوة النسبية.',
    strategy:'Sudden-Move Fingerprint + Early Ignition + Self Acceleration + Relative Strength',
    timeframes:['1m','5m'],algorithms:['1m/3m/5m Momentum','Acceleration vs Self Baseline','Relative Volume','Trade Count Surge','Taker Flow','Squeeze Release','Donchian Breakout','EMA9/21 Burst','VWAP Reclaim','ATR Expansion','Relative Strength vs BTC','Range Acceptance','Adaptive V3 Quality Gate'],
    guardrails:['Spot فقط','شموع مغلقة فقط','يمنع الحركة اليومية الممتدة','يشترط عدة أدلة قبل الإشعار','لا تنفيذ حقيقي']  }),
  ALMUQAWIM_RADAR:Object.freeze({
    name:RADAR_NAMES.ALMUQAWIM_RADAR,icon:'🛡️',color:'#38bdf8',
    mission:'حارس اتجاه السوق: لا يطارد الحركة؛ يحدد الاتجاه من هيكل القمم والقيعان وخط الاتجاه والمتوسط وتوافق الإطارات.',
    strength:'يمنع الدخول عكس الاتجاه عندما تكون 4H و1H متوافقتين، ويُظهر تعارض 15m كخطر بدلاً من اعتباره فرصة.',
    strategy:'HH/HL + LH/LL + Trendline + Moving Average + Higher-Timeframe Alignment',
    timeframes:['4h','1h','15m'],algorithms:['HH/HL Structure','LH/LL Structure','Trendline Direction','EMA Direction Filter','4H/1H Alignment','15m Entry-Risk Guard','Adaptive V3 Quality Gate'],
    guardrails:['شموع مغلقة فقط','Spot فقط','Paper فقط','لا يعتبر الإطار الصغير أقوى من الاتجاه الأكبر','يُصفّي تعارض الفريم الأعلى']  }),
  PROFESSOR_RADAR:Object.freeze({
    name:RADAR_NAMES.PROFESSOR_RADAR,icon:'🧠',color:'#ec4899',
    mission:'استخبارات البثوث والأسواق: يجمع ادعاءات الصفقات من مصادر عامة، الأخبار، ثم يطلب تأكيدًا فنيًا حقيقيًا قبل إصدار رأي ورقي.',
    strength:'يصل بين ما يتحدث عنه المتداولون وما تؤكده الأخبار والسوق بدل نسخ صفقة شخص آخر مباشرة.',
    strategy:'Live-Trade Claim Fusion + News Catalyst + Binance Technical Confirmation',
    timeframes:['15m','1h','4h'],
    algorithms:['Public Live Discovery','Trade-Claim Extraction','Caption Evidence','News Clustering','News Tone','Market Structure','EMA/RSI/MACD/ADX/VWAP','Support/Resistance','Trap Risk','Spot Paper Decision','Adaptive V3 Quality Gate'],
    guardrails:['مصادر عامة فقط','الشموع المغلقة فقط','لا تنفيذ أوامر حقيقية','لا أسعار أو صفقات وهمية']  })
});
function clamp100(v){return Math.max(0,Math.min(100,Number.isFinite(Number(v))?Number(v):50));}
function meanNumbers(values){
  const a=values.map(Number).filter(Number.isFinite);
  return a.length?a.reduce((s,x)=>s+x,0)/a.length:null;
}
function collectObjectScores(obj){
  if(!obj||typeof obj!=='object')return [];
  const out=[];
  for(const [k,v] of Object.entries(obj)){
    if(typeof v==='number'&&Number.isFinite(v)&&/(score|strength|potential)/i.test(k)&&!/(min|max|threshold|count|total)/i.test(k))out.push(v);
    else if(v&&typeof v==='object')out.push(...collectObjectScores(v));
  }
  return out;
}
export function radarPowerScore(alert){
  const id=String(alert?.radar||'').toUpperCase();
  const base=clamp100(alert?.opportunity_score);
  const blocks={
    EARLY_MOVE_RADAR:alert?.early_wake,
    STRONG_MOVE_RADAR:alert?.strong_move,
    ROTATION_LAG_RADAR:alert?.rotation,
    LIQUIDITY_ABSORPTION_RADAR:alert?.liquidity_absorption,
    KAHIR_RADAR:alert?.kahir_analysis,
    DOOMSDAY_RADAR:alert?.doomsday,
    ALMUQAWIM_RADAR:alert?.almuqawim,
    PROFESSOR_RADAR:alert?.professor
  };
  const componentMean=meanNumbers(collectObjectScores(blocks[id]));
  const dataQuality=clamp100(alert?.data_quality??alert?.data_status?.data_quality??100);
  const riskCount=Array.isArray(alert?.risk_flags)?alert.risk_flags.length:0;
  let power=base*.60+(componentMean??base)*.25+dataQuality*.15;
  if(riskCount)power-=Math.min(12,riskCount*2);
  const thresholds={
    EARLY_MOVE_RADAR:72,STRONG_MOVE_RADAR:76,ROTATION_LAG_RADAR:78,LIQUIDITY_ABSORPTION_RADAR:82,KAHIR_RADAR:84,DOOMSDAY_RADAR:82,PROFESSOR_RADAR:80,ALMUQAWIM_RADAR:82
  };
  const gate=power>=Number(thresholds[id]??80);
  return {
    score:Number(clamp100(power).toFixed(1)),
    gate,
    threshold:Number(thresholds[id]??80),
    component_mean:componentMean==null?null:Number(componentMean.toFixed(1)),
    risk_penalty:Math.min(12,riskCount*2)
  };
}
export function formatRadarTime12h(ms,timeZone='Asia/Aden'){
  const d=new Date(Number(ms));
  if(!Number.isFinite(d.getTime()))return 'غير متاح';
  const dateParts=new Intl.DateTimeFormat('en-GB',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(d);
  const timeParts=new Intl.DateTimeFormat('en-US',{timeZone,hour:'numeric',minute:'2-digit',second:'2-digit',hour12:true}).formatToParts(d);
  const date=Object.fromEntries(dateParts.map(x=>[x.type,x.value]));
  const time=Object.fromEntries(timeParts.map(x=>[x.type,x.value]));
  return `${date.day||'00'}/${date.month||'00'}/${date.year||''} • ${time.hour||'12'}:${time.minute||'00'}:${time.second||'00'} ${time.dayPeriod||''}`.trim();
}
export function decorateRadarAlert(alert,radarName){
  const now=Number(alert?.detected_at);
  const at=Number.isFinite(now)?now:Date.now();
  const radar=String(alert?.radar||'').toUpperCase();
  const radar_v2=radarPowerScore(alert);
  const radar_v3=buildRadarIntelligenceV3(alert);
  const profile=RADAR_PROFILES[radar]||null;
  return {...alert,radar_name:alert?.radar_name||radarName||RADAR_NAMES[radar]||'RadarX',
    radar_profile:profile,
    radar_v2,
    radar_power_score:radar_v2.score,
    radar_v3,
    radar_quality_v3:radar_v3.quality_score,
    radar_grade_v3:radar_v3.grade,
    radar_gate_v3:radar_v3.gate,
    detected_at:at,
    detected_at_iso:alert?.detected_at_iso||new Date(at).toISOString(),
    detected_time_12h:alert?.detected_time_12h||formatRadarTime12h(at),
    detected_timezone:'Asia/Aden',paper_trading:true,real_order_execution:false,confidence_score:'UNKNOWN'};
}
