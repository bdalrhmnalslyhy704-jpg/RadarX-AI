#!/usr/bin/env node
import {readFile,writeFile,rename,mkdir} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {
  validateAndPrepareDense4hRows,splitDense4hChronologically,
  runDense4hGeneralizationBenchmark
} from '../core/dense-generalization-projection.mjs';

function parseArgs(argv){
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
const args=parseArgs(process.argv);
const inputPath=args.input?resolve(args.input):null;
const outputPath=resolve(args.output||'reports/neural-closure/dense-4h-benchmark.json');
const sourceCommitSha=args['source-commit-sha']||process.env.GITHUB_SHA||'';
const epochs=args.epochs?Number(args.epochs):36;
const bootstrapIterations=args['bootstrap-iterations']?Number(args['bootstrap-iterations']):400;
if(!inputPath)throw new Error('--input_REQUIRED');
let report,inputFileSha256=null,exitCode=0;
try{
  if(!Number.isInteger(epochs)||epochs<10||epochs>100)
    throw new Error('DENSE4H_EPOCHS_MUST_BE_INTEGER_10_TO_100');
  if(!Number.isInteger(bootstrapIterations)||bootstrapIterations<100||bootstrapIterations>5000)
    throw new Error('DENSE4H_BOOTSTRAP_ITERATIONS_MUST_BE_INTEGER_100_TO_5000');
  const bytes=await readFile(inputPath);
  inputFileSha256=createHash('sha256').update(bytes).digest('hex');
  const input=JSON.parse(bytes.toString('utf8'));
  if(!Array.isArray(input?.rows))throw new Error('DENSE4H_INPUT_ROWS_ARRAY_REQUIRED');
  const prepared=validateAndPrepareDense4hRows(input.rows);
  prepared.source_file_sha256=inputFileSha256;
  const split=splitDense4hChronologically(prepared.rows);
  report=runDense4hGeneralizationBenchmark(prepared,split,{
    sourceCommitSha,epochs,bootstrapIterations
  });
  report.integrity={
    input_file_sha256:inputFileSha256,input_file_path:inputPath,
    dataset_identity_sha256:prepared.identity_feature_sha256,
    source_commit_sha:String(sourceCommitSha).toLowerCase()
  };
  if(report.status!=='DENSE4H_OOS_SUPERIORITY_VERIFIED')exitCode=1;
}catch(error){
  exitCode=1;
  report={
    schema:'RADARX_DENSE_4H_FIRST_TOUCH_V1',
    status:'DENSE4H_BENCHMARK_INVALID',
    integrity:{
      input_file_sha256:inputFileSha256,input_file_path:inputPath,
      source_commit_sha:/^[a-f0-9]{40}$/i.test(sourceCommitSha)
        ?String(sourceCommitSha).toLowerCase():null
    },
    failure:{
      code:String(error?.code||error?.message||'UNKNOWN_DENSE4H_FAILURE'),
      stack:String(error?.stack||'').split('\\n').slice(0,8)
    },
    policy:{paper_trading:true,real_order_execution:false,production_touched:false}
  };
}
await mkdir(dirname(outputPath),{recursive:true});
const temporary=outputPath+'.tmp-'+process.pid;
await writeFile(temporary,JSON.stringify(report,null,2)+'\\n',{flag:'wx'});
await rename(temporary,outputPath);
console.log(JSON.stringify({
  status:report.status,output:outputPath,
  source_commit_sha:report.integrity?.source_commit_sha??null,
  input_file_sha256:report.integrity?.input_file_sha256??null,
  model_artifact_sha256:report.model_artifact_sha256??null,
  failure:report.failure?.code??null
},null,2));
process.exitCode=exitCode;
