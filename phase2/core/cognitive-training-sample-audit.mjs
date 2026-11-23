import {createHash} from 'node:crypto';
import {TEMPORAL_TARGET_DEFINITION} from './temporal-neural-brain.mjs';

export const COGNITIVE_TRAINING_SEQUENCE_STEPS=24;
export const COGNITIVE_TRAINING_SEQUENCE_CHANNELS=29;
export const COGNITIVE_TRAINING_HORIZON_MS=4*60*60*1000;

export function cognitiveTrainingSampleRejectionReasons(row){
  const reasons=[];
  if(!row||typeof row!=='object'||Array.isArray(row)){
    return ['SAMPLE_NOT_OBJECT'];
  }
  if(row.training_eligible!==true)reasons.push('TRAINING_NOT_ELIGIBLE');
  if(row.historical_baseline!==true)reasons.push('HISTORICAL_BASELINE_NOT_CONFIRMED');
  if(row.target_definition!==TEMPORAL_TARGET_DEFINITION)reasons.push('TARGET_DEFINITION_MISMATCH');
  if(row.outcome_source!=='HISTORICAL_CLOSED_CANDLE_FIRST_PASSAGE_V1')
    reasons.push('OUTCOME_SOURCE_NOT_OFFICIAL_HISTORICAL_FIRST_PASSAGE');
  if(!['UP','DOWN','FLAT'].includes(row.outcome))reasons.push('OUTCOME_NOT_RESOLVED');
  if(!row.first_passage||typeof row.first_passage!=='object'){
    reasons.push('FIRST_PASSAGE_RECORD_MISSING');
  }else{
    if(row.first_passage.path_resolution!=='15M')
      reasons.push('FIRST_PASSAGE_RESOLUTION_NOT_15M');
    if(row.first_passage.outcome!==row.outcome)
      reasons.push('FIRST_PASSAGE_OUTCOME_MISMATCH');
  }
  // Preserve the original benchmark's exact Number(...) coercion semantics.
  const at=Number(row.at),resolvedAt=Number(row.resolved_at);
  if(resolvedAt-at!==COGNITIVE_TRAINING_HORIZON_MS)
    reasons.push('SAMPLE_RESOLVED_HORIZON_NOT_EXACTLY_4H');
  if(Number(row.horizon_ms)!==COGNITIVE_TRAINING_HORIZON_MS)
    reasons.push('DECLARED_HORIZON_NOT_EXACTLY_4H');

  const sequence=row.temporal_sequence;
  if(!Array.isArray(sequence)){
    reasons.push('TEMPORAL_SEQUENCE_MISSING');
  }else{
    if(sequence.length!==COGNITIVE_TRAINING_SEQUENCE_STEPS)
      reasons.push('TEMPORAL_SEQUENCE_STEP_COUNT_NOT_24');
    // Match the original every(...) predicate exactly, including JavaScript's
    // sparse-array semantics, so the diagnostic pass cannot change admission.
    if(!sequence.every(step=>Array.isArray(step)))
      reasons.push('TEMPORAL_SEQUENCE_STEP_NOT_ARRAY');
    if(!sequence.every(step=>Array.isArray(step)&&step.length===COGNITIVE_TRAINING_SEQUENCE_CHANNELS))
      reasons.push('TEMPORAL_SEQUENCE_CHANNEL_COUNT_NOT_29');
    if(!sequence.every(step=>Array.isArray(step)&&step.every(Number.isFinite)))
      reasons.push('TEMPORAL_SEQUENCE_CONTAINS_NON_FINITE_VALUE');
  }
  return reasons;
}

export function isValidCognitiveTrainingSample(row){
  return cognitiveTrainingSampleRejectionReasons(row).length===0;
}

function countMap(entries){
  return Object.fromEntries([...entries.entries()].sort((a,b)=>a[0].localeCompare(b[0])));
}

function rejectionSummary(row,reasons){
  const sequence=Array.isArray(row?.temporal_sequence)?row.temporal_sequence:[];
  const channelLengths=[...new Set(sequence.filter(Array.isArray).map(step=>step.length))].sort((a,b)=>a-b);
  return {
    id:String(row?.id||'').slice(0,180)||null,
    symbol:String(row?.symbol||'').slice(0,40)||null,
    at:Number.isFinite(Number(row?.at))?Number(row.at):null,
    resolved_at:Number.isFinite(Number(row?.resolved_at))?Number(row.resolved_at):null,
    outcome:String(row?.outcome||'').slice(0,16)||null,
    target_definition:String(row?.target_definition||'').slice(0,100)||null,
    outcome_source:String(row?.outcome_source||'').slice(0,100)||null,
    first_passage_path_resolution:String(row?.first_passage?.path_resolution||'').slice(0,16)||null,
    temporal_sequence_steps:sequence.length,
    temporal_sequence_channel_lengths:channelLengths,
    temporal_sequence_non_finite_values:sequence.reduce((sum,step)=>
      sum+(Array.isArray(step)?step.filter(value=>!Number.isFinite(value)).length:0),0),
    reasons:[...new Set(reasons)].sort()
  };
}

export function auditCognitiveTrainingSamples(rows){
  const input=Array.isArray(rows)?rows:[];
  const ids=new Set(),validRows=[],rejectedSamples=[];
  const reasonCounts=new Map(),rejectedBySymbol=new Map();
  let duplicates=0,missingIds=0,invalid=0,validSequences=0;
  const spacingBySymbol=new Map();
  const addReasons=(symbol,reasons)=>{
    for(const reason of reasons)reasonCounts.set(reason,(reasonCounts.get(reason)||0)+1);
    const key=String(symbol||'UNKNOWN_SYMBOL');
    const current=rejectedBySymbol.get(key)||{sample_count:0,reason_counts:new Map()};
    current.sample_count++;
    for(const reason of reasons)
      current.reason_counts.set(reason,(current.reason_counts.get(reason)||0)+1);
    rejectedBySymbol.set(key,current);
  };
  for(const row of input){
    const id=String(row?.id||'').trim();
    if(!id){
      duplicates++;
      missingIds++;
      const reasons=['SAMPLE_ID_MISSING'];
      rejectedSamples.push(rejectionSummary(row,reasons));
      addReasons(row?.symbol,reasons);
      continue;
    }
    if(ids.has(id)){
      duplicates++;
      const reasons=['DUPLICATE_SAMPLE_ID'];
      rejectedSamples.push(rejectionSummary(row,reasons));
      addReasons(row?.symbol,reasons);
      continue;
    }
    ids.add(id);
    const reasons=cognitiveTrainingSampleRejectionReasons(row);
    if(reasons.length){
      invalid++;
      rejectedSamples.push(rejectionSummary(row,reasons));
      addReasons(row?.symbol,reasons);
      continue;
    }
    validRows.push(row);
    validSequences++;
    const symbol=String(row.symbol);
    if(!spacingBySymbol.has(symbol))spacingBySymbol.set(symbol,[]);
    spacingBySymbol.get(symbol).push(Number(row.at));
  }
  let spacingViolations=0;
  for(const times of spacingBySymbol.values()){
    times.sort((a,b)=>a-b);
    for(let index=1;index<times.length;index++){
      if(times[index]-times[index-1]<COGNITIVE_TRAINING_HORIZON_MS)spacingViolations++;
    }
  }
  return {
    observed_rows:input.length,unique_ids:ids.size,missing_ids:missingIds,
    duplicate_ids:duplicates,invalid_samples:invalid,valid_samples:validRows.length,
    valid_temporal_sequences:validSequences,
    per_symbol_4h_spacing_violations:spacingViolations,
    rejection_reason_counts:countMap(reasonCounts),
    rejected_samples_by_symbol:Object.fromEntries([...rejectedBySymbol.entries()]
      .sort((a,b)=>a[0].localeCompare(b[0]))
      .map(([symbol,value])=>[symbol,{
        sample_count:value.sample_count,
        reason_counts:countMap(value.reason_counts)
      }])),
    rejected_samples:rejectedSamples.sort((a,b)=>
      Number(a.at??0)-Number(b.at??0)||String(a.symbol||'').localeCompare(String(b.symbol||''))||
      String(a.id||'').localeCompare(String(b.id||''))),
    outcome_counts:Object.fromEntries(['UP','DOWN','FLAT'].map(outcome=>[
      outcome,validRows.filter(row=>row.outcome===outcome).length
    ])),
    sample_month_counts:countMap(new Map([...validRows.reduce((map,row)=>{
      const month=new Date(Number(row.at)).toISOString().slice(0,7);
      map.set(month,(map.get(month)||0)+1);
      return map;
    },new Map()).entries() ])),
    symbols_with_samples:spacingBySymbol.size
  };
}

export function buildCognitiveTrainingRejectionJsonl(audit){
  const rows=Array.isArray(audit?.rejected_samples)?audit.rejected_samples:[];
  return rows.map(row=>JSON.stringify(row)).join('\n')+(rows.length?'\n':'');
}

export function buildCognitiveTrainingTensorJsonl(rows){
  const seen=new Set();
  const valid=(Array.isArray(rows)?rows:[]).filter(row=>{
    const id=String(row?.id||'').trim();
    if(!id||seen.has(id))return false;
    seen.add(id);
    return isValidCognitiveTrainingSample(row);
  });
  return valid.map(row=>{
    const sequenceJson=JSON.stringify(row.temporal_sequence);
    return JSON.stringify({
      id:String(row.id),
      symbol:String(row.symbol),
      at:Number(row.at),
      resolved_at:Number(row.resolved_at),
      target_definition:row.target_definition,
      outcome:row.outcome,
      sequence_steps:COGNITIVE_TRAINING_SEQUENCE_STEPS,
      sequence_channels:COGNITIVE_TRAINING_SEQUENCE_CHANNELS,
      temporal_sequence_sha256:createHash('sha256').update(sequenceJson).digest('hex'),
      temporal_sequence:row.temporal_sequence
    });
  }).join('\n')+(valid.length?'\n':'');
}
