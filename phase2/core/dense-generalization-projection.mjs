import {
  buildCognitiveFeatureVector,
  COGNITIVE_DAILY_FEATURE_SCHEMA,
  COGNITIVE_DAILY_FEATURE_NAMES
} from './cognitive-brain.mjs';
import {prepareDailyEarlyRiserCognitiveRow} from './daily-early-riser-neural-benchmark.mjs';
import {createHash} from 'node:crypto';

export const DENSE_GENERALIZATION_SCHEMA = 'RADARX_DENSE_24H_GENERALIZATION_V1';
export const DENSE_GENERALIZATION_DAY_MS = 24 * 60 * 60 * 1000;
export const DENSE_GENERALIZATION_INNER_MARGIN = 0.00025;
export const DENSE_GENERALIZATION_OUTER_MARGIN = 0.003;

const finite = value => {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const sigmoid = value => 1 / (1 + Math.exp(-clamp(value, -20, 20)));
const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const sha256Pattern = /^[a-f0-9]{64}$/i;

function hashRows(rows) {
  // Stable identity digest is supplemental to the raw-file SHA-256. It detects
  // reordering, duplication, and identity/label mutation after parsing.
  const canonical = rows.map(row => [
    row.id, row.symbol, row.at, row.resolved_at, row.outcome
  ]);
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export function validateAndPrepareDense24hRows(samples, censusReport, rawSampleSha256) {
  if (!Array.isArray(samples) || !samples.length) throw new Error('DENSE24_SAMPLES_EMPTY');
  if (!censusReport || !['READY','AUDITED_WITH_SURVIVOR_UNIVERSE_CAVEAT'].includes(censusReport.status))
    throw new Error('DENSE24_CENSUS_NOT_AUDITED');
  const quality = censusReport.data_quality || {};
  if (quality.all_sample_audits_ready !== true ||
      quality.no_overlapping_daily_labels !== true ||
      Number(quality.feature_cutoff_violations) !== 0 ||
      Number(quality.horizon_violations) !== 0 ||
      Number(quality.symbols_failed) !== 0 ||
      Number(quality.symbols_incomplete_archive) !== 0 ||
      Number(quality.archive_coverage_after_first_available_pct) !== 100) {
    throw new Error('DENSE24_CENSUS_QUALITY_GATE_FAILED');
  }
  const declared = censusReport.sample_file;
  if (!declared || Number(declared.rows) !== samples.length ||
      !sha256Pattern.test(String(declared.sha256 || '')) ||
      String(declared.sha256).toLowerCase() !== String(rawSampleSha256).toLowerCase()) {
    throw new Error('DENSE24_RAW_SHA_OR_ROW_COUNT_MISMATCH');
  }
  if (!sha256Pattern.test(String(rawSampleSha256 || ''))) throw new Error('DENSE24_RAW_SHA_INVALID');

  const rows = [];
  const seen = new Set();
  const perSymbol = new Map();
  const rejectionReasons = {};
  let ambiguous = 0;
  let underFloor = 0;
  for (let index = 0; index < samples.length; index++) {
    const sample = samples[index];
    if (!sample || typeof sample !== 'object') throw new Error('DENSE24_SAMPLE_INVALID:' + index);
    const quoteVolume = finite(sample.quote_volume_24h);
    if (sample.liquidity_lane !== 'STANDARD_750K_PLUS' ||
        quoteVolume === null || quoteVolume < 750000) {
      underFloor++;
      throw new Error('DENSE24_LIQUIDITY_FLOOR_VIOLATION:' + index);
    }
    const label = sample.safe_opportunity_targets?.['24h']?.plus_5_pct;
    if (!label) throw new Error('DENSE24_SAFE_LABEL_MISSING:' + index);
    if (label.status === 'AMBIGUOUS' && label.outcome === 'AMBIGUOUS') {
      ambiguous++;
      continue; // Audited but never converted to a supervised class.
    }
    if (label.status !== 'RESOLVED' || !['UP','DOWN','FLAT'].includes(label.outcome)) {
      const reason = 'UNRESOLVED_OR_INVALID_LABEL';
      rejectionReasons[reason] = (rejectionReasons[reason] || 0) + 1;
      throw new Error('DENSE24_LABEL_NOT_TRAINABLE:' + index);
    }
    if (Number(label.horizon_ms) !== DENSE_GENERALIZATION_DAY_MS ||
        label.target_definition !== 'FIRST_TOUCH_PLUS_5_PCT_BEFORE_MINUS_2_PCT_WITHIN_24H_15M_V1' ||
        label.outcome_source !== 'BINANCE_OFFICIAL_CLOSED_15M_SAFE_FIRST_TOUCH_HORIZONS_V1') {
      throw new Error('DENSE24_LABEL_CONTRACT_MISMATCH:' + index);
    }
    if (Number(sample.feature_information_cutoff_at) !== Number(sample.at) ||
        sample.observation_source !== 'BINANCE_OFFICIAL_CLOSED_15M_BASELINE') {
      throw new Error('DENSE24_FEATURE_CUTOFF_MISMATCH:' + index);
    }
    const prepared = prepareDailyEarlyRiserCognitiveRow(sample, 5, {
      labelMode: 'safe_opportunity', horizonHours: 24
    });
    if (!prepared.row) throw new Error('DENSE24_PREPARATION_REJECTED:' + (prepared.reason || 'UNKNOWN'));
    const row = prepared.row;
    if (row.resolved_at - row.at !== DENSE_GENERALIZATION_DAY_MS ||
        row.horizon_ms !== DENSE_GENERALIZATION_DAY_MS) {
      throw new Error('DENSE24_RESOLUTION_HORIZON_MISMATCH:' + index);
    }
    const vector = buildCognitiveFeatureVector(row.features, COGNITIVE_DAILY_FEATURE_SCHEMA);
    if (vector.length !== COGNITIVE_DAILY_FEATURE_NAMES.length ||
        vector.some(value => !Number.isFinite(value))) {
      throw new Error('DENSE24_FEATURE_VECTOR_INVALID:' + index);
    }
    const symbol = String(row.symbol).trim().toUpperCase();
    const identity = symbol + ':' + String(row.at);
    if (seen.has(identity)) throw new Error('DENSE24_DUPLICATE_SYMBOL_BASELINE:' + identity);
    seen.add(identity);
    if (!perSymbol.has(symbol)) perSymbol.set(symbol, []);
    perSymbol.get(symbol).push(Number(row.at));
    rows.push({
      id: row.id, symbol, at: Number(row.at), resolved_at: Number(row.resolved_at),
      outcome: row.outcome, target: row.outcome === 'UP' ? 1 : 0,
      features: row.features, vector, quote_volume_24h: quoteVolume
    });
  }
  if (underFloor) throw new Error('DENSE24_UNDER_FLOOR_ROWS_PRESENT');
  for (const [symbol, times] of perSymbol) {
    times.sort((a,b) => a-b);
    for (let i=1;i<times.length;i++) {
      if (times[i] - times[i-1] < DENSE_GENERALIZATION_DAY_MS)
        throw new Error('DENSE24_SYMBOL_ANCHOR_OVERLAP:' + symbol);
    }
  }
  rows.sort((a,b) => a.at-b.at || a.symbol.localeCompare(b.symbol) || a.id.localeCompare(b.id));
  if (rows.length < 1000) throw new Error('DENSE24_RESOLVED_COHORT_TOO_SMALL:' + rows.length);
  const unique = new Set(rows.map(row => row.symbol + ':' + row.at));
  if (unique.size !== rows.length) throw new Error('DENSE24_IDENTITY_DUPLICATION_AFTER_SORT');
  return {
    rows, ambiguous_rows: ambiguous, under_floor_rows: underFloor,
    rejection_reasons: rejectionReasons,
    identity_sha256: hashRows(rows),
    raw_sample_sha256: rawSampleSha256,
    raw_rows: samples.length,
    resolved_training_rows: rows.length
  };
}

export function splitDense24hChronologically(rows) {
  if (!Array.isArray(rows) || rows.length < 1000) throw new Error('DENSE24_SPLIT_INPUT_TOO_SMALL');
  const days = [...new Set(rows.map(row => Math.floor(row.at / DENSE_GENERALIZATION_DAY_MS) * DENSE_GENERALIZATION_DAY_MS))]
    .sort((a,b) => a-b);
  if (days.length < 60) throw new Error('DENSE24_REQUIRES_60_UNIQUE_UTC_DAYS');
  const b1 = days[Math.floor(days.length * 0.60)];
  const b2 = days[Math.floor(days.length * 0.75)];
  const b3 = days[Math.floor(days.length * 0.88)];
  const day = DENSE_GENERALIZATION_DAY_MS;
  const train = rows.filter(row => row.at < b1 - day);
  const selection = rows.filter(row => row.at >= b1 + day && row.at < b2 - day);
  const validation = rows.filter(row => row.at >= b2 + day && row.at < b3 - day);
  const holdout = rows.filter(row => row.at >= b3 + day);
  const kept = train.length + selection.length + validation.length + holdout.length;
  const purged = rows.length - kept;
  const partitions = [
    ['train',train],['selection',selection],['validation',validation],['holdout',holdout]
  ];
  for (let i=0;i<partitions.length;i++) {
    const [name,part] = partitions[i];
    if (part.length < 100) throw new Error('DENSE24_SPLIT_SUPPORT_TOO_SMALL:' + name + ':' + part.length);
    const positives=part.filter(row=>row.target===1).length;
    const negatives=part.length-positives;
    if (positives<20||negatives<20) throw new Error('DENSE24_SPLIT_CLASS_SUPPORT_TOO_SMALL:'+name+':'+positives+':'+negatives);
    if (part.some(row => !Number.isFinite(row.target) || !Number.isFinite(row.at))) {
      throw new Error('DENSE24_SPLIT_NON_FINITE:' + name);
    }
  }
  for (let i=1;i<partitions.length;i++) {
    const previous = partitions[i-1][1], current = partitions[i][1];
    const latestResolved = previous.reduce((latest,row)=>Math.max(latest,row.resolved_at),-Infinity);
    const earliestNext = current.reduce((earliest,row)=>Math.min(earliest,row.at),Infinity);
    if (latestResolved >= earliestNext) {
      throw new Error('DENSE24_LABEL_MATURITY_CROSSES_SPLIT:' + partitions[i][0]);
    }
  }
  return {
    train, selection, validation, holdout,
    purged_rows: purged,
    boundaries: {
      selection_after_utc: new Date(b1 + day).toISOString(),
      validation_after_utc: new Date(b2 + day).toISOString(),
      holdout_after_utc: new Date(b3 + day).toISOString()
    },
    ranges: Object.fromEntries(partitions.map(([name,part]) => [name,{
      rows:part.length,
      first_at:new Date(part.reduce((value,row)=>Math.min(value,row.at),Infinity)).toISOString(),
      last_at:new Date(part.reduce((value,row)=>Math.max(value,row.at),-Infinity)).toISOString(),
      positives:part.filter(row=>row.target===1).length,
      negatives:part.filter(row=>row.target===0).length
    }]))
  };
}

export function fitDenseStandardizer(trainingRows) {
  if (!trainingRows?.length) throw new Error('DENSE24_STANDARDIZER_TRAINING_EMPTY');
  const dimension = trainingRows[0].vector.length;
  const means = Array(dimension).fill(0);
  const variances = Array(dimension).fill(0);
  for (const row of trainingRows) {
    if (row.vector.length !== dimension || row.vector.some(value=>!Number.isFinite(value)))
      throw new Error('DENSE24_STANDARDIZER_SHAPE_MISMATCH');
    for (let j=0;j<dimension;j++) means[j] += row.vector[j];
  }
  for (let j=0;j<dimension;j++) means[j] /= trainingRows.length;
  for (const row of trainingRows) for (let j=0;j<dimension;j++)
    variances[j] += (row.vector[j]-means[j])**2;
  const scales = variances.map(value => Math.max(1e-3, Math.sqrt(value / Math.max(1,trainingRows.length-1))));
  return {means,scales,fit_rows:trainingRows.length,fit_boundary:'TRAIN_ONLY'};
}
function transformVector(vector, scaler) {
  return vector.map((value,index)=>clamp((value-scaler.means[index])/scaler.scales[index],-8,8));
}
function logit(p) { const q=clamp(p,1e-5,1-1e-5); return Math.log(q/(1-q)); }

export function fitDenseLogisticAnchor(trainingRows, scaler, {
  iterations=500, learningRate=0.06, l2=0.08
}={}) {
  if (!trainingRows?.length) throw new Error('DENSE24_LOGISTIC_TRAINING_EMPTY');
  const rows=trainingRows.map(row=>({x:transformVector(row.vector,scaler),y:row.target}));
  const d=rows[0].x.length;
  const positives=rows.filter(row=>row.y===1).length;
  const baseRate=(positives+2)/(rows.length+4);
  const weights=Array(d).fill(0);
  let intercept=logit(baseRate);
  const steps=Math.max(100,Math.min(1200,Math.trunc(iterations)));
  const rate=clamp(learningRate,0.005,0.2);
  const reg=clamp(l2,0.001,1);
  const n=rows.length;
  for(let step=0;step<steps;step++){
    const gradients=Array(d).fill(0);
    let biasGradient=0,loss=0;
    for(const row of rows){
      let z=intercept;
      for(let j=0;j<d;j++)z+=weights[j]*row.x[j];
      const p=sigmoid(z);
      const error=p-row.y;
      loss+=(p-row.y)**2;
      const g=2*error*p*(1-p);
      biasGradient+=g;
      for(let j=0;j<d;j++)gradients[j]+=g*row.x[j];
    }
    intercept-=rate*biasGradient/n;
    for(let j=0;j<d;j++)weights[j]-=rate*(gradients[j]/n+reg*weights[j]);
    if(!Number.isFinite(loss)||weights.some(value=>!Number.isFinite(value))||!Number.isFinite(intercept))
      throw new Error('DENSE24_LOGISTIC_NON_FINITE');
  }
  return {kind:'DENSE24_LOGISTIC_BRIER_ANCHOR_V1',weights,intercept,base_rate:baseRate,
    feature_count:d,training_rows:n,l2:reg,iterations:steps,scaler};
}
function logisticLogit(x, fit) {
  let z=fit.intercept;
  for(let j=0;j<x.length;j++)z+=fit.weights[j]*x[j];
  return z;
}

function zerosMatrix(rows,cols) { return Array.from({length:rows},()=>Array(cols).fill(0)); }
function zerosVector(size) { return Array(size).fill(0); }
function mulberry32(seed) {
  let state=seed>>>0;
  return ()=>{state+=0x6D2B79F5;let t=state;t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);return ((t^(t>>>14))>>>0)/4294967296;};
}
function adamVector(params,grads,state,step,rate,l2,decay=true) {
  for(let j=0;j<params.length;j++){
    const g=clamp(grads[j],-5,5);
    state.m[j]=0.9*state.m[j]+0.1*g;
    state.v[j]=0.999*state.v[j]+0.001*g*g;
    const mh=state.m[j]/(1-Math.pow(0.9,step));
    const vh=state.v[j]/(1-Math.pow(0.999,step));
    const decayed=decay?params[j]*(1-rate*l2):params[j];
    params[j]=decayed-rate*mh/(Math.sqrt(vh)+1e-8);
  }
}
function adamMatrix(params,grads,state,step,rate,l2,decay=true) {
  for(let i=0;i<params.length;i++) adamVector(params[i],grads[i],state[i],step,rate,l2,decay);
}
function cloneModel(m) {
  return {
    W:m.W.map(row=>[...row]),b:[...m.b],gamma:[...m.gamma],beta:[...m.beta],
    U:m.U.map(row=>[...row]),head:[...m.head],cross:[...m.cross]
  };
}

function forwardProjection(x,model,anchor,dropout=0,mask=null) {
  const h=model.b.map((bias,k)=>{
    let z=bias;
    for(let j=0;j<x.length;j++)z+=x[j]*model.W[j][k];
    return Math.tanh(z);
  });
  const avg=mean(h);
  const variance=mean(h.map(value=>(value-avg)**2));
  const inv=1/Math.sqrt((variance??0)+1e-5);
  const norm=h.map((value,k)=>((value-(avg??0))*inv)*model.gamma[k]+model.beta[k]);
  const dropped=norm.map((value,k)=>mask ? value*mask[k]/(1-dropout) : value);
  const sums=Array(model.cross.length).fill(0),squares=Array(model.cross.length).fill(0);
  for(let j=0;j<x.length;j++)for(let k=0;k<model.cross.length;k++){
    const v=model.U[j][k]*x[j];
    sums[k]+=v;squares[k]+=v*v;
  }
  const interactions=sums.map((value,k)=>0.5*(value*value-squares[k]));
  let residual=0;
  for(let k=0;k<dropped.length;k++)residual+=model.head[k]*dropped[k];
  for(let k=0;k<interactions.length;k++)residual+=model.cross[k]*interactions[k];
  const logitValue=logisticLogit(x,anchor)+residual;
  return {probability:sigmoid(logitValue),h,norm,dropped,sums,interactions,inv,logit:logitValue};
}

export function predictDenseProjectionProbability(vector,fit) {
  const x=transformVector(vector,fit.scaler);
  return forwardProjection(x,fit.model,fit.anchor,0,null).probability;
}

export function fitDenseGeneralizationProjection(trainingRows,anchor,scaler,{
  dropout=0.15,l2=0.06,rank=6,hidden=12,epochs=36,seed=1337,learningRate=0.008
}={}) {
  if(!trainingRows?.length)throw new Error('DENSE24_PROJECTION_TRAINING_EMPTY');
  const pDrop=clamp(dropout,0,0.45),reg=clamp(l2,0.001,0.5);
  const rankSize=Math.max(2,Math.min(12,Math.trunc(rank)));
  const hiddenSize=Math.max(6,Math.min(24,Math.trunc(hidden)));
  const steps=Math.max(10,Math.min(100,Math.trunc(epochs)));
  const rate=clamp(learningRate,0.001,0.03);
  const X=trainingRows.map(row=>transformVector(row.vector,scaler));
  const Y=trainingRows.map(row=>row.target);
  const d=X[0].length,n=X.length;
  const rng=mulberry32(seed);
  const model={
    W:Array.from({length:d},()=>Array.from({length:hiddenSize},()=>((rng()-0.5)*0.10))),
    b:Array.from({length:hiddenSize},()=>0),
    gamma:Array(hiddenSize).fill(1),beta:Array(hiddenSize).fill(0),
    U:Array.from({length:d},()=>Array.from({length:rankSize},()=>((rng()-0.5)*0.06))),
    head:Array.from({length:hiddenSize},()=>((rng()-0.5)*0.04)),
    cross:Array.from({length:rankSize},()=>((rng()-0.5)*0.04))
  };
  const g={W:zerosMatrix(d,hiddenSize),b:zerosVector(hiddenSize),
    gamma:zerosVector(hiddenSize),beta:zerosVector(hiddenSize),
    U:zerosMatrix(d,rankSize),head:zerosVector(hiddenSize),cross:zerosVector(rankSize)};
  const state={
    W:Array.from({length:d},()=>({m:zerosVector(hiddenSize),v:zerosVector(hiddenSize)})),
    b:{m:zerosVector(hiddenSize),v:zerosVector(hiddenSize)},
    gamma:{m:zerosVector(hiddenSize),v:zerosVector(hiddenSize)},
    beta:{m:zerosVector(hiddenSize),v:zerosVector(hiddenSize)},
    U:Array.from({length:d},()=>({m:zerosVector(rankSize),v:zerosVector(rankSize)})),
    head:{m:zerosVector(hiddenSize),v:zerosVector(hiddenSize)},
    cross:{m:zerosVector(rankSize),v:zerosVector(rankSize)}
  };
  const patience=8,minEpochs=Math.min(15,steps),history=[];
  let bestObjective=Infinity,bestEpoch=0,wait=0,best=null,stoppedEarly=false;
  for(let epoch=1;epoch<=steps;epoch++){
    for(const key of ['W','b','gamma','beta','U','head','cross']){
      if(Array.isArray(g[key][0]))for(const row of g[key])row.fill(0);
      else g[key].fill(0);
    }
    let objective=0;
    for(let i=0;i<n;i++){
      const mask=Array.from({length:hiddenSize},()=>rng()>=pDrop?1:0);
      const out=forwardProjection(X[i],model,anchor,pDrop,mask);
      const y=Y[i],p=clamp(out.probability,1e-8,1-1e-8);
      objective+=(p-y)**2;
      const dz=2*(p-y)*p*(1-p);
      for(let k=0;k<hiddenSize;k++)g.head[k]+=dz*out.dropped[k];
      for(let k=0;k<rankSize;k++)g.cross[k]+=dz*out.interactions[k];

      // Backprop through inverted dropout and trainable per-row LayerNorm.
      const dNorm=out.norm.map((_,k)=>dz*model.head[k]*mask[k]/(1-pDrop));
      const hMean=mean(out.h)??0;
      const hNorm=out.h.map(value=>(value-hMean)*out.inv);
      for(let k=0;k<hiddenSize;k++){
        g.gamma[k]+=dNorm[k]*hNorm[k];
        g.beta[k]+=dNorm[k];
      }
      const dNorm0=dNorm.map((value,k)=>value*model.gamma[k]);
      const meanD=mean(dNorm0)??0;
      const meanDZ=mean(dNorm0.map((value,k)=>value*hNorm[k]))??0;
      const dH=dNorm0.map((value,k)=>out.inv*(value-meanD-hNorm[k]*meanDZ));
      const dPre=dH.map((value,k)=>value*(1-out.h[k]*out.h[k]));
      for(let j=0;j<d;j++)for(let k=0;k<hiddenSize;k++)g.W[j][k]+=X[i][j]*dPre[k];
      for(let k=0;k<hiddenSize;k++)g.b[k]+=dPre[k];
      for(let k=0;k<rankSize;k++){
        const crossError=dz*model.cross[k];
        for(let j=0;j<d;j++)g.U[j][k]+=crossError*X[i][j]*(out.sums[k]-model.U[j][k]*X[i][j]);
      }
    }
    const objectiveMean=objective/n;
    for(const key of ['W','b','gamma','beta','U','head','cross']){
      if(Array.isArray(model[key][0])){
        const scale=1/n;
        for(const row of g[key])for(let j=0;j<row.length;j++)row[j]*=scale;
      }else for(let j=0;j<g[key].length;j++)g[key][j]/=n;
    }
    if(!Number.isFinite(objectiveMean)||Object.values(g).some(value=>
      Array.isArray(value[0])?value.flat().some(x=>!Number.isFinite(x)):value.some(x=>!Number.isFinite(x))))
      throw new Error('DENSE24_PROJECTION_NON_FINITE_GRADIENT');
    if(objectiveMean<bestObjective-1e-9){
      bestObjective=objectiveMean;bestEpoch=epoch;wait=0;best=cloneModel(model);
    }else wait++;
    const normSquared=Object.values(g).reduce((sum,value)=>sum+
      (Array.isArray(value[0])?value.flat():value).reduce((s,x)=>s+x*x,0),0);
    const gradNorm=Math.sqrt(normSquared);
    const clip=gradNorm>1?1/gradNorm:1;
    for(const key of ['W','U']){
      for(const row of g[key])for(let j=0;j<row.length;j++)row[j]*=clip;
    }
    for(const key of ['b','gamma','beta','head','cross'])for(let j=0;j<g[key].length;j++)g[key][j]*=clip;
    const lr=rate*(0.10+0.90*0.5*(1+Math.cos(Math.PI*(epoch-1)/Math.max(1,steps-1))));
    const matState=(key)=>state[key].map(x=>({m:x.m,v:x.v}));
    for(const key of ['W','U']){
      for(let i=0;i<model[key].length;i++){
        const st=state[key][i];
        adamVector(model[key][i],g[key][i],st,epoch,lr,reg,true);
      }
    }
    for(const key of ['b','gamma','beta','head','cross']){
      adamVector(model[key],g[key],state[key],epoch,lr,reg,
        key==='head'||key==='cross'||key==='gamma');
    }
    history.push({epoch,training_brier:Number(objectiveMean.toFixed(8)),
      gradient_l2_norm:Number(gradNorm.toFixed(8)),learning_rate:Number(lr.toFixed(8)),
      dropout:pDrop,l2:reg});
    if(epoch>=minEpochs&&wait>=patience){stoppedEarly=true;break;}
  }
  if(!best)throw new Error('DENSE24_PROJECTION_CHECKPOINT_MISSING');
  for(const key of Object.keys(model)) {
    if(Array.isArray(best[key][0]))for(let i=0;i<model[key].length;i++)model[key][i]=[...best[key][i]];
    else model[key]=[...best[key]];
  }
  const finiteParameters=[...model.W.flat(),...model.b,...model.gamma,...model.beta,
    ...model.U.flat(),...model.head,...model.cross].every(Number.isFinite);
  if(!finiteParameters)throw new Error('DENSE24_PROJECTION_NON_FINITE_PARAMETER');
  return {
    kind:'DENSE24_LAYER_NORM_LOW_RANK_PROJECTION_RESIDUAL_V1',
    model,anchor,scaler,dropout:pDrop,l2:reg,rank:rankSize,hidden:hiddenSize,
    training_rows:n,training_positives:Y.filter(y=>y===1).length,
    training_negatives:Y.filter(y=>y===0).length,
    epochs_completed:history.length,best_epoch:bestEpoch,
    best_training_brier:Number(bestObjective.toFixed(8)),
    optimizer:'ADAMW_DECOUPLED_WEIGHT_DECAY',
    normalization:'PER_SAMPLE_LAYER_NORM_TRAINED_ON_TRAIN_ROWS_ONLY',
    dropout_mode:'TRAIN_ONLY_DETERMINISTIC_INVERTED_DROPOUT',
    projection:'35_TO_12_TANH_LAYER_NORM_PLUS_RANK6_PAIRWISE_FACTOR_CROSSES',
    residual_anchor:'FROZEN_SAME_TRAINING_ROWS_LOGISTIC',
    early_stopping:{monitor:'TRAINING_OBJECTIVE_ONLY',patience,
      stopped_early:stoppedEarly,restored_best_checkpoint:true,
      validation_or_holdout_used:false},
    training_history:history
  };
}

function brier(rows,predictions) {
  return mean(rows.map((row,index)=>(predictions[index]-row.target)**2));
}
function asymmetricRiskBrier(rows,predictions) {
  let total=0;
  for(let i=0;i<rows.length;i++){
    const error=(predictions[i]-rows[i].target)**2;
    const falseConfidence=rows[i].target===0&&predictions[i]>=0.70;
    total+=error*(falseConfidence?3:1);
  }
  return total/Math.max(1,rows.length);
}
function ece(rows,predictions) {
  const bins=Array.from({length:10},()=>({n:0,p:0,y:0}));
  for(let i=0;i<rows.length;i++){
    const bin=bins[Math.min(9,Math.floor(predictions[i]*10))];
    bin.n++;bin.p+=predictions[i];bin.y+=rows[i].target;
  }
  return bins.reduce((sum,bin)=>sum+(bin.n/Math.max(1,rows.length))*
    (bin.n?Math.abs(bin.p/bin.n-bin.y/bin.n):0),0);
}
function logLoss(rows,predictions) {
  return mean(rows.map((row,index)=>{
    const p=clamp(predictions[index],1e-9,1-1e-9);
    return -(row.target*Math.log(p)+(1-row.target)*Math.log(1-p));
  }));
}
function falseConfidence(rows,predictions) {
  const negatives=rows.filter(row=>row.target===0).length;
  const falseHigh=rows.filter((row,index)=>row.target===0&&predictions[index]>=0.8).length;
  return {negative_rows:negatives,false_high_confidence_rows:falseHigh,
    false_high_confidence_rate_pct:negatives?Number((falseHigh/negatives*100).toFixed(4)):null};
}
function dateClusters(rows,predictions,baselinePredictions) {
  const map=new Map();
  for(let i=0;i<rows.length;i++){
    const key=new Date(rows[i].at).toISOString().slice(0,10);
    if(!map.has(key))map.set(key,{model:[],baseline:[]});
    const group=map.get(key);
    group.model.push((predictions[i]-rows[i].target)**2);
    group.baseline.push((baselinePredictions[i]-rows[i].target)**2);
  }
  return [...map.values()];
}
function bootstrapImprovement(rows,predictions,baselinePredictions,{iterations=400,seed=91}={}) {
  const clusters=dateClusters(rows,predictions,baselinePredictions);
  if(clusters.length<10)return {evaluated:false,reason:'FEWER_THAN_10_UTC_DAY_CLUSTERS',clusters:clusters.length};
  const rng=mulberry32(seed),values=[];
  for(let r=0;r<iterations;r++){
    let m=0,b=0,n=0;
    for(let j=0;j<clusters.length;j++){
      const group=clusters[Math.floor(rng()*clusters.length)];
      for(let k=0;k<group.model.length;k++){m+=group.model[k];b+=group.baseline[k];n++;}
    }
    if(n)values.push((b-m)/n);
  }
  values.sort((a,b)=>a-b);
  const q=(p)=>values[Math.min(values.length-1,Math.floor((values.length-1)*p))];
  return {evaluated:true,clusters:clusters.length,iterations:values.length,
    improvement_ci95_low:Number(q(0.025).toFixed(6)),
    improvement_ci95_high:Number(q(0.975).toFixed(6))};
}

export function evaluateDenseProjectionSplit(rows,fit,baselineFit,{bootstrapSeed=91}={}) {
  const predictions=rows.map(row=>predictDenseProjectionProbability(row.vector,fit));
  const baselinePredictions=rows.map(row=>{
    const x=transformVector(row.vector,baselineFit.scaler);
    return sigmoid(logisticLogit(x,baselineFit));
  });
  if(predictions.some(value=>!Number.isFinite(value))||baselinePredictions.some(value=>!Number.isFinite(value)))
    throw new Error('DENSE24_OOS_NON_FINITE_PREDICTION');
  const modelBrier=brier(rows,predictions),baselineBrier=brier(rows,baselinePredictions);
  const modelRisk=asymmetricRiskBrier(rows,predictions);
  const baselineRisk=asymmetricRiskBrier(rows,baselinePredictions);
  const improvement=baselineBrier-modelBrier;
  const ci=bootstrapImprovement(rows,predictions,baselinePredictions,{seed:bootstrapSeed});
  return {
    rows:rows.length,positives:rows.filter(row=>row.target===1).length,
    negatives:rows.filter(row=>row.target===0).length,
    model_brier:Number(modelBrier.toFixed(6)),
    logistic_brier:Number(baselineBrier.toFixed(6)),
    brier_improvement:Number(improvement.toFixed(6)),
    model_log_loss:Number(logLoss(rows,predictions).toFixed(6)),
    logistic_log_loss:Number(logLoss(rows,baselinePredictions).toFixed(6)),
    model_ece:Number(ece(rows,predictions).toFixed(6)),
    logistic_ece:Number(ece(rows,baselinePredictions).toFixed(6)),
    asymmetric_risk_brier_model:Number(modelRisk.toFixed(6)),
    asymmetric_risk_brier_logistic:Number(baselineRisk.toFixed(6)),
    false_confidence_model:falseConfidence(rows,predictions),
    false_confidence_logistic:falseConfidence(rows,baselinePredictions),
    bootstrap_utc_day_cluster_ci95:ci,
    required_brier_margin:DENSE_GENERALIZATION_OUTER_MARGIN,
    passed:improvement>DENSE_GENERALIZATION_OUTER_MARGIN&&ci.evaluated===true&&
      ci.improvement_ci95_low>0&&modelRisk<=baselineRisk+1e-9
  };
}

export function runDenseGeneralizationBenchmark(preparedRows,split,{bootstrapIterations=400}={}) {
  const train=split.train,selection=split.selection,validation=split.validation,holdout=split.holdout;
  const scaler=fitDenseStandardizer(train);
  const anchor=fitDenseLogisticAnchor(train,scaler);
  const configs=[
    {name:'DROP10_L2_003',dropout:0.10,l2:0.03,rank:6,hidden:12,epochs:36,seed:101},
    {name:'DROP25_L2_010',dropout:0.25,l2:0.10,rank:6,hidden:12,epochs:36,seed:211}
  ];
  const candidates=configs.map((config,index)=>{
    const fit=fitDenseGeneralizationProjection(train,anchor,scaler,config);
    const preds=selection.map(row=>predictDenseProjectionProbability(row.vector,fit));
    const logisticPreds=selection.map(row=>sigmoid(logisticLogit(transformVector(row.vector,scaler),anchor)));
    const modelScore=brier(selection,preds),baselineScore=brier(selection,logisticPreds);
    return {name:config.name,config,fit,selection_brier:Number(modelScore.toFixed(6)),
      logistic_selection_brier:Number(baselineScore.toFixed(6)),
      selection_improvement:Number((baselineScore-modelScore).toFixed(6))};
  }).sort((a,b)=>a.selection_brier-b.selection_brier||a.name.localeCompare(b.name));
  const winner=candidates[0];
  const selectionPassed=winner.selection_improvement>DENSE_GENERALIZATION_INNER_MARGIN;
  const validationResult=evaluateDenseProjectionSplit(validation,winner.fit,anchor,{bootstrapSeed:7001,bootstrapIterations});
  const holdoutResult=evaluateDenseProjectionSplit(holdout,winner.fit,anchor,{bootstrapSeed:9001,bootstrapIterations});
  const finalGate=selectionPassed&&validationResult.passed&&holdoutResult.passed;
  return {
    schema:DENSE_GENERALIZATION_SCHEMA,
    target:'SAFE_FIRST_TOUCH_PLUS_5_BEFORE_MINUS_2_WITHIN_24H',
    feature_schema:COGNITIVE_DAILY_FEATURE_SCHEMA,
    feature_count:COGNITIVE_DAILY_FEATURE_NAMES.length,
    model:'LAYER_NORM_DROPOUT_LOW_RANK_INTERACTION_RESIDUAL_MLP',
    configs_evaluated:candidates.map(({name,config,selection_brier,logistic_selection_brier,selection_improvement})=>({
      name,config,selection_brier,logistic_selection_brier,selection_improvement
    })),
    selected_configuration:winner.name,
    inner_selection:{
      logistic_brier:winner.logistic_selection_brier,
      model_brier:winner.selection_brier,
      improvement:winner.selection_improvement,
      required_margin:DENSE_GENERALIZATION_INNER_MARGIN,
      passed:selectionPassed
    },
    validation:validationResult,
    holdout:holdoutResult,
    gate:{
      predictive_superiority_verified:finalGate,
      inner_selection_passed:selectionPassed,
      validation_passed:validationResult.passed,
      holdout_passed:holdoutResult.passed,
      required_outer_margin:DENSE_GENERALIZATION_OUTER_MARGIN,
      real_order_execution:false,production_touched:false,deployed:false,merged:false
    },
    training:{
      train_rows:train.length,selection_rows:selection.length,
      model_fit_rows:train.length,
      validation_rows:validation.length,holdout_rows:holdout.length,
      feature_scaler_fit_on:'TRAIN_ONLY',
      logistic_fit_on:'TRAIN_ONLY',
      model_fit_on:'TRAIN_ONLY',
      selection_used_for:'PREDECLARED_TWO_CONFIG_MODEL_CHOICE_ONLY',
      validation_used_for:'OUTER_ACCEPTANCE_ONLY',
      holdout_used_for:'FINAL_UNTOUCHED_ACCEPTANCE_ONLY',
      validation_or_holdout_used_for_gradient_updates:false,
      dropout_train_only:true,layer_norm_per_sample:true,
      no_batch_norm_running_statistics:true
    },
    status:finalGate?'RESEARCH_OOS_SUPERIORITY_PASSED':'RESEARCH_OOS_SUPERIORITY_NOT_VERIFIED'
  };
}
