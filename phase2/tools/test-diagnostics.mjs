import {spawn} from 'node:child_process';
import {readdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=resolve(fileURLToPath(new URL('../../',import.meta.url)));
const TIMEOUT_MS=15000;

async function testFiles(dir){
  return (await readdir(dir,{withFileTypes:true}))
    .filter(x=>x.isFile()&&x.name.endsWith('.test.mjs'))
    .map(x=>join(dir,x.name))
    .sort();
}

function runFile(file){
  return new Promise(resolveDone=>{
    const startedAt=Date.now();
    const child=spawn(process.execPath,['--import','./phase2/tools/test-diagnostics-preload.mjs','--test',file],{
      cwd:root,env:{...process.env,RADARX_TEST_DIAGNOSTICS:'1'},stdio:['ignore','pipe','pipe']
    });
    let output='',error='',lastTest='UNKNOWN';
    const consume=chunk=>{
      const s=chunk.toString();
      output+=s;
      for(const line of s.split(/\r?\n/)){
        if(/^\s*[✔✖]/.test(line)||/^\s*# Subtest:/.test(line))lastTest=line.trim();
      }
    };
    child.stdout.on('data',consume);
    child.stderr.on('data',chunk=>{error+=chunk.toString();});
    const timer=setTimeout(()=>{
      try{child.kill('SIGUSR2');}catch{}
      setTimeout(()=>{
        try{child.kill('SIGTERM');}catch{}
        resolveDone({file,status:'TIMEOUT',durationMs:Date.now()-startedAt,lastTest,output,error});
      },250);
    },TIMEOUT_MS);
    child.on('exit',(code,signal)=>{
      clearTimeout(timer);
      resolveDone({file,status:code===0?'PASS':'FAIL',exitCode:code,signal,durationMs:Date.now()-startedAt,lastTest,output,error});
    });
  });
}

async function runPhase(label,files){
  console.log('[RADARX-DIAG] '+label+'_START');
  let failed=0;
  for(const file of files){
    console.log('[RADARX-DIAG] FILE_START '+file);
    const r=await runFile(file);
    console.log('[RADARX-DIAG] FILE_END '+JSON.stringify({
      file:r.file,status:r.status,exitCode:r.exitCode??null,signal:r.signal??null,
      durationMs:r.durationMs,lastTest:r.lastTest
    }));
    if(r.status!=='PASS'){
      failed++;
      console.log('[RADARX-DIAG] DETAILS\n'+r.output+'\n'+r.error);
    }
  }
  console.log('[RADARX-DIAG] '+label+'_END failed_files='+failed);
  return failed;
}

const phase1=await testFiles(join(root,'phase1/tests'));
const phase2=await testFiles(join(root,'phase2/tests'));
const failed1=await runPhase('PHASE1',phase1);
const failed2=await runPhase('PHASE2',phase2);
process.exitCode=failed1||failed2?1:0;
