import test from 'node:test';
import assert from 'node:assert/strict';
import {EarlyExpansionRadar,EARLY_EXPANSION_RADAR_DEFAULTS} from '../core/early-expansion-radar.mjs';
import {RestClient} from '../market/binance-rest.mjs';
import {DurableStore} from '../core/store.mjs';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

function baselineHasFiniteNumber(v){return v!==null&&v!==undefined&&!(typeof v==='string'&&v.trim()==='')&&Number.isFinite(Number(v));}
function baselineMove(row){return baselineHasFiniteNumber(row?.priceChange24h)?Math.abs(Number(row.priceChange24h)):null;}
function baselineSymbol(item){return String(item?.symbol??item?.row?.symbol??'').trim().toUpperCase();}
function baselineClamp(v,lo=0,hi=100){return Math.max(lo,Math.min(hi,Number.isFinite(Number(v))?Number(v):0));}
function baselineSymbolHash(symbol){
  let h=2166136261>>>0;
  for(const ch of String(symbol||'')){h^=ch.charCodeAt(0);h=Math.imul(h,16777619);}
  return h>>>0;
}
function baselineQuietDeepRank(item,cfg){
  const row=item?.row,move=baselineMove(row),fp=item?.micro_fingerprint;
  if(move===null||move>Number(cfg.maxQuiet24hMovePct??8)||!fp||!baselineHasFiniteNumber(fp.score))return null;
  const m=fp.metrics||{},c=fp.category_scores||{};
  const rv1=baselineHasFiniteNumber(m.rvol_1m)?Number(m.rvol_1m):null;
  const rv5=baselineHasFiniteNumber(m.rvol_5m)?Number(m.rvol_5m):null;
  const tr1=baselineHasFiniteNumber(m.trade_rvol_1m)?Number(m.trade_rvol_1m):null;
  const participation=Math.max(
    baselineHasFiniteNumber(c.participation)?Number(c.participation):0,
    baselineHasFiniteNumber(c.tradeParticipation)?Number(c.tradeParticipation):0,
    rv1!==null?baselineClamp(50+Math.max(0,rv1-1)*18):0,
    rv5!==null?baselineClamp(50+Math.max(0,rv5-1)*12):0,
    tr1!==null?baselineClamp(50+Math.max(0,tr1-1)*20):0
  );
  const structure=Math.max(baselineHasFiniteNumber(c.structure)?Number(c.structure):0,
    baselineHasFiniteNumber(m.higher_low_count)?Number(m.higher_low_count):0);
  const bb=baselineHasFiniteNumber(m.bb_ratio)?Number(m.bb_ratio):null;
  const range=baselineHasFiniteNumber(m.range_compression_ratio)?Number(m.range_compression_ratio):null;
  const atr=baselineHasFiniteNumber(m.atr_ratio)?Number(m.atr_ratio):null;
  const compression=Math.max(baselineHasFiniteNumber(c.compression)?Number(c.compression):0,
    bb!==null&&bb<=.90?78:0,range!==null&&range<=.90?72:0,atr!==null&&atr<=.92?70:0);
  const resistance=baselineHasFiniteNumber(m.resistance_distance_pct)?Number(m.resistance_distance_pct):null;
  const resistanceNear=resistance!==null&&resistance>=-5&&resistance<=1.5;
  if(participation<Number(cfg.quietDeepMinParticipationScore??58)||
    !(compression>=65||structure>=62||resistanceNear))return null;
  return (100-move*6)*.35+participation*.25+structure*.20+compression*.20;
}
function baselineExceptionalDeep(item,cfg){
  const move=baselineMove(item?.row),fp=item?.micro_fingerprint,m=fp?.metrics||{},c=fp?.category_scores||{};
  if(fp?.activity_shock?.detected===true)return true;
  if(move===null||move>=Number(cfg.hardExtended24hMovePct||18))return false;
  const volume=Math.max(baselineHasFiniteNumber(m.rvol_1m)?Number(m.rvol_1m):0,baselineHasFiniteNumber(m.rvol_5m)?Number(m.rvol_5m):0);
  const trades=Math.max(baselineHasFiniteNumber(m.trade_rvol_1m)?Number(m.trade_rvol_1m):0,baselineHasFiniteNumber(m.trade_rvol_5m)?Number(m.trade_rvol_5m):0);
  const acceleration=Math.max(baselineHasFiniteNumber(m.acceleration_1m_pct)?Number(m.acceleration_1m_pct):-999,baselineHasFiniteNumber(m.acceleration_5m_pct)?Number(m.acceleration_5m_pct):-999);
  const pressure=baselineHasFiniteNumber(m.taker_buy_ratio)?Number(m.taker_buy_ratio):0;
  const structure=Math.max(baselineHasFiniteNumber(c.structure)?Number(c.structure):0,baselineHasFiniteNumber(m.higher_low_count)?Number(m.higher_low_count):0);
  return (volume>=Number(cfg.exceptionalVolumeAccelRatio??2.2)&&(acceleration>=Number(cfg.exceptionalPriceAccelerationPct??.15)||pressure>=.58||structure>=72))||
    (trades>=Number(cfg.exceptionalTradeAccelRatio??1.8)&&(acceleration>0||pressure>=.58));
}
function baselineTakeLane(selected,seen,pool,count,lane){
  const limit=Math.max(0,Math.trunc(Number(count)||0));if(limit===0)return;
  let added=0;
  for(const item of pool||[]){
    const symbol=baselineSymbol(item);
    if(!symbol||seen.has(symbol))continue;
    seen.add(symbol);selected.push({...item,_selection_lane:lane});added++;
    if(added>=limit)break;
  }
}
// Faithful test-only reproduction of Build 224's pre-PR #198 Deep selector.
// It intentionally uses independent historical rotation state and the very same
// Micro outputs given to the experimental selector; it does no REST calls.
function selectBuild224Baseline(radar,results,cycle,state,selectionAt=Date.now()){
  const currentCycle=Math.max(0,Math.trunc(Number(cycle)||0));
  const valid=(results||[]).filter(x=>x&&!x.failed&&baselineSymbol(x)&&x.micro_fingerprint?.score!=null&&baselineHasFiniteNumber(x.micro_fingerprint.score));
  const n=Math.max(1,Math.trunc(radar.config.deepCandidates||10));
  const target=Math.min(n,new Set(valid.map(baselineSymbol)).size);
  if(!target)return {selected:[],audit:[],candidate_total:0};
  const q=Math.min(Math.max(0,Math.trunc(radar.config.quietReserve??8)),Math.max(0,target-1),Math.floor(target*.5));
  const r=Math.min(Math.max(0,Math.trunc(radar.config.rotationReserve??2)),Math.max(0,target-q-1));
  const core=target-q-r;
  const byScore=[...valid].sort((a,b)=>Number(b.micro_fingerprint?.score??-1)-Number(a.micro_fingerprint?.score??-1)||baselineSymbol(a).localeCompare(baselineSymbol(b)));
  const byQuiet=valid.map(item=>({...item,_quietScore:baselineQuietDeepRank(item,radar.config)}))
    .filter(item=>item._quietScore!==null)
    .sort((a,b)=>(baselineMove(a.row)??Infinity)-(baselineMove(b.row)??Infinity)||b._quietScore-a._quietScore||baselineSymbol(a).localeCompare(baselineSymbol(b)));
  for(const item of valid){const s=baselineSymbol(item);if(!state.queuedAt.has(s))state.queuedAt.set(s,selectionAt);}
  const byRotation=[...valid].map(item=>{
    const symbol=baselineSymbol(item),lastCycle=state.lastCycle.get(symbol),lastAt=state.lastAt.get(symbol),queuedAt=state.queuedAt.get(symbol);
    const neverScanned=lastAt===undefined;
    return {...item,_neverScanned:neverScanned,
      _rotationAgeMs:neverScanned?Number.MAX_SAFE_INTEGER:Math.max(0,selectionAt-lastAt),
      _queueAgeMs:queuedAt===undefined?0:Math.max(0,selectionAt-queuedAt),
      _rotationAge:lastCycle===undefined?Number.MAX_SAFE_INTEGER:Math.max(0,currentCycle-lastCycle),
      _rotation:((baselineSymbolHash(symbol)+Math.imul(currentCycle,2654435761))>>>0)};
  }).sort((a,b)=>Number(b._neverScanned)-Number(a._neverScanned)||b._rotationAgeMs-a._rotationAgeMs||b._queueAgeMs-a._queueAgeMs||b._rotationAge-a._rotationAge||a._rotation-b._rotation||baselineSymbol(a).localeCompare(baselineSymbol(b)));
  const byExceptional=valid.filter(x=>baselineExceptionalDeep(x,radar.config)).sort((a,b)=>
    Number(b.micro_fingerprint?.score??-1)-Number(a.micro_fingerprint?.score??-1)||baselineSymbol(a).localeCompare(baselineSymbol(b)));
  const selected=[],seen=new Set(),exceptionSlots=Math.min(core,Math.max(0,Math.trunc(radar.config.exceptionalRotationBypassSlots??2)));
  baselineTakeLane(selected,seen,byExceptional,exceptionSlots,'exceptional');
  baselineTakeLane(selected,seen,byScore,Math.max(0,core-selected.length),'score');
  baselineTakeLane(selected,seen,byQuiet,q,'quiet');
  baselineTakeLane(selected,seen,byRotation,r,'rotation');
  baselineTakeLane(selected,seen,byScore,target-selected.length,'fill_score');
  baselineTakeLane(selected,seen,byQuiet,target-selected.length,'fill_quiet');
  baselineTakeLane(selected,seen,byRotation,target-selected.length,'fill_rotation');
  baselineTakeLane(selected,seen,valid,target-selected.length,'fill_any');
  const picked=new Map(selected.map((item,index)=>[baselineSymbol(item),{rank:index+1,lane:item._selection_lane||'score'}]));
  const scoreRanks=new Map();byScore.forEach((item,i)=>{const s=baselineSymbol(item);if(!scoreRanks.has(s))scoreRanks.set(s,i+1);});
  const quietRanks=new Map();byQuiet.forEach((item,i)=>{const s=baselineSymbol(item);if(!quietRanks.has(s))quietRanks.set(s,i+1);});
  const uniqueInputs=[...new Map((results||[]).filter(item=>baselineSymbol(item)).map(item=>[baselineSymbol(item),item])).entries()];
  const audit=uniqueInputs.map(([symbol,item])=>{
    const chosen=picked.get(symbol),score=baselineHasFiniteNumber(item?.micro_fingerprint?.score)?Number(item.micro_fingerprint.score):null;
    const classification=item?.micro_fingerprint?.quiet_base_pre_expansion?.classification??null;
    return {symbol,score,score_rank:scoreRanks.get(symbol)??null,
      quiet_rank:quietRanks.get(symbol)??null,classification,selected:Boolean(chosen),selected_rank:chosen?.rank??null,
      selection_lane:chosen?.lane??null,reason:chosen?'SELECTED_'+chosen.lane.toUpperCase():
        item?.failed?'MICRO_SCAN_FAILED':score===null?'MICRO_FINGERPRINT_NOT_SCOREABLE':'DEEP_BATCH_CAPACITY'};
  });
  return {selected:selected.slice(0,target),audit,candidate_total:valid.length};
}

const shouldRunLiveRadar8Monitor=process.env.GITHUB_ACTIONS==='true'&&
  process.env.GITHUB_WORKFLOW==='RadarX Radar 8 Operational Monitor'&&
  process.env.GITHUB_HEAD_REF==='experiment/build224-radar8-micro-quiet-base-20261010';

test('OPERATIONAL_MONITOR: 25 consecutive Radar 8 cycles with same-data Build 224 baseline comparison', {
  skip:!shouldRunLiveRadar8Monitor,timeout:900_000
},async()=>{
  const dir=await mkdtemp(join(tmpdir(),'radarx-radar8-live-monitor-'));
  const store=await new DurableStore({dir}).init();
  const rest=new RestClient({
    baseUrls:['https://data-api.binance.vision','https://api.binance.com'],
    timeoutMs:9000,minIntervalMs:100,maxRequestsPerMinute:240
  });
  const monitorLogs=[];
  const logger={
    info(message){if(String(message).includes('RADARX_'))monitorLogs.push(String(message));},
    warn(...args){monitorLogs.push(args.map(String).join(' '));},
    error(...args){monitorLogs.push(args.map(String).join(' '));}
  };
  const radar=new EarlyExpansionRadar({
    rest,store,
    config:{
      ...EARLY_EXPANSION_RADAR_DEFAULTS,
      minQuoteVolume24h:350_000,microScanCandidates:12,deepCandidates:3,
      quietReserve:8,rotationReserve:8,microConcurrency:6,deepConcurrency:4,
      universeRefreshMs:60*60*1000,retryAttempts:1,pollMs:45_000
    },
    clock:()=>Date.now(),logger
  });
  radar.running=true;
  const baselineState={lastAt:new Map(),lastCycle:new Map(),queuedAt:new Map()};
  let activeBaselineComparison=null;
  const appendJourney=store.appendScanJourneyCycle.bind(store);
  store.appendScanJourneyCycle=async record=>{
    if(record?.status==='COMPLETE'&&activeBaselineComparison)
      record.counters.same_cycle_baseline_comparison=structuredClone(activeBaselineComparison);
    return appendJourney(record);
  };
  const realDeepSelector=radar.selectDeepFromMicro.bind(radar);
  radar.selectDeepFromMicro=function(results,cycle){
    const baseline=selectBuild224Baseline(this,results,cycle,baselineState,Date.now());
    const prSelected=realDeepSelector(results,cycle);
    const prAudit=new Map(this.lastDeepSelectionAudit.map(x=>[x.symbol,x]));
    const baselineAudit=new Map(baseline.audit.map(x=>[x.symbol,x]));
    const symbols=new Set([...baselineAudit.keys(),...prAudit.keys()]);
    const candidateRanks=[...symbols].sort().map(symbol=>{
      const b=baselineAudit.get(symbol)||{},p=prAudit.get(symbol)||{};
      return {symbol,classification:b.classification??p.quiet_base_classification??null,
        score:b.score??p.score??null,
        baseline_score_rank:b.score_rank??null,baseline_quiet_rank:b.quiet_rank??null,
        baseline_selected_rank:b.selected_rank??null,baseline_lane:b.selection_lane??null,baseline_reason:b.reason??'NOT_IN_BASELINE_POOL',
        pr_score_rank:p.rank_by_micro_score??null,pr_quiet_rank:p.quiet_rank??null,
        pr_selected_rank:p.selected_rank??null,pr_lane:p.selection_lane??null,pr_reason:p.decision_reason??'NOT_IN_PR_POOL'};
    });
    const baselineSymbols=baseline.selected.map(baselineSymbol),prSymbols=prSelected.map(baselineSymbol);
    const classOf=symbol=>candidateRanks.find(x=>x.symbol===symbol)?.classification;
    activeBaselineComparison={
      schema_version:'RADAR8_SAME_CYCLE_BASELINE_V1',
      baseline:'Build224 before PR #198: score + ordinary quiet rank + fair rotation + exceptional bypass',
      experimental:'PR #198 current selector',
      cycle,deep_candidate_total:baseline.candidate_total,
      pre_expansion_candidates_total:candidateRanks.filter(x=>x.classification==='PRE_EXPANSION').length,
      watch_early_candidates_total:candidateRanks.filter(x=>x.classification==='WATCH_EARLY').length,
      baseline_deep_symbols:baselineSymbols,pr_deep_symbols:prSymbols,
      selected_overlap_total:baselineSymbols.filter(s=>prSymbols.includes(s)).length,
      selected_changed_from_baseline_total:new Set([...baselineSymbols,...prSymbols]).size-baselineSymbols.filter(s=>prSymbols.includes(s)).length,
      baseline_pre_expansion_selected_total:baselineSymbols.filter(s=>classOf(s)==='PRE_EXPANSION').length,
      pr_pre_expansion_selected_total:prSymbols.filter(s=>classOf(s)==='PRE_EXPANSION').length,
      baseline_watch_early_selected_total:baselineSymbols.filter(s=>classOf(s)==='WATCH_EARLY').length,
      pr_watch_early_selected_total:prSymbols.filter(s=>classOf(s)==='WATCH_EARLY').length,
      baseline_quiet_lane_selected_total:baseline.selected.filter(x=>String(x._selection_lane||'').includes('quiet')).length,
      pr_quiet_lane_selected_total:prSelected.filter(x=>String(x._selection_lane||'').includes('quiet')).length,
      baseline_exceptional_selected_total:baseline.selected.filter(x=>x._selection_lane==='exceptional').length,
      pr_exceptional_selected_total:prSelected.filter(x=>x._selection_lane==='exceptional').length,
      candidate_ranks:candidateRanks
    };
    return prSelected;
  };
  const cycles=[];
  try{
    for(let i=0;i<25;i++){
      activeBaselineComparison=null;
      const ok=await radar.tick();
      assert.equal(ok,true,'cycle '+(i+1)+' must complete against live REST data: '+JSON.stringify({lastError:radar.lastError,health:radar.health(),rest:rest.health(),telemetry:rest.telemetrySnapshot(),logs:monitorLogs.slice(-8)}));
      const latest=(await store.readScanJourneyCycles({limit:1}))[0];
      assert.ok(latest,'completed cycle must be archived');
      assert.equal(latest.status,'COMPLETE');
      assert.equal(latest.data_policy.paper_trading,true);
      assert.equal(latest.data_policy.real_order_execution,false);
      assert.equal(latest.counters.operational_telemetry_schema,'RADAR8_OPERATIONAL_TELEMETRY_V1');
      assert.ok(latest.counters.rest_request_telemetry.process_rest_delta.available);
      assert.ok(latest.counters.rest_request_telemetry.actual_http_attempts>0);
      assert.ok(latest.counters.rest_request_telemetry.process_rest_delta.actual_http_attempts>0);
      assert.ok(latest.counters.micro_selected_total<=12);
      assert.ok(latest.counters.deep_selected_total<=3);
      assert.equal(latest.counters.micro_selected_total,new Set(latest.counters.micro_selected_symbols).size);
      assert.equal(latest.counters.deep_selected_total,new Set(latest.counters.deep_selected_symbols).size);
      assert.equal(latest.counters.micro_selected_total,latest.coins.filter(x=>x.micro_selection_selected===true).length);
      assert.equal(latest.counters.deep_selected_total,latest.coins.filter(x=>x.deep_selection_selected===true).length);
      const comparison=latest.counters.same_cycle_baseline_comparison;
      assert.ok(comparison,'baseline comparison must be stored in the same cycle archive row');
      assert.equal(comparison.candidate_ranks.length,latest.counters.deep_selection_ranked_total);
      assert.deepEqual([...comparison.pr_deep_symbols].sort(),[...latest.counters.deep_selected_symbols].sort());
      assert.ok(comparison.baseline_deep_symbols.length<=3);
      assert.ok(comparison.pr_deep_symbols.length<=3);
      assert.equal(comparison.candidate_ranks.filter(x=>x.pr_selected_rank!==null).length,comparison.pr_deep_symbols.length);
      assert.equal(comparison.candidate_ranks.filter(x=>x.baseline_selected_rank!==null).length,comparison.baseline_deep_symbols.length);
      for(const symbol of comparison.baseline_deep_symbols){
        baselineState.lastAt.set(symbol,latest.completed_at);
        baselineState.lastCycle.set(symbol,latest.cycle_number||i+1);
        baselineState.queuedAt.delete(symbol);
      }
      cycles.push({
        cycle_id:latest.cycle_id,started_at:latest.started_at,completed_at:latest.completed_at,
        scan_duration_ms:latest.scan_duration_ms,
        eligible_total:latest.counters.eligible_total,eligible_symbols:latest.counters.eligible_symbols,
        micro_selected_total:latest.counters.micro_selected_total,micro_selected_symbols:latest.counters.micro_selected_symbols,
        micro_success_total:latest.counters.micro_success_total,micro_pre_expansion_total:latest.counters.micro_pre_expansion_total,
        micro_watch_early_total:latest.counters.micro_watch_early_total,micro_quiet_selected_total:latest.counters.micro_quiet_selected_total,
        micro_exceptional_candidate_total:latest.counters.micro_exceptional_candidate_total,
        deep_selected_symbols:latest.counters.deep_selected_symbols,
        deep_pre_expansion_selected_total:latest.counters.deep_pre_expansion_selected_total,
        deep_watch_early_selected_total:latest.counters.deep_watch_early_selected_total,
        deep_deferred_total:latest.counters.deep_deferred_total,micro_deferred_total:latest.counters.micro_deferred_total,
        micro_duplicate_input_symbol_rows:latest.counters.micro_duplicate_input_symbol_rows,
        deep_duplicate_input_symbol_rows:latest.counters.deep_duplicate_input_symbol_rows,
        micro_failed_total:latest.counters.micro_failed_total,deep_failed_total:latest.counters.deep_failed_total,
        rest_attempts:latest.counters.rest_request_telemetry.actual_http_attempts,
        process_http_attempts:latest.counters.rest_request_telemetry.process_rest_delta.actual_http_attempts,
        rest_request_stages:Object.fromEntries(Object.entries(latest.counters.rest_request_telemetry.by_stage).map(([k,v])=>[k,v.actual_http_attempts])),
        phase_timings_ms:latest.phase_timings_ms,
        same_data_baseline_comparison:comparison
      });
    }
    assert.equal(cycles.length,25);
    const freshStore=await new DurableStore({dir}).init();
    const restoredCycles=await freshStore.readScanJourneyCycles({limit:25});
    assert.equal(restoredCycles.length,25,'all 25 cycle records must survive a fresh store reload');
    assert.deepEqual(restoredCycles.map(x=>x.cycle_id).sort(),cycles.map(x=>x.cycle_id).sort());
    const verified=await freshStore.verifyScanJourneyArchive();
    assert.equal(verified.complete,true,JSON.stringify(verified));
    const baselinePre=cycles.reduce((n,x)=>n+x.same_data_baseline_comparison.baseline_pre_expansion_selected_total,0);
    const prPre=cycles.reduce((n,x)=>n+x.same_data_baseline_comparison.pr_pre_expansion_selected_total,0);
    const baselineWatch=cycles.reduce((n,x)=>n+x.same_data_baseline_comparison.baseline_watch_early_selected_total,0);
    const prWatch=cycles.reduce((n,x)=>n+x.same_data_baseline_comparison.pr_watch_early_selected_total,0);
    const baselineChosen=cycles.reduce((n,x)=>n+x.same_data_baseline_comparison.baseline_deep_symbols.length,0);
    const prChosen=cycles.reduce((n,x)=>n+x.same_data_baseline_comparison.pr_deep_symbols.length,0);
    const summary={
      mode:'CI_LIVE_PUBLIC_SPOT_REST_NOT_PRODUCTION_DEPLOYMENT',
      baseline_mode:'test-only faithful Build 224 pre-PR selector replayed on each exact Micro result pool; independent shadow rotation state',
      cycles_run:cycles.length,cycles,archive_verified:verified.complete,
      aggregate:{
        eligible_per_cycle_median:cycles.slice().sort((a,b)=>a.eligible_total-b.eligible_total)[Math.floor(cycles.length/2)].eligible_total,
        median_cycle_ms:cycles.slice().map(x=>x.scan_duration_ms).sort((a,b)=>a-b)[Math.floor(cycles.length/2)],
        rest_attempts_total:cycles.reduce((n,x)=>n+x.rest_attempts,0),
        micro_failures:cycles.reduce((n,x)=>n+x.micro_failed_total,0),
        deep_failures:cycles.reduce((n,x)=>n+x.deep_failed_total,0),
        duplicates:cycles.reduce((n,x)=>n+x.micro_duplicate_input_symbol_rows+x.deep_duplicate_input_symbol_rows,0),
        baseline_deep_candidate_seats:baselineChosen,pr_deep_candidate_seats:prChosen,
        baseline_pre_expansion_deep:baselinePre,pr_pre_expansion_deep:prPre,
        baseline_watch_early_deep:baselineWatch,pr_watch_early_deep:prWatch,
        cycles_with_pre_expansion:cycles.filter(x=>x.same_data_baseline_comparison.pre_expansion_candidates_total>0).length,
        cycles_where_pr_added_pre_expansion_to_deep:cycles.filter(x=>x.same_data_baseline_comparison.pr_pre_expansion_selected_total>x.same_data_baseline_comparison.baseline_pre_expansion_selected_total).length,
        cycles_where_deep_selection_changed:cycles.filter(x=>x.same_data_baseline_comparison.selected_changed_from_baseline_total>0).length
      },
      paper_trading:true,real_order_execution:false
    };
    if(process.env.RADAR8_MONITOR_REPORT_PATH)
      await writeFile(process.env.RADAR8_MONITOR_REPORT_PATH,JSON.stringify(summary,null,2)+'\n');
    console.log('[RADAR8_LIVE_MONITOR_SUMMARY] '+JSON.stringify(summary));
  }finally{
    await radar.stop();
    await rm(dir,{recursive:true,force:true});
  }
});
