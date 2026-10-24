#!/usr/bin/env node
import {mkdir, readFile, writeFile, rename} from 'node:fs/promises';
import {dirname, resolve, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {HISTORICAL_DETECTOR_PROFILES, historicalProfileRequirements} from './historical-replay.mjs';

const MINUTE_MS=60_000;
const HOUR_MS=60*MINUTE_MS;
const scriptDir=dirname(fileURLToPath(import.meta.url));
const replayScript=resolve(scriptDir,'historical-replay.mjs');
const unique=values=>[...new Set(values.map(x=>String(x??'').trim()).filter(Boolean))];
function arg(args,name,fallback=null){
  const i=args.indexOf(name);
  return i<0?fallback:(args[i+1]??fallback);
}
function parseTime(raw,label){
  if(raw===null||raw===undefined)return null;
  const n=Number(raw);
  const value=String(raw).trim()!==''&&Number.isFinite(n)?n:Date.parse(raw);
  if(!Number.isFinite(value))throw new Error('INVALID_'+label.toUpperCase());
  return value;
}
function parseIntArg(raw,fallback,min,max,label){
  const n=Math.trunc(Number(raw??fallback));
  if(!Number.isFinite(n)||n<min||n>max)throw new Error('INVALID_'+label.toUpperCase());
  return n;
}
function normalizeProfiles(raw){
  if(raw===null||raw===undefined||String(raw).trim()==='')return [...HISTORICAL_DETECTOR_PROFILES];
  const aliases={RADAR8_PREMOVE_SHADOW:'EARLY_EXPANSION_RADAR'};
  const requested=String(raw).split(',').map(x=>aliases[String(x).trim().toUpperCase()]||String(x).trim().toUpperCase()).filter(Boolean);
  const unknown=requested.filter(x=>!HISTORICAL_DETECTOR_PROFILES.includes(x));
  if(unknown.length)throw new Error('UNSUPPORTED_HISTORICAL_PROFILES:'+unknown.join(','));
  return unique(requested);
}
function profileContract(profile){
  const requirements=historicalProfileRequirements(profile);
  return {
    profile,
    mode:profile==='PROFESSOR_RADAR'?'EXTERNAL_FEED_ARCHIVE_REQUIRED':
      profile==='EARLY_MOVE_RADAR'||profile==='EARLY_EXPANSION_RADAR'?'PRE_MOVE_CANDIDATE_SHADOW':
      'PRODUCTION_ANALYSIS_CANDIDATE_SHADOW',
    required_history:requirements,
    unavailable_historical_evidence:requirements.unavailableEvidence||[],
    external_evidence_required:requirements.externalEvidence||[],
    trade_history_required:requirements.tradeHistoryRequired===true,
    actual_push_simulated:false,
    policy:{market:'BINANCE_SPOT_USDT',paper_trading:true,real_order_execution:false}
  };
}
function serializeResult(row,profile){
  const q=row?.data_quality||{};
  const ev=row?.evaluation||{};
  const requirements=q.required_history||historicalProfileRequirements(profile);
  const blockers=unique([
    ...(q.profile_coverage_failures||[]),
    ...(requirements.unavailableEvidence||[]),
    ...(requirements.externalEvidence||[]).map(x=>'HISTORICAL_EXTERNAL_EVIDENCE_REQUIRED:'+x),
    ...(!q.outcome_candle_fetch_complete?['FORWARD_OUTCOME_HORIZON_INCOMPLETE']:[]),
    ...(q.replay_mode==='CANDLE_ONLY_FALLBACK'?['AGG_TRADE_COVERAGE_INCOMPLETE_CANDLE_ONLY_OUTCOMES']:[])
  ]);
  const coverage=q.profile_coverage_complete===true&&q.candle_fetch_complete===true;
  const completeOutcomes=q.outcome_candle_fetch_complete===true&&ev.observation?.outcomes_matured_for_all_steps===true;
  const status=!coverage?'BLOCKED_INCOMPLETE_HISTORY':
    (requirements.externalEvidence||[]).length?'BLOCKED_MISSING_EXTERNAL_ARCHIVES':
    (requirements.unavailableEvidence||[]).length?'CANDIDATE_ONLY_MISSING_HISTORICAL_EVIDENCE':
    !completeOutcomes?'PARTIAL_OUTCOME_HORIZON':
    'HISTORICAL_REPLAY_COMPLETE';
  return {
    profile,status,
    symbol:String(row?.symbol||'UNKNOWN'),
    profile_coverage_complete:coverage,
    outcome_horizon_complete:completeOutcomes,
    replay_mode:q.replay_mode||'UNKNOWN',
    candidate_only:status==='CANDIDATE_ONLY_MISSING_HISTORICAL_EVIDENCE',
    accepted_historical_notifications:Number(row?.summary?.accepted)||0,
    candidate_episodes:Number(ev.candidate_detection?.candidate_count??row?.summary?.candidate_detections)||0,
    low_follow_through_candidate_count:Number(ev.candidate_detection?.low_follow_through_candidate_count)||0,
    low_follow_through_candidate_rate_pct:ev.candidate_detection?.low_follow_through_candidate_rate_pct??null,
    early_5pct_candidate:ev.candidate_detection?.moderate_move?.detected_early===true,
    minutes_before_5pct_candidate:ev.candidate_detection?.moderate_move?.minutes_before_move??null,
    early_15pct_candidate:ev.candidate_detection?.strong_move?.detected_early===true,
    minutes_before_15pct_candidate:ev.candidate_detection?.strong_move?.minutes_before_move??null,
    missed_5pct_move:ev.candidate_detection?.moderate_move?.classification??ev.moderate_move?.classification??'UNAVAILABLE',
    missed_15pct_move:ev.candidate_detection?.strong_move?.classification??ev.strong_move?.classification??'UNAVAILABLE',
    last_rejection_before_move:{
      plus_5pct:ev.candidate_detection?.moderate_move?.last_rejection_before_move??ev.moderate_move?.missed_move?.last_rejection_before_move??null,
      plus_15pct:ev.candidate_detection?.strong_move?.last_rejection_before_move??ev.strong_move?.missed_move?.last_rejection_before_move??null
    },
    required_history:requirements,
    evidence_blockers:blockers,
    real_notification_delivery_simulated:false
  };
}
async function runChild(profile,args,outputPath){
  const childArgs=[
    replayScript,'--detector-profile',profile,'--symbols',args.symbols,
    '--start',String(args.start),'--end',String(args.end),
    '--lookback-hours',String(args.lookbackHours),
    '--outcome-horizon-hours',String(args.outcomeHorizonHours),
    '--max-trade-pages',String(args.maxTradePages),'--max-trades',String(args.maxTrades),
    '--output',outputPath
  ];
  return await new Promise((resolvePromise,reject)=>{
    const child=spawn(process.execPath,childArgs,{stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='';
    child.stdout.on('data',chunk=>{stdout+=chunk.toString();if(stdout.length>4_000_000)stdout=stdout.slice(-4_000_000);});
    child.stderr.on('data',chunk=>{const value=chunk.toString();stderr+=value;if(stderr.length>1_000_000)stderr=stderr.slice(-1_000_000);process.stderr.write(value);});
    child.on('error',reject);
    child.on('close',code=>resolvePromise({code,stdout,stderr,args:childArgs}));
  });
}
async function atomicJson(path,value){
  await mkdir(dirname(path),{recursive:true});
  const temp=path+'.tmp-'+process.pid;
  await writeFile(temp,JSON.stringify(value,null,2)+'\n',{encoding:'utf8',flag:'wx'});
  await rename(temp,path);
}
async function main(){
  const args=process.argv.slice(2);
  if(args.includes('--help')||args.includes('-h')){
    process.stdout.write([
      'RadarX 12-radar historical profile matrix (public Binance Spot; read-only)',
      'Usage: node phase2/tools/historical-profile-matrix.mjs [--symbols GTCUSDT,WUSDT]',
      '  [--profiles PROFILE1,PROFILE2] [--lookback-hours 6] [--outcome-horizon-hours 24]',
      '  [--start ISO|ms] [--end ISO|ms] [--max-trade-pages 500] [--max-trades 500000]',
      '  [--output path] [--list-profiles] [--dry-run]',
      'Default run: all 12 canonical radar profiles on a six-hour window old enough to mature the forward-outcome horizon.',
      'Candidate shadows are not real notifications; profiles with missing order-book, derivatives, leader-cohort, or external archive history stay explicitly partial/blocked.',
      'No exchange credentials or order-execution endpoints are used.'
    ].join('\n')+'\n');
    return;
  }
  const profiles=normalizeProfiles(arg(args,'--profiles'));
  const symbols=unique(String(arg(args,'--symbols','GTCUSDT,WUSDT')).split(',').map(x=>x.toUpperCase()));
  if(!symbols.length||symbols.some(s=>!/^[A-Z0-9]{5,20}$/.test(s)))throw new Error('INVALID_SYMBOLS');
  const lookbackHours=parseIntArg(arg(args,'--lookback-hours','6'),6,1,168,'lookback-hours');
  const outcomeHorizonHours=parseIntArg(arg(args,'--outcome-horizon-hours','24'),24,1,168,'outcome-horizon-hours');
  const maxTradePages=parseIntArg(arg(args,'--max-trade-pages','500'),500,1,1000,'max-trade-pages');
  const maxTrades=parseIntArg(arg(args,'--max-trades','500000'),500000,1000,1000000,'max-trades');
  const now=Date.now();
  const explicitStart=parseTime(arg(args,'--start'),'start');
  const explicitEnd=parseTime(arg(args,'--end'),'end');
  const end=explicitEnd??(explicitStart!==null?explicitStart+lookbackHours*HOUR_MS:Math.floor(now/MINUTE_MS)*MINUTE_MS-outcomeHorizonHours*HOUR_MS-MINUTE_MS);
  const start=explicitStart??(end-lookbackHours*HOUR_MS);
  if(start>=end||end>now+MINUTE_MS||end-start>7*24*HOUR_MS)throw new Error('INVALID_REPLAY_WINDOW');
  if(end+outcomeHorizonHours*HOUR_MS>now-MINUTE_MS)throw new Error('OUTCOME_HORIZON_NOT_MATURED_CHOOSE_OLDER_END');
  if(args.includes('--list-profiles')||args.includes('--dry-run')){
    process.stdout.write(JSON.stringify({
      status:'DRY_RUN_NO_NETWORK',
      window:{start,start_iso:new Date(start).toISOString(),end,end_iso:new Date(end).toISOString(),
        lookback_hours:(end-start)/HOUR_MS,outcome_horizon_hours:outcomeHorizonHours,
        outcome_end:end+outcomeHorizonHours*HOUR_MS},
      symbols,
      profiles:profiles.map(profileContract),
      policy:{network_access:false,market:'BINANCE_SPOT_USDT',paper_trading:true,real_order_execution:false,
        credentials_used:false,real_notifications_simulated:false}
    },null,2)+'\n');
    return;
  }
  const output=resolve(arg(args,'--output','./.radarx-data/historical-profile-matrix-'+new Date(now).toISOString().replace(/[:.]/g,'-')+'.json'));
  const profilesDir=output+'.profiles';
  await mkdir(profilesDir,{recursive:true});
  const summary={engine:'RADARX_HISTORICAL_PROFILE_MATRIX_V1',generated_at:new Date(now).toISOString(),
    window:{start,start_iso:new Date(start).toISOString(),end,end_iso:new Date(end).toISOString(),
      lookback_hours:(end-start)/HOUR_MS,outcome_horizon_hours:outcomeHorizonHours,
      outcome_end:end+outcomeHorizonHours*HOUR_MS},
    symbols,profile_count:profiles.length,profiles:[],policy:{market:'BINANCE_SPOT_USDT',paper_trading:true,
      real_order_execution:false,real_notifications_simulated:false}};
  for(const profile of profiles){
    process.stderr.write('[PROFILE_MATRIX] start '+profile+' symbols='+symbols.length+'\n');
    const profilePath=join(profilesDir,profile+'.json');
    const child=await runChild(profile,{symbols:symbols.join(','),start,end,lookbackHours,outcomeHorizonHours,maxTradePages,maxTrades},profilePath);
    let report=null,readError=null;
    try{report=JSON.parse(await readFile(profilePath,'utf8'));}catch(error){readError=String(error?.message||error).slice(0,240);}
    const rows=(report?.results||[]).map(row=>serializeResult(row,profile));
    const requestedOk=rows.length===symbols.length;
    const status=!report||!requestedOk?'EXECUTION_FAILED':
      rows.every(row=>row.status==='HISTORICAL_REPLAY_COMPLETE')?'HISTORICAL_REPLAY_COMPLETE':
      rows.some(row=>row.status==='BLOCKED_INCOMPLETE_HISTORY'||row.status==='BLOCKED_MISSING_EXTERNAL_ARCHIVES')
        ?'COMPLETED_WITH_BLOCKERS':'CANDIDATE_ONLY_PARTIAL';
    summary.profiles.push({
      profile,status,output:profilePath,exit_code:child.code,
      error:readError,stdout_tail:child.stdout.slice(-2000),
      symbol_count:rows.length,coverage_complete_symbols:rows.filter(x=>x.profile_coverage_complete).length,
      mature_outcome_symbols:rows.filter(x=>x.outcome_horizon_complete).length,
      candidate_episodes:rows.reduce((n,x)=>n+x.candidate_episodes,0),
      low_follow_through_candidate_count:rows.reduce((n,x)=>n+x.low_follow_through_candidate_count,0),
      results:rows
    });
    process.stderr.write('[PROFILE_MATRIX] end '+profile+' status='+status+' symbols='+rows.length+'\n');
  }
  const counts={};
  for(const row of summary.profiles)counts[row.status]=(counts[row.status]||0)+1;
  summary.summary={status:summary.profiles.some(x=>x.status==='EXECUTION_FAILED')?'EXECUTION_FAILED':
      summary.profiles.every(x=>x.status==='HISTORICAL_REPLAY_COMPLETE')?'COMPLETE':'COMPLETE_WITH_EVIDENCE_GAPS',
    statuses:counts,requested_profile_count:profiles.length,
    profiles_with_all_symbol_coverage:summary.profiles.filter(x=>x.coverage_complete_symbols===symbols.length).length,
    profiles_with_mature_outcomes:summary.profiles.filter(x=>x.mature_outcome_symbols===symbols.length).length,
    candidate_episodes:summary.profiles.reduce((n,x)=>n+x.candidate_episodes,0),
    low_follow_through_candidate_count:summary.profiles.reduce((n,x)=>n+x.low_follow_through_candidate_count,0),
    scope_note:'Candidate-shadow metrics are historical research only. They do not simulate push delivery or prove profitability. Profiles with missing historical evidence are not considered production-ready.'};
  await atomicJson(output,summary);
  process.stdout.write(JSON.stringify({output:summary?output:null,generated_at:summary.generated_at,summary:summary.summary,
    profiles:summary.profiles.map(x=>({profile:x.profile,status:x.status,coverage_complete_symbols:x.coverage_complete_symbols,
      mature_outcome_symbols:x.mature_outcome_symbols,candidate_episodes:x.candidate_episodes,
      low_follow_through_candidate_count:x.low_follow_through_candidate_count,output:x.output,error:x.error})),
    policy:summary.policy},null,2)+'\n');
  if(summary.summary.status==='EXECUTION_FAILED')process.exitCode=2;
}
if(process.argv[1]&&resolve(fileURLToPath(import.meta.url))===resolve(process.argv[1])){
  main().catch(error=>{process.stderr.write('[PROFILE_MATRIX_ERROR] '+String(error?.stack||error)+'\n');process.exitCode=1;});
}
