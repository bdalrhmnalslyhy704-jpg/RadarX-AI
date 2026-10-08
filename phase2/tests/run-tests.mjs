import {spawn} from 'node:child_process';

const phase1=[
  'phase1/tests/engine.test.mjs',
  'phase1/tests/pwa.test.mjs',
  'phase1/tests/strategy-batch1.test.mjs',
  'phase1/tests/strategy-fractal-ma.test.mjs',
  'phase1/tests/strategy-registry.test.mjs'
];

const phase2=[
  'phase2/tests/api.test.mjs',
  'phase2/tests/autonomous-agent-market.test.mjs',
  'phase2/tests/supreme-fusion.test.mjs',
  'phase2/tests/market-surge-gate.test.mjs',
  'phase2/tests/data-quality.test.mjs',
  'phase2/tests/elite-confluence-gate.test.mjs',
  'phase2/tests/radar-advanced-confluence.test.mjs',
  'phase2/tests/radar-prebreakout-engine.test.mjs',
  'phase2/tests/radar-notification-gate.test.mjs',
  'phase2/tests/dedup.test.mjs',
  'phase2/tests/early-move-sentinel.test.mjs',
  'phase2/tests/early-expansion-radar.test.mjs',
  'phase2/tests/end-to-end.test.mjs',
  'phase2/tests/frontend-contract.test.mjs',
  'phase2/tests/integration-failures.test.mjs',
  'phase2/tests/ai-agent-hub.test.mjs',
  'phase2/tests/king-intelligence.test.mjs',
  'phase2/tests/liquidity-absorption-radar.test.mjs',
  'phase2/tests/radar-suite-v2.test.mjs',
  'phase2/tests/professor-radar.test.mjs',
  'phase2/tests/kahir-radar.test.mjs',
  'phase2/tests/market-radar.test.mjs',
  'phase2/tests/monitor-phone-independence.test.mjs',
  'phase2/tests/monitor.test.mjs',
  'phase2/tests/policy.test.mjs',
  'phase2/tests/push.test.mjs',
  'phase2/tests/real-push-staging.test.mjs',
  'phase2/tests/rest.test.mjs',
  'phase2/tests/rotation-lag-radar.test.mjs',
  'phase2/tests/runtime-compatibility.test.mjs',
  'phase2/tests/source-policy.test.mjs',
  'phase2/tests/staging-preflight.test.mjs',
  'phase2/tests/store.test.mjs',
  'phase2/tests/strategy-market-radar-integration.test.mjs',
  'phase2/tests/strong-move-radar.test.mjs',
  'phase2/tests/symbol-deep-scan.test.mjs',
  'phase2/tests/ws.test.mjs'
];

const scope=process.argv[2]||'all';
const files=scope==='phase1'?phase1:scope==='phase2'?phase2:[...phase1,...phase2];
const FILE_TIMEOUT_MS=75000;
const TEST_TIMEOUT_MS=60000;

async function runFile(file){
  console.error('[TEST FILE START] '+file);
  const child=spawn(process.execPath,['--test','--test-timeout='+TEST_TIMEOUT_MS,file],{stdio:['ignore','pipe','pipe'],env:{...process.env}});
  child.stdout.on('data',b=>process.stdout.write(b));
  child.stderr.on('data',b=>process.stderr.write(b));
  let timedOut=false;
  const watchdog=setTimeout(()=>{
    timedOut=true;
    console.error('[TEST FILE TIMEOUT] '+file+' after '+FILE_TIMEOUT_MS+'ms');
    try{child.kill('SIGTERM');}catch{}
  },FILE_TIMEOUT_MS);
  const code=await new Promise(resolve=>{
    child.on('error',err=>{console.error('[TEST FILE ERROR] '+file+' '+(err?.stack||err));resolve(1);});
    child.on('exit',(exitCode,signal)=>resolve(exitCode??(signal?1:0)));
  });
  clearTimeout(watchdog);
  console.error('[TEST FILE END] '+file+' exit_code='+code+(timedOut?' timeout=true':''));
  return code===0&&!timedOut;
}

let ok=true;
for(const file of files){
  if(!(await runFile(file)))ok=false;
}
console.error('[TEST SUITE END] scope='+scope+' status='+(ok?'success':'failure'));
process.exitCode=ok?0:1;
