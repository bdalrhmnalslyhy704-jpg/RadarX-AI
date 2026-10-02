const score=v=>Number.isFinite(Number(v))?Math.max(0,Math.min(100,Number(v))):null;

export function normalizeMoveAlerts(body){
  const alerts=Array.isArray(body?.alerts)?body.alerts:[];
  return alerts.map(a=>({
    ...a,
    setupScore:score(a.opportunity_score),
    expansionPotential:score(a.expansion_potential),
    reversalPotential:score(a.reversal_potential),
    movePct:Number(a.price_change_24h),
    reasons:Array.isArray(a.reasons)?a.reasons:[],
    acceptedStrategies:Array.isArray(a.strategy_confluence?.accepted_ids)?a.strategy_confluence.accepted_ids:[]
  })).filter(a=>a.symbol);
}

export function moveLabel(direction){
  return direction==='UP_MOVE'?'حركة صعود مبكرة':'هبوط + احتمال ارتداد';
}

export function potentialLabel(label){
  return ({
    HIGH_EXPANSION_SETUP:'تهيؤ لتوسع قوي',
    EXPANSION_WATCH:'توسع يستحق المراقبة',
    EARLY_MOVE:'بداية حركة'
  })[label]||label||'مراقبة';
}


// RELEASE_VALIDATION_24H_MOVE_RADAR
