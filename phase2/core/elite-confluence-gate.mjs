const clamp=(v,min=0,max=100)=>Math.max(min,Math.min(max,Number.isFinite(Number(v))?Number(v):0));

function hit(v,threshold=70){return Number.isFinite(Number(v))&&Number(v)>=threshold;}

export function evaluateEliteGate({
  radar='UNKNOWN',
  direction='UP',
  baseScore=0,
  priceChange24h=0,
  liquidityScore=70,
  dataQualityScore=85,
  triggerScore=50,
  structureScore=50,
  participationScore=50,
  flowScore=50,
  relativeScore=50,
  momentumScore=50,
  compressionScore=50,
  confirmations=0,
  minConfirmations=6,
  minScore=84,
  max24hMovePct=6,
  requireTrigger=true,
  minCategoryHits=4
}={}){
  const categories={
    trigger:clamp(triggerScore),
    structure:clamp(structureScore),
    participation:clamp(participationScore),
    flow:clamp(flowScore),
    relative:clamp(relativeScore),
    momentum:clamp(momentumScore),
    compression:clamp(compressionScore)
  };
  const hits=Object.entries(categories).filter(([,v])=>hit(v,70)).map(([name])=>name);
  const extended=Math.abs(Number(priceChange24h)||0)>max24hMovePct;
  const weakLiquidity=clamp(liquidityScore)<60;
  const weakData=clamp(dataQualityScore)<80;
  const missingTrigger=requireTrigger&&!hit(triggerScore,72);
  const volumeWithoutFollowThrough=clamp(participationScore)>=86&&clamp(structureScore)<58&&clamp(momentumScore)<60;
  const flowWithoutRelativeSupport=clamp(flowScore)>=88&&clamp(relativeScore)<45;
  const score=clamp(
    clamp(baseScore)*0.28+
    categories.trigger*0.18+
    categories.structure*0.13+
    categories.participation*0.12+
    categories.flow*0.11+
    categories.relative*0.08+
    categories.momentum*0.06+
    categories.compression*0.04
  );
  const eligible=
    String(direction).startsWith('UP') &&
    !extended &&
    !weakLiquidity &&
    !weakData &&
    !missingTrigger &&
    !volumeWithoutFollowThrough &&
    !flowWithoutRelativeSupport &&
    score>=minScore &&
    Number(confirmations)>=minConfirmations &&
    hits.length>=minCategoryHits;

  const stage=!eligible
    ? 'REJECT'
    : score>=93
      ? 'ELITE_IGNITION'
      : score>=88
        ? 'ELITE_PRE_EXPANSION'
        : 'ELITE_BUILDUP';

  const reasons=[];
  if(hit(triggerScore,72))reasons.push('وجود محفز سعري/اختراق صالح');
  if(hit(structureScore,70))reasons.push('الهيكل السعري يدعم استمرارًا');
  if(hit(participationScore,70))reasons.push('المشاركة ترتفع مع الحركة');
  if(hit(flowScore,70))reasons.push('تدفق الشراء/السيولة مؤيد');
  if(hit(relativeScore,70))reasons.push('تفوق نسبي على السوق');
  if(hit(momentumScore,70))reasons.push('الزخم يتسارع');
  if(hit(compressionScore,70))reasons.push('انكماش/تحول تذبذب قبل التوسع');
  const riskFlags=[];
  if(extended)riskFlags.push('ALREADY_EXTENDED_24H');
  if(weakLiquidity)riskFlags.push('LIQUIDITY_TOO_WEAK');
  if(weakData)riskFlags.push('DATA_QUALITY_TOO_WEAK');
  if(missingTrigger)riskFlags.push('NO_PRIMARY_TRIGGER');
  if(volumeWithoutFollowThrough)riskFlags.push('VOLUME_WITHOUT_PRICE_FOLLOW_THROUGH');
  if(flowWithoutRelativeSupport)riskFlags.push('FLOW_WITHOUT_RELATIVE_SUPPORT');
  if(Number(confirmations)<minConfirmations)riskFlags.push('LOW_CONFLUENCE');
  if(hits.length<minCategoryHits)riskFlags.push('LOW_CATEGORY_DIVERSITY');

  return {
    eligible,
    stage,
    score:Number(score.toFixed(1)),
    confirmations:Number(confirmations)||0,
    min_confirmations:minConfirmations,
    category_hits:hits.length,
    categories,
    reasons,
    risk_flags:riskFlags,
    pre_expansion_window:eligible,
    target_concept:'اكتشاف مبكر قبل التوسع؛ لا يوجد ضمان لنسبة ارتفاع محددة',
    radar
  };
}
