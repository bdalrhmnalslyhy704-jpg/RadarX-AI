#!/usr/bin/env node
import {spawn} from 'node:child_process';
import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {CONFIG} from '../config.mjs';
import {RestClient} from '../market/binance-rest.mjs';
import {withHistoricalRateLimitRetry} from './historical-replay.mjs';
import {HISTORICAL_MATRIX_DEFAULT_SYMBOLS,HISTORICAL_MATRIX_DEFAULT_WINDOWS,HISTORICAL_MATRIX_REQUIRED_REGIMES,normalizeMatrixSymbols,normalizeMatrixWindows,classifyBtcMarketRegime,summarizeHistoricalWindowReport} from '../core/historical-replay-matrix.mjs';

const HOUR_MS=60*60*1000;
const here=dirname(fileURLToPath(import.meta.url));
const replayScript=resolve(here,'historical-replay.mjs');
function flag(args,name,fallback=null){const i=args.indexOf(name);return i<0?fallback:(args[i+1]??fallback);}
function integer(raw,fallback,min,max,label){const n=Math.trunc(Number(raw??fallback));if(!Number.isFinite(n)||n<min||n>max)throw new Error('INVALID_'+label.toUpperCase());return n;}
function isoArg(value){const n=Date.parse(String(value??''));if(!Number.isFinite(n))throw new Error('INVALID_MATRIX_TIME');return new Date(n).toISOString();}
async function loadWindows(path){if(!path)return HISTORICAL_MATRIX_DEFAULT_WINDOWS;const raw=JSON.parse(await readFile(resolve(path),'utf8'));if(!Array.isArray(raw))throw new Error('WINDOWS_JSON_MUST_BE_ARRAY');return raw;}
async function classifyWindow(client,window){
  try{
    const result=await withHistoricalRateLimitRetry(
      ()=>client.klines('BTCUSDT','1h',{limit:Math.max(4,Math.min(1000,Math.ceil((window.endMs-window.startMs)/HOUR_MS)+2)),startTime:window.startMs,endTime:window.endMs-1}),
      {label:'btc-regime:'+window.id}
    );
    const rows=(Array.isArray(result?.candles)?result.candles:[]).filter(c=>Number(c?.closeTime??c?.close_time)<=window.endMs-1&&Number(c?.openTime??c?.open_time)>=window.startMs);
    return classifyBtcMarketRegime(rows);
  }catch(error){return {regime:'UNKNOWN',sample_count:0,net_return_pct:null,range_pct:null,reason:'BTC_REGIME_FETCH_FAILED: '+String(error?.message??error).slice(0,240)};}
}
function runChild(args,{timeoutMs,windowId}){
  return new Promise(resolveResult=>{
    const child=spawn(process.execPath,args,{stdio:['ignore','pipe','pipe'],env:{...process.env}});
    let stdout='',stderr='',timedOut=false,finished=false;
    const finish=value=>{if(finished)return;finished=true;clearTimeout(timer);resolveResult(value);};
    child.stdout.on('data',b=>{stdout+=b.toString();if(stdout.length>20000)stdout=stdout.slice(-20000);process.stdout.write(b);});
    child.stderr.on('data',b=>{const s=b.toString();stderr+=s;if(stderr.length>50000)stderr=stderr.slice(-50000);process.stderr.write('['+windowId+'] '+s);});
    child.on('error',error=>finish({exitCode:1,timedOut:false,error:String(error?.message??error),stdout,stderr}));
    child.on('close',code=>finish({exitCode:code??1,timedOut,error:timedOut?'MATRIX_REPLAY_TIMEOUT':null,stdout,stderr}));
    const timer=setTimeout(()=>{timedOut=true;try{child.kill('SIGTERM');}catch{}setTimeout(()=>{try{child.kill('SIGKILL');}catch{}},5000).unref?.();},timeoutMs);
  });
}
async function main(){
  const args=process.argv.slice(2);
  if(args.includes('--help')||args.includes('-h')){
    process.stdout.write([
      'RadarX multi-window historical replay matrix (public Binance Spot, read-only)',
      'Usage: node phase2/tools/historical-replay-matrix.mjs [--symbols BTCUSDT,ETHUSDT,...] [--windows windows.json]',
      '       [--max-trade-pages 60] [--max-trades 60000] [--outcome-horizon-hours 24] [--output reports/radarx-matrix]',
      '       [--hybrid-benchmark-output dataset.json] (4h horizon; 24x23 causal sequence export) [--dry-run]',
      'Default coverage: 30 Spot USDT symbols × 3 one-day candidate windows (maximum 90 symbol-window replays).',
      'Each window is classified from observed closed BTCUSDT candles: BULL_TREND, BEAR_TREND, SIDEWAYS, MIXED, or UNKNOWN.',
      'Each symbol must have complete closed-candle coverage. Missing aggregate trades use an explicit candle-only fallback; exact trade-crossing timestamps remain unavailable. No synthetic data or orders.'
    ].join('\n')+'\n');return;
  }
  const symbols=normalizeMatrixSymbols(flag(args,'--symbols',HISTORICAL_MATRIX_DEFAULT_SYMBOLS.join(',')));
  const windowsInput=await loadWindows(flag(args,'--windows'));
  const windows=normalizeMatrixWindows(windowsInput,{now:Date.now()});
  const maxTradePages=integer(flag(args,'--max-trade-pages','60'),60,1,1000,'max-trade-pages');
  const maxTrades=integer(flag(args,'--max-trades','60000'),60000,1000,1000000,'max-trades');
  const outcomeHorizonHours=integer(flag(args,'--outcome-horizon-hours','24'),24,1,168,'outcome-horizon-hours');
  const hybridBenchmarkOutputRaw=flag(args,'--hybrid-benchmark-output');
  const hybridBenchmarkOutput=hybridBenchmarkOutputRaw?resolve(hybridBenchmarkOutputRaw):null;
  if(hybridBenchmarkOutput&&outcomeHorizonHours!==4)throw new Error('HYBRID_BENCHMARK_REQUIRES_4H_OUTCOME_HORIZON');
  const timeoutMs=integer(flag(args,'--timeout-ms','1800000'),1800000,60000,7200000,'timeout-ms');
  const outputDir=resolve(flag(args,'--output','./reports/radarx-historical-matrix-'+new Date().toISOString().replace(/[:.]/g,'-')));
  const plan={engine:'RADARX_HISTORICAL_REPLAY_MATRIX_V1',created_at:new Date().toISOString(),symbol_count:symbols.length,window_count:windows.length,planned_symbol_window_replays:symbols.length*windows.length,symbols,windows:windows.map(w=>({id:w.id,label:w.label,start:w.start,end:w.end})),limits:{max_trade_pages_per_symbol:maxTradePages,max_trades_per_symbol:maxTrades,outcome_horizon_hours:outcomeHorizonHours,timeout_ms_per_window:timeoutMs},policy:{market:'BINANCE_SPOT',paper_trading:true,real_order_execution:false,confidence_score:'UNKNOWN'}};
  if(args.includes('--dry-run')){process.stdout.write(JSON.stringify({...plan,status:'DRY_RUN_NO_NETWORK'},null,2)+'\n');return;}
  await mkdir(outputDir,{recursive:true});
  const client=new RestClient({...CONFIG.rest,baseUrls:CONFIG.rest.baseUrls??CONFIG.rest.urls});
  const results=[];
  const hybridRows=[];
  let hybridSourceSha=null;
  for(let i=0;i<windows.length;i++){
    const window=windows[i];
    process.stderr.write('[MATRIX] '+window.id+' '+window.start+' .. '+window.end+' ('+(i+1)+'/'+windows.length+')\n');
    const marketRegime=await classifyWindow(client,window);
    const rawPath=resolve(outputDir,window.id+'.json');
    const hybridWindowPath=resolve(outputDir,window.id+'.hybrid-benchmark.json');
    const childArgs=[replayScript,'--symbols',symbols.join(','),'--start',String(window.startMs),'--end',String(window.endMs-1),'--max-trade-pages',String(maxTradePages),'--max-trades',String(maxTrades),'--outcome-horizon-hours',String(outcomeHorizonHours),'--output',rawPath];
    if(hybridBenchmarkOutput)childArgs.push('--hybrid-benchmark-output',hybridWindowPath);
    const child=await runChild(childArgs,{timeoutMs,windowId:window.id});
    let rawReport=null,parseError=null;
    try{rawReport=JSON.parse(await readFile(rawPath,'utf8'));}catch(error){parseError=String(error?.message??error);}
    if(hybridBenchmarkOutput){
      try{
        const captured=JSON.parse(await readFile(hybridWindowPath,'utf8'));
        if(!Array.isArray(captured.rows)||captured.dataset_contract!=='RADARX_HYBRID_TCN_ATTENTION_4H_SPOT_BENCHMARK_V1')throw new Error('HYBRID_CAPTURE_CONTRACT_INVALID');
        if(hybridSourceSha===null)hybridSourceSha=captured.source_commit_sha;
        if(captured.source_commit_sha!==hybridSourceSha)throw new Error('HYBRID_CAPTURE_SOURCE_SHA_MISMATCH');
        hybridRows.push(...captured.rows.map(row=>({
          ...row,
          historical_window_id:window.id,
          market_regime:String(marketRegime?.regime??'UNKNOWN').toUpperCase()
        })));
      }catch(error){parseError=(parseError?parseError+'; ':'')+'HYBRID_CAPTURE_FAILED:'+String(error?.message??error);}
    }
    const summary=rawReport?summarizeHistoricalWindowReport(rawReport):{requested_symbols:symbols.length,returned_symbol_results:0,coverage_complete_symbols:0,coverage_incomplete_symbols:symbols.length,coverage_status:'INCOMPLETE_OR_EMPTY'};
    results.push({id:window.id,label:window.label,window:{start:window.start,end:window.end},market_regime:marketRegime,process:{exit_code:child.exitCode,timed_out:child.timedOut,error:child.error??parseError},report_path:rawPath,summary});
  }
  const complete=results.filter(x=>['COMPLETE','COMPLETE_WITH_CANDLE_FALLBACK'].includes(x.summary.coverage_status)&&x.market_regime.regime!=='UNKNOWN');
  const hasCandleFallback=complete.some(x=>x.summary.coverage_status==='COMPLETE_WITH_CANDLE_FALLBACK');
  const regimesObserved=[...new Set(results.map(x=>x.market_regime.regime))];
  const missingRequiredRegimes=HISTORICAL_MATRIX_REQUIRED_REGIMES.filter(regime=>!regimesObserved.includes(regime));
  const regimeCoverageComplete=missingRequiredRegimes.length===0;
  const status=complete.length!==results.length?'INCOMPLETE_OR_PARTIAL':
    !regimeCoverageComplete?'INCOMPLETE_REGIME_COVERAGE':
      (hasCandleFallback?'COMPLETE_WITH_FALLBACK':'COMPLETE');
  let hybridDatasetSummary=null;
  if(hybridBenchmarkOutput){
    const hybridDataset={
      dataset_contract:'RADARX_HYBRID_TCN_ATTENTION_4H_SPOT_BENCHMARK_V1',
      source_commit_sha:hybridSourceSha,
      market:'BINANCE_SPOT_USDT',
      target_definition:'FIRST_PASSAGE_3PCT_BEFORE_MINUS_2PCT_4H_CLOSED_SPOT_V1',
      feature_interval:'1M_CLOSED_CANDLES',
      capture_sampling:'EVERY_10M_DECISION',
      sequence_steps:24,
      sequence_channels:23,
      outcome_horizon_ms:4*HOUR_MS,
      symbols,
      windows:windows.map(window=>({
        id:window.id,start:window.start,end:window.end,
        market_regime:String(results.find(result=>result.id===window.id)?.market_regime?.regime??'UNKNOWN').toUpperCase()
      })),
      required_market_regimes:HISTORICAL_MATRIX_REQUIRED_REGIMES,
      observed_market_regimes:[...new Set(results.map(result=>String(result.market_regime?.regime??'UNKNOWN').toUpperCase()))],
      benchmark_options:{folds:5,minimumTrainTimes:40,minimumTrainRows:100,
        minimumValidationRows:30,minimumTestRows:30,embargoMs:4*HOUR_MS,
        positionFraction:1/30,maxConcurrentPositions:30,roundTripCostBps:30,epochs:8,
        targetDefinition:'FIRST_PASSAGE_3PCT_BEFORE_MINUS_2PCT_4H_CLOSED_SPOT_V1'},
      capture_summary:{
        rows:hybridRows.length,
        distinct_symbols:new Set(hybridRows.map(row=>row.symbol)).size,
        distinct_decision_times:new Set(hybridRows.map(row=>row.at)).size,
        observed_market_regimes:[...new Set(hybridRows.map(row=>row.market_regime))],
        agg_trade_flow_rows:hybridRows.filter(row=>
          Array.isArray(row.sequence)&&row.sequence.filter(step=>step[20]===1).length/row.sequence.length>=0.8).length,
        trade_level_volume_profile_rows:hybridRows.filter(row=>row.trade_level_volume_profile_available).length,
        relative_btc_rows:hybridRows.filter(row=>
          Array.isArray(row.sequence)&&row.sequence.filter(step=>step[22]===1).length/row.sequence.length>=0.8).length
      },
      rows:hybridRows
    };
    const hybridTemp=hybridBenchmarkOutput+'.tmp-'+process.pid;
    await writeFile(hybridTemp,JSON.stringify(hybridDataset)+'\n',{encoding:'utf8',flag:'wx'});
    await rename(hybridTemp,hybridBenchmarkOutput);
    hybridDatasetSummary={path:hybridBenchmarkOutput,rows:hybridRows.length,source_commit_sha:hybridSourceSha};
  }
  const matrix={...plan,generated_at:new Date().toISOString(),output_dir:outputDir,windows:results,
    hybrid_benchmark_dataset:hybridDatasetSummary,matrix_summary:{
    window_count:results.length,completed_windows:complete.length,coverage_incomplete_windows:results.length-complete.length,
    trade_fallback_windows:complete.filter(x=>x.summary.coverage_status==='COMPLETE_WITH_CANDLE_FALLBACK').length,
    regimes_observed:regimesObserved,required_regimes:HISTORICAL_MATRIX_REQUIRED_REGIMES,
    missing_required_regimes:missingRequiredRegimes,regime_coverage_complete:regimeCoverageComplete,status
  }};
  const finalPath=resolve(outputDir,'matrix-summary.json');
  await writeFile(finalPath,JSON.stringify(matrix,null,2)+'\n');
  process.stdout.write('[MATRIX_SUMMARY] '+finalPath+'\n'+JSON.stringify(matrix.matrix_summary)+'\n');
  if(!['COMPLETE','COMPLETE_WITH_FALLBACK'].includes(matrix.matrix_summary.status)||results.some(x=>x.process.exit_code===1||x.process.timed_out))process.exitCode=2;
}
main().catch(error=>{process.stderr.write('[MATRIX_ERROR] '+String(error?.stack??error)+'\n');process.exitCode=1;});
