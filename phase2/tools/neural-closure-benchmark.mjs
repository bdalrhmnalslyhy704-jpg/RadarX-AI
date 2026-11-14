#!/usr/bin/env node
import {readFile,writeFile,rename,mkdir} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {runNeuralClosureBenchmark} from '../core/neural-closure-contracts.mjs';

function argsMap(argv){
  const values={};
  for(let index=2;index<argv.length;index++){
    const key=argv[index];
    if(!key.startsWith('--'))throw new Error('UNKNOWN_ARGUMENT:'+key);
    const value=argv[index+1];
    if(value===undefined||value.startsWith('--'))throw new Error('ARGUMENT_VALUE_MISSING:'+key);
    values[key.slice(2)]=value;index++;
  }
  return values;
}
const args=argsMap(process.argv);
const inputPath=args.input?resolve(args.input):null;
const outputPath=resolve(args.output||'reports/neural-closure/fixed-sha-benchmark.json');
const sourceCommitSha=args['source-commit-sha']||process.env.GITHUB_SHA||'';
if(!inputPath)throw new Error('--input_REQUIRED');
let report;
let exitCode=0;
let inputSha=null;
try{
  const bytes=await readFile(inputPath);
  inputSha=createHash('sha256').update(bytes).digest('hex');
  const input=JSON.parse(bytes.toString('utf8'));
  report=runNeuralClosureBenchmark({
    rows:input.rows,
    predictionsByModel:input.predictions_by_model,
    sourceCommitSha,
    minimumClassSupport:args['minimum-class-support']
      ?Number(args['minimum-class-support']):undefined,
    roundTripCostBps:args['round-trip-cost-bps']
      ?Number(args['round-trip-cost-bps']):30,
    minimumHoldoutTrades:args['minimum-holdout-trades']
      ?Number(args['minimum-holdout-trades']):100,
    minimumWinRatePct:args['minimum-win-rate-pct']
      ?Number(args['minimum-win-rate-pct']):55,
    maximumDrawdownPct:args['maximum-drawdown-pct']
      ?Number(args['maximum-drawdown-pct']):8
  });
  report.integrity.input_file_sha256=inputSha;
  report.integrity.input_file_path=inputPath;
  if(report.status!=='NEURAL_SUPERIORITY_PROVEN')exitCode=1;
}catch(error){
  exitCode=1;
  report={
    schema:'RADARX_BUILD224_FIXED_SHA_NEURAL_CLOSURE_BENCHMARK_V1',
    status:'BENCHMARK_INVALID',
    integrity:{
      source_commit_sha:/^[a-f0-9]{40}$/i.test(sourceCommitSha)?sourceCommitSha.toLowerCase():null,
      input_file_sha256:inputSha,input_file_path:inputPath,
      fixed_benchmark_sha256:null
    },
    failure:{
      code:String(error?.code||error?.message||'UNKNOWN_BENCHMARK_FAILURE'),
      stack:String(error?.stack||'').split('\n').slice(0,8)
    },
    policy:{paper_trading:true,real_order_execution:false,market:'BINANCE_SPOT_ONLY'}
  };
}
await mkdir(dirname(outputPath),{recursive:true});
const temporary=outputPath+'.tmp-'+process.pid;
await writeFile(temporary,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
await rename(temporary,outputPath);
console.log(JSON.stringify({
  status:report.status,output:outputPath,
  source_commit_sha:report.integrity?.source_commit_sha,
  dataset_sha256:report.integrity?.dataset_sha256??null,
  fixed_benchmark_sha256:report.integrity?.fixed_benchmark_sha256??null,
  failure:report.failure?.code??null
},null,2));
process.exitCode=exitCode;
