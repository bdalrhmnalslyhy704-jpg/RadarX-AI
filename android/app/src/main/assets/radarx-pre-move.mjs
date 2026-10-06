const clamp=(n,min=0,max=100)=>Math.max(min,Math.min(max,Number(n)||0));
const num=(v,d=null)=>Number.isFinite(Number(v))?Number(v):d;

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

export function rankPreMoveCandidates(body){
  const rows=Array.isArray(body && body.candidates)?body.candidates:[];
  return rows
    .filter(c=>c && c.data_status && data_status.data_valid===true&&c && c.pre_move_context&&Number.isFinite(Number(c.pre_move_context.score)))
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
    .sort((a,b)=>
      (Number(b.alreadyMoved)-Number(a.alreadyMoved))||
      b.score-a.score||
      (a.sessionReturn-b.sessionReturn)||
      b.volumeAcceleration-a.volumeAcceleration
    )
    .slice(0,10);
}

export function stageLabel(stage){
  return ({
    READY:'جاهز للمراقبة',
    EARLY_WAKE:'بدأ يستيقظ',
    QUIET_BUILD:'بناء هادئ',
    ALREADY_MOVED:'تحرك بالفعل',
    NO_SETUP:'لا يوجد إعداد'
  })[stage]||stage;
}

export function stageClass(stage){
  return stage==='READY'||stage==='EARLY_WAKE'?'good':
    stage==='QUIET_BUILD'?'watch':
    stage==='ALREADY_MOVED'?'late':'muted';
}

export function scoreColorClass(score){
  return Number(score)>=82?'high':Number(score)>=72?'mid':'low';
}
