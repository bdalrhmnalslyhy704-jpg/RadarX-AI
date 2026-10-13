#!/usr/bin/env node
import {spawn} from 'node:child_process';
import {mkdir,readFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {CONFIG} from '../config.mjs';
import {RestClient} from '../market/binance-rest.mjs';
import {HISTORICAL_MATRIX_DEFAULT_SYMBOLS,HISTORICAL_MATRIX_DEFAULT_WINDOWS,normalizeMatrixSymbols,normalizeMatrixWindows,classifyBtcMarketRegime,summarizeHistoricalWindowReport} from '../core/historical-replay-matrix.mjs';

const HOUR_MS=60*60*1000;
const here=dirname(fileURLToPath(import.meta.url));
const replayScript=resolve(here,'historical-replay.mjs');
function flag(args,name,fallback=null){const i=args.indexOf(name);return i<0?fallback:(args[i+1]??fallback);}
function integer(raw,fallback,min,max,label){const n=Math.trunc(Number(raw??fallback));if(!Number.isFinite(n)||n<min||n>max)throw new Error('INVALID_'+label.toUpperCase());return n;}
function isoArg(value){const n=Date.parse(String(value??''));if(!Number.isFinite(n))throw new Error('INVALID_MATRIX_TIME');return new Date(n).toISOString();}
async function loadWindows(path){if(!path)return HISTORICAL_MATRIX_DEFAULT_WINDOWS;const raw=JSON.parse(await readFile(resolve(path),'utf8'));if(!Array.isArray(raw))throw new Error('WINDOWS_JSON_MUST_BE_ARRAY');return raw;}
async function classifyWindow(client,window){
  try{
    const result=await client.klines('BTCUSDT','1h',{limit:Math.max(4,Math.min(1000,Math.ceil((window.endMs-window.startMs)/HOUR_MS)+2)),startTime:window.startMs,endTime:window.endMs-1});
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
      '       [--max-trade-pages 60] [--max-trades 60000] [--output reports/radarx-matrix] [--dry-run]',
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
  const timeoutMs=integer(flag(args,'--timeout-ms','1800000'),1800000,60000,7200000,'timeout-ms');
  const outputDir=resolve(flag(args,'--output','./reports/radarx-historical-matrix-'+new Date().toISOString().replace(/[:.]/g,'-')));
  const plan={engine:'RADARX_HISTORICAL_REPLAY_MATRIX_V1',created_at:new Date().toISOString(),symbol_count:symbols.length,window_count:windows.length,planned_symbol_window_replays:symbols.length*windows.length,symbols,windows:windows.map(w=>({id:w.id,label:w.label,start:w.start,end:w.end})),limits:{max_trade_pages_per_symbol:maxTradePages,max_trades_per_symbol:maxTrades,timeout_ms_per_window:timeoutMs},policy:{market:'BINANCE_SPOT',paper_trading:true,real_order_execution:false,confidence_score:'UNKNOWN'}};
  if(args.includes('--dry-run')){process.stdout.write(JSON.stringify({...plan,status:'DRY_RUN_NO_NETWORK'},null,2)+'\n');return;}
  await mkdir(outputDir,{recursive:true});
  const client=new RestClient({...CONFIG.rest,baseUrls:CONFIG.rest.baseUrls??CONFIG.rest.urls});
  const results=[];
  for(let i=0;i<windows.length;i++){
    const window=windows[i];
    process.stderr.write('[MATRIX] '+window.id+' '+window.start+' .. '+window.end+' ('+(i+1)+'/'+windows.length+')\n');
    const marketRegime=await classifyWindow(client,window);
    const rawPath=resolve(outputDir,window.id+'.json');
    const childArgs=[replayScript,'--symbols',symbols.join(','),'--start',String(window.startMs),'--end',String(window.endMs-1),'--max-trade-pages',String(maxTradePages),'--max-trades',String(maxTrades),'--output',rawPath];
    const child=await runChild(childArgs,{timeoutMs,windowId:window.id});
    let rawReport=null,parseError=null;
    try{rawReport=JSON.parse(await readFile(rawPath,'utf8'));}catch(error){parseError=String(error?.message??error);}
    const summary=rawReport?summarizeHistoricalWindowReport(rawReport):{requested_symbols:symbols.length,returned_symbol_results:0,coverage_complete_symbols:0,coverage_incomplete_symbols:symbols.length,coverage_status:'INCOMPLETE_OR_EMPTY'};
    results.push({id:window.id,label:window.label,window:{start:window.start,end:window.end},market_regime:marketRegime,process:{exit_code:child.exitCode,timed_out:child.timedOut,error:child.error??parseError},report_path:rawPath,summary});
  }
  const complete=results.filter(x=>['COMPLETE','COMPLETE_WITH_CANDLE_FALLBACK'].includes(x.summary.coverage_status)&&x.market_regime.regime!=='UNKNOWN');
  const hasCandleFallback=complete.some(x=>x.summary.coverage_status==='COMPLETE_WITH_CANDLE_FALLBACK');
  const matrix={...plan,generated_at:new Date().toISOString(),output_dir:outputDir,windows:results,matrix_summary:{window_count:results.length,completed_windows:complete.length,coverage_incomplete_windows:results.length-complete.length,trade_fallback_windows:complete.filter(x=>x.summary.coverage_status==='COMPLETE_WITH_CANDLE_FALLBACK').length,regimes_observed:[...new Set(results.map(x=>x.market_regime.regime))],status:complete.length!==results.length?'INCOMPLETE_OR_PARTIAL':(hasCandleFallback?'COMPLETE_WITH_FALLBACK':'COMPLETE')},};
  const finalPath=resolve(outputDir,'matrix-summary.json');
  const {writeFile}=await import('node:fs/promises');
  await writeFile(finalPath,JSON.stringify(matrix,null,2)+'\n');
  process.stdout.write('[MATRIX_SUMMARY] '+finalPath+'\n'+JSON.stringify(matrix.matrix_summary)+'\n');
  if(!['COMPLETE','COMPLETE_WITH_FALLBACK'].includes(matrix.matrix_summary.status)||results.some(x=>x.process.exit_code===1||x.process.timed_out))process.exitCode=2;
}
main().catch(error=>{process.stderr.write('[MATRIX_ERROR] '+String(error?.stack??error)+'\n');process.exitCode=1;});
