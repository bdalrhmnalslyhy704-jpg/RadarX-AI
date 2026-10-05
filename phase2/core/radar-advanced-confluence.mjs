const clamp=(v,min=0,max=100)=>Math.max(min,Math.min(max,Number.isFinite(Number(v))?Number(v):50));
const safe=v=>clamp(v);
const harmonic=(a,b,c)=>{
  const xs=[a,b,c].map(safe);
  const den=xs.reduce((s,x)=>s+(x>0?1/x:1e9),0);
  return den>0?clamp(xs.length/den):0;
};

function dispersion(values){
  const xs=values.map(Number).filter(Number.isFinite);
  if(xs.length<2)return 0;
  const mean=xs.reduce((s,x)=>s+x,0)/xs.length;
  return Math.sqrt(xs.reduce((s,x)=>(s+(x-mean)**2),0)/xs.length);
}

function scoreAntiChase(priceChange24h){
  const move=Math.abs(Number(priceChange24h)||0);
  if(move<=2)return 100;
  if(move>=18)return 18;
  const excess=move-2;
  return clamp(100-Math.pow(excess,1.18)*5.2,18,100);
}

export function evaluateAdvancedConfluence({
  categories={},
  priceChange24h=0,
  confirmations=0,
  minConfirmations=6,
  baseScore=0
}={}){
  const trigger=safe(categories.trigger);
  const structure=safe(categories.structure);
  const participation=safe(categories.participation);
  const flow=safe(categories.flow);
  const relative=safe(categories.relative);
  const momentum=safe(categories.momentum);
  const compression=safe(categories.compression);

  // 1) Directional-core: requires price trigger, structure and momentum to agree.
  const directionalCore=harmonic(trigger,structure,momentum);

  // 2) Ignition coherence: a breakout is stronger when compression, trigger and momentum
  // rise together rather than one component carrying the whole score.
  const ignitionCoherence=harmonic(trigger,momentum,compression);

  // 3) Participation integrity: high volume/flow alone is not enough; it must be
  // compatible with relative strength and price structure.
  const flowParticipationGap=Math.abs(flow-participation);
  const participationIntegrity=clamp(
    Math.min(participation,flow)*0.52+
    Math.min(structure,relative)*0.23+
    Math.min(momentum,relative)*0.15+
    Math.max(0,100-flowParticipationGap)*0.10
  );

  // 4) Multi-factor coherence: stable agreement across independent families.
  const spread=dispersion([trigger,structure,participation,flow,relative,momentum,compression]);
  const coherence=clamp(100-spread*1.55);

  // 5) Confirmation breadth: rewards diverse confirmations, not repeated copies
  // of the same signal.
  const categoryHits=Object.values({
    trigger,structure,participation,flow,relative,momentum,compression
  }).filter(v=>v>=70).length;
  const confirmationBreadth=clamp(
    Number(confirmations||0)*7.5+
    categoryHits*5.5+
    Math.min(100,Number(confirmations||0)/Math.max(1,Number(minConfirmations)||1)*20)
  );

  // 6) Anti-chase guard: early radars should prefer room before extension.
  const antiChase=scoreAntiChase(priceChange24h);

  // 7) Adaptive composite: no new network calls; all work is O(1).
  const score=clamp(
    safe(baseScore)*0.30+
    directionalCore*0.19+
    ignitionCoherence*0.13+
    participationIntegrity*0.14+
    coherence*0.10+
    relative*0.06+
    confirmationBreadth*0.05+
    antiChase*0.03
  );

  const regime =
    ignitionCoherence>=82 && compression>=72 ? 'COMPRESSION_IGNITION' :
    directionalCore>=82 && participationIntegrity>=74 ? 'TREND_EXPANSION' :
    antiChase<45 ? 'EXTENDED_CHASE_RISK' :
    coherence<42 ? 'DISJOINTED_SIGNAL' :
    'BUILDUP_OR_MIXED';

  const eligible=
    score>=84 &&
    directionalCore>=68 &&
    participationIntegrity>=52 &&
    coherence>=40 &&
    confirmationBreadth>=55 &&
    antiChase>=35;

  return {
    eligible,
    score:Number(score.toFixed(1)),
    regime,
    directional_core:Number(directionalCore.toFixed(1)),
    ignition_coherence:Number(ignitionCoherence.toFixed(1)),
    participation_integrity:Number(participationIntegrity.toFixed(1)),
    coherence:Number(coherence.toFixed(1)),
    confirmation_breadth:Number(confirmationBreadth.toFixed(1)),
    anti_chase:Number(antiChase.toFixed(1)),
    category_hits:categoryHits,
    diagnostics:{
      dispersion:Number(spread.toFixed(2)),
      flow_participation_gap:Number(flowParticipationGap.toFixed(1))
    },
    algorithms:[
      'DIRECTIONAL_CORE_HARMONIC',
      'IGNITION_COHERENCE',
      'PARTICIPATION_INTEGRITY',
      'MULTI_FACTOR_COHERENCE',
      'CONFIRMATION_BREADTH',
      'ANTI_CHASE_ADAPTIVE_GUARD'
    ]
  };
}

export function buildAdvancedRiskFlags(advanced={}){
  const flags=[];
  if(Number(advanced.coherence)<40)flags.push('ADVANCED_LOW_COHERENCE');
  if(Number(advanced.participation_integrity)<50)flags.push('ADVANCED_PARTICIPATION_DIVERGENCE');
  if(Number(advanced.confirmation_breadth)<50)flags.push('ADVANCED_LOW_CONFIRMATION_BREADTH');
  if(Number(advanced.anti_chase)<35)flags.push('ADVANCED_CHASE_RISK');
  if(advanced.regime==='DISJOINTED_SIGNAL')flags.push('ADVANCED_DISJOINTED_SIGNAL');
  return flags;
}
