const clamp=(n,min=0,max=100)=>Math.max(min,Math.min(max,Number(n)||0));
const num=(v,d=null)=>v===null||v===undefined||(typeof v==='string'&&v.trim()==='')?d:Number.isFinite(Number(v))?Number(v):d;

const reasonMap={
  VOLUME_ACCELERATING:'الحجم بدأ يستيقظ',
  TAKER_BUY_ACCELERATING:'تدفق الشراء يتحسن',
  RELATIVE_STRENGTH:'أقوى من متوسط السوق',
  COMPRESSION:'انكماش قبل الحركة',
  STRUCTURE_IMPROVING:'الهيكل يتحسن',
  BID_WALL_PRESSURE:'ضغط سيولة شرائية',
  NOT_EXTENDED:'لم يتحرك بقوة بعد',
  ALREADY_EXTENDED:'تحرك بالفعل — لا تطارده',
  RESISTANCE_NEAR:'مقاومة قريبة تحتاج اختراقًا مؤكدًا'
};

const watchReasonMap={
  BELOW_MIN_QUOTE_VOLUME:'حجم التداول اليومي أقل من حد التنبيه',
  LOW_LIQUIDITY:'السيولة أو عمق دفتر الطلبات أقل من حد التنبيه',
  LIQUIDITY_UNVERIFIED:'تعذر تأكيد السيولة؛ مراقبة فقط',
  VOLUME_ACCELERATION_NOT_CONFIRMED:'تسارع الحجم لم يكتمل',
  TRADE_ACCELERATION_NOT_CONFIRMED:'عدد الصفقات لم يؤكد الحركة بعد',
  BUY_FLOW_NOT_CONFIRMED:'ضغط الشراء لم يكتمل',
  BUYER_CANDLE_CLOSES_NOT_CONFIRMED:'إغلاق الشموع لا يؤكد سيطرة المشترين',
  PRICE_WINDOW_NOT_CONFIRMED:'حركة الساعة لم تدخل نطاق التأكيد',
  COMPRESSION_NOT_CONFIRMED:'الانكماش لم يكتمل',
  STRUCTURE_NOT_CONFIRMED:'الهيكل السعري لم يتأكد',
  BUYING_PRESSURE_NOT_CONFIRMED:'الضغط الشرائي لم يبلغ الحد',
  SESSION_MOVE_NOT_CONFIRMED:'حركة الجلسة تحتاج تأكيدًا إضافيًا',
  SCORE_BELOW_ACTIONABLE_THRESHOLD:'الدرجة أقل من حد التنبيه المؤكد',
  ACTIONABLE_GATE_NOT_MET:'لم تجتز جميع شروط التنبيه المؤكد'
};

export function rankPreMoveWatchCandidates(body){
  const rows=Array.isArray(body&&body.watch_candidates)?body.watch_candidates:[];
  return rows
    .filter(c=>{
      const p=c&&c.pre_move_context;
      const ds=c&&c.data_status;
      return Boolean(c&&c.watch_only===true&&c.alert_eligible===false&&
        ds&&ds.candle_data_valid===true&&ds.data_stale!==true&&!ds.last_error&&
        Number(c.data_quality)>=70&&p&&Number.isFinite(Number(p.score))&&Number(p.score)>=45&&
        typeof p.session_return_pct==='number'&&Number.isFinite(p.session_return_pct)&&
        p.session_return_pct>=-1.5&&p.session_return_pct<=8&&
        Number.isFinite(Number(p.one_hour_return_pct))&&Number(p.one_hour_return_pct)>=-1.25&&Number(p.one_hour_return_pct)<=4.5&&
        p.evidence_complete===true&&p.closed_candles_only===true&&p.watch_only===true&&
        p.already_moved!==true&&p.stage==='WATCH_EARLY'&&
        Array.isArray(c.watch_reason_codes)&&c.watch_reason_codes.length>0);
    })
    .map(c=>{
      const p=c.pre_move_context;
      return {
        symbol:String(c.symbol||''),
        price:num(c.last_price),
        change24h:num(c.price_change_24h),
        quoteVolume24h:num(c.quote_volume_24h),
        score:Math.round(clamp(p.score)*10)/10,
        stage:'WATCH_ONLY',
        sessionReturn:num(p.session_return_pct,0),
        relativeStrength:num(p.relative_strength_vs_market_pct),
        relativeStrengthBtc:num(p.relative_strength_vs_btc_pct),
        volumeAcceleration:num(p.volume_acceleration),
        takerBuyRatio:num(p.taker_buy_ratio),
        takerAcceleration:num(p.taker_buy_acceleration),
        sessionPosition:num(p.session_position_pct),
        resistanceDistance:num(p.resistance_distance_pct),
        alreadyMoved:false,
        components:p.components||{},
        reasons:(p.reasons||[]).map(x=>reasonMap[x]||x),
        rawReasons:p.reasons||[],
        liquidity:num(c.liquidity_quality),
        dataQuality:num(c.data_quality),
        closedCandlesOnly:true,
        watchOnly:true,
        watchReason:watchReasonMap[c.watch_only_reason]||watchReasonMap.ACTIONABLE_GATE_NOT_MET,
        watchReasons:(Array.isArray(c.watch_reason_codes)?c.watch_reason_codes:[])
          .map(code=>watchReasonMap[code]||String(code)).filter(Boolean).slice(0,5)
      };
    })
    .sort((a,b)=>b.score-a.score||(a.sessionReturn-b.sessionReturn))
    .slice(0,10);
}

export function rankPreMoveCandidates(body){
  const rows=Array.isArray(body && body.candidates)?body.candidates:[];
  return rows
    .filter(c=>c && c.data_status && c.data_status.data_valid===true && c.pre_move_context &&
      c.pre_move_context.score!==null && c.pre_move_context.score!==undefined &&
      Number.isFinite(Number(c.pre_move_context.score)) &&
      typeof c.pre_move_context.session_return_pct==='number' && Number.isFinite(c.pre_move_context.session_return_pct) &&
      c.pre_move_context.evidence_complete===true &&
      c.pre_move_context.already_moved!==true &&
      !['ALREADY_MOVED','NO_SETUP'].includes(c.pre_move_context.stage))
    .map(c=>{
      const p=c.pre_move_context;
      const sessionReturn=num(p.session_return_pct,0);
      const score=clamp(p.score);
      const late=Boolean(p.already_moved)||p.stage==='ALREADY_MOVED';
      return {
        symbol:String(c.symbol||''),
        price:num(c.last_price),
        change24h:num(c.price_change_24h),
        score:Math.round(score*10)/10,
        stage:String(p.stage||'NO_SETUP'),
        sessionReturn,
        relativeStrength:num(p.relative_strength_vs_market_pct),
        relativeStrengthBtc:num(p.relative_strength_vs_btc_pct),
        volumeAcceleration:num(p.volume_acceleration),
        takerBuyRatio:num(p.taker_buy_ratio),
        takerAcceleration:num(p.taker_buy_acceleration),
        sessionPosition:num(p.session_position_pct),
        resistanceDistance:num(p.resistance_distance_pct),
        alreadyMoved:late,
        components:p.components||{},
        reasons:(p.reasons||[]).map(x=>reasonMap[x]||x),
        rawReasons:p.reasons||[],
        liquidity:num(c.liquidity_quality),
        dataQuality:num(c.data_quality),
        closedCandlesOnly:p.closed_candles_only===true
      };
    })
    // Do not let already-extended assets occupy the actionable Pre-Move ranking.
    .sort((a,b)=>
      b.score-a.score||
      (a.sessionReturn-b.sessionReturn)||
      b.volumeAcceleration-a.volumeAcceleration
    )
    .slice(0,10);
}

export function stageLabel(stage){
  return ({
    READY:'جاهز للمراقبة',
    WATCH_ONLY:'مراقبة فقط — ليس تنبيه دخول',
    EARLY_WAKE:'بدأ يستيقظ',
    QUIET_BUILD:'بناء هادئ',
    ALREADY_MOVED:'تحرك بالفعل',
    NO_SETUP:'لا يوجد إعداد'
  })[stage]||stage;
}

export function stageClass(stage){
  return stage==='READY'||stage==='EARLY_WAKE'?'good':
    stage==='QUIET_BUILD'||stage==='WATCH_ONLY'?'watch':
    stage==='ALREADY_MOVED'?'late':'muted';
}

export function scoreColorClass(score){
  return Number(score)>=82?'high':Number(score)>=72?'mid':'low';
}
