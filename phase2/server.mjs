import {fileURLToPath} from 'node:url';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {CONFIG} from './config.mjs';
import {RestClient} from './market/binance-rest.mjs';
import {BinanceStreamClient} from './market/binance-ws.mjs';
import {BinanceAllMarketTickerClient} from './market/binance-market-ticker-ws.mjs';
import {MarketWideKlineCache} from './market/market-wide-kline-cache.mjs';
import {DurableStore} from './core/store.mjs';
import {SignalDeduplicator} from './core/dedup.mjs';
import {SignalService} from './core/signal-service.mjs';
import {createPushProvider,PushManager} from './push/index.mjs';
import {MarketMonitor} from './core/monitor.mjs';
import {EarlyMoveSentinel} from './core/early-move-sentinel.mjs';
import {StrongMoveRadar} from './core/strong-move-radar.mjs';
import {RotationLagRadar} from './core/rotation-lag-radar.mjs';
import {LiquidityAbsorptionRadar} from './core/liquidity-absorption-radar.mjs';
import {KahirRadar} from './core/kahir-radar.mjs';
import {ProfessorRadar} from './core/professor-radar.mjs';
import {DoomsdayRadar} from './core/doomsday-radar.mjs';
import {AlMuqawimRadar} from './core/al-muqawim-radar.mjs';
import {EarlyExpansionRadar} from './core/early-expansion-radar.mjs';
import {CoinHunterRadar} from './core/coin-hunter-radar.mjs';
import {WhaleAccumulationRadar} from './core/whale-accumulation-radar.mjs';
import {FalconEyeRadar} from './core/falcon-eye-radar.mjs';
import {SymbolDeepAnalyzer} from './core/symbol-deep-analyzer.mjs';
import {MarketUniverseScanner} from './market/universe-scanner.mjs';
import {createApiServer} from './http/api.mjs';
import {assertDeploymentEnvironment,assertReadOnlyStagingConfig} from './deploy/preflight.mjs';
import {sanitizeLogMessage} from './runtime.mjs';
import {MultiAnalystEngine} from './core/multi-analyst-engine.mjs';
import {RadarSwarmCoordinator} from './core/radar-swarm-coordinator.mjs';
import {RadarSignalOutcomeWorker} from './core/radar-signal-outcomes.mjs';


import {instrumentRadarCycle} from './core/radar-telemetry.mjs';
import {connectRadarAlertsToAnalysts} from './core/radar-analyst-bridge.mjs';

export async function startServer({
  config=CONFIG,
  logger=console,
  monitorFactory=opts=>new MarketMonitor({...opts,wsFactory:wsOpts=>new BinanceStreamClient(wsOpts)})
}={}){
  if(['staging','production'].includes(config.environment)){
    assertDeploymentEnvironment(process.env);
    assertReadOnlyStagingConfig(config);
  }
  const onRailway=Boolean(process.env.RAILWAY_SERVICE_ID||process.env.RAILWAY_ENVIRONMENT);
  const archiveDir=process.env.RADARX_DATA_DIR||(onRailway?'/data/.radarx-data':'./.radarx-data');
  const store=await new DurableStore({dir:archiveDir}).init({legacyDir:onRailway?'./.radarx-data':null});
  logger.info?.('[RADARX_ARCHIVE_TEMP_CLEANUP] '+JSON.stringify({
    build_version:'Build 224',store_dir:store.dir,...(store.tempCleanup||{deleted_files:0,freed_bytes:0,failed_files:0})
  }));
  const outcomeLedgerCompaction=await store.compactPreExpansionOutcomes({maxRecords:1500,maxStageKeys:4000});
  logger.info?.('[RADARX_OUTCOME_LEDGER_COMPACTION] '+JSON.stringify({
    build_version:'Build 224',store_dir:store.dir,...outcomeLedgerCompaction
  }));
  const archiveState=await store.getPreExpansionOutcomes().catch(()=>({}));
  const archiveRecords=Array.isArray(archiveState?.records)?archiveState.records:[];
  let archiveVolumeMounted=null;
  if(onRailway){
    try{
      const mounts=await readFile('/proc/mounts','utf8');
      archiveVolumeMounted=mounts.split('\n').some(line=>{
        const mountPoint=line.split(' ')[1]?.replace(/\\040/g,' ');
        return mountPoint==='/data'||mountPoint?.startsWith('/data/');
      });
    }catch{archiveVolumeMounted=false;}
  }
  // Stream the exact JSON array representation into SHA-256. Building both a
  // second 5,000-row mapped array and one giant JSON string briefly duplicated
  // the whole outcome ledger in memory during startup.
  const archiveDigestHash=createHash('sha256');
  archiveDigestHash.update('[');
  for(let index=0;index<archiveRecords.length;index++){
    if(index)archiveDigestHash.update(',');
    const row=archiveRecords[index];
    archiveDigestHash.update(JSON.stringify({
      signal_id:row?.signal_id,radar:row?.radar,symbol:row?.symbol,detected_at:row?.detected_at,
      marks:row?.marks,horizon_status:row?.horizon_status
    }));
  }
  archiveDigestHash.update(']');
  const archiveDigest=archiveDigestHash.digest('hex');
  const archiveAnchor=[...archiveRecords].sort((a,b)=>Number(a?.detected_at||0)-Number(b?.detected_at||0))[0]||null;
  const archiveLatest=archiveRecords.reduce((latest,row)=>
    Number(row?.detected_at||0)>Number(latest?.detected_at||0)?row:latest,null);
  const archiveHorizonCounts=Object.fromEntries(['5m','15m','30m','60m','4h','24h'].map(h=>{
    const complete=archiveRecords.filter(row=>row?.marks?.[h]?.sample_quality==='HISTORICAL_CLOSED_OHLC'&&
      row?.excursions?.[h]?.source==='HISTORICAL_CLOSED_OHLC'&&row?.excursions?.[h]?.complete===true).length;
    const incomplete=archiveRecords.filter(row=>row?.horizon_status?.[h]?.status==='INCOMPLETE'||
      (row?.marks?.[h]?.sample_quality==='HISTORICAL_CLOSED_OHLC'&&row?.excursions?.[h]?.complete!==true)).length;
    const provisional=archiveRecords.filter(row=>Boolean(row?.provisional_marks?.[h])).length;
    return [h,{complete,incomplete,pending:Math.max(0,archiveRecords.length-complete-incomplete),
      provisional,records:archiveRecords.length}];
  }));
  const runtimeBuildCommit=String(
    process.env.RADARX_BUILD_COMMIT??process.env.SOURCE_COMMIT??process.env.GIT_COMMIT??
    process.env.COMMIT_SHA??process.env.CI_COMMIT_SHA??process.env.SOURCE_VERSION??
    process.env.RAILWAY_GIT_COMMIT_SHA??process.env.GITHUB_SHA??process.env.VERCEL_GIT_COMMIT_SHA??''
  ).trim()||null;
  const runtimeBuildBranch=String(
    process.env.RADARX_BUILD_BRANCH??process.env.SOURCE_BRANCH??process.env.GIT_BRANCH??
    process.env.BRANCH_NAME??process.env.CI_COMMIT_BRANCH??process.env.RAILWAY_GIT_BRANCH??
    process.env.GITHUB_REF_NAME??process.env.VERCEL_GIT_COMMIT_REF??''
  ).trim()||null;
  logger.info?.('[RADARX_ARCHIVE_READY] '+JSON.stringify({
    build_version:'Build 224',build_commit:runtimeBuildCommit,
    build_branch:runtimeBuildBranch,service_id:process.env.RAILWAY_SERVICE_ID||null,
    deployment_id:process.env.RAILWAY_DEPLOYMENT_ID||null,store_dir:store.dir,
    outcome_store_file:store.files.preExpansionOutcomes,volume_mount_path:onRailway?'/data':null,
    volume_mount_detected:archiveVolumeMounted,persisted_signal_count:archiveRecords.length,
    oldest_signal_id:archiveAnchor?.signal_id||null,oldest_signal_detected_at:archiveAnchor?.detected_at||null,
    latest_signal_id:archiveLatest?.signal_id||null,latest_signal_detected_at:archiveLatest?.detected_at||null,
    horizon_counts:archiveHorizonCounts,
    historical_complete_count:archiveRecords.filter(row=>row?.outcome_status==='COMPLETE'&&row?.historical_evaluation===true).length,
    incomplete_count:archiveRecords.filter(row=>row?.outcome_status==='INCOMPLETE').length,
    migrated_legacy_files:store.migratedFiles,records_sha256:archiveDigest
  }));
  const rest=new RestClient({...config.rest,baseUrls:config.rest.baseUrls??config.rest.urls});
  // Outcome work is deliberately bounded: at most two public-Spot kline requests
  // per minute, using stored alerts and real closed candles only.
  const radarSignalOutcomeWorker=new RadarSignalOutcomeWorker({store,rest,logger,pollMs:60_000,maxRestCalls:2});
  const dedup=new SignalDeduplicator({store,windowMs:15*60*1000});
  const provider=createPushProvider(config.push);
  const push=new PushManager({provider,store,deduplicator:dedup,retryBaseMs:config.monitoring.pushRetryMs});
  const service=new SignalService({deduplicator:dedup,store,pushManager:push,config});
  const monitor=monitorFactory({config,rest,signalService:service,store,pushManager:push,logger});
  const marketRadarRestUrls=[
    'https://data-api.binance.vision',
    ...(config.rest.baseUrls??config.rest.urls??[])
  ].filter((url,index,arr)=>arr.indexOf(url)===index);
  const marketRadarRest=new RestClient({...config.rest,baseUrls:marketRadarRestUrls});
  const moveConfig={...(config.moveRadar||{})};
  const moveScanner=new MarketUniverseScanner({rest,config:{
    minQuoteVolume24h:moveConfig.minQuoteVolume24h,
    minDataQuality:moveConfig.minDataQuality,
    minLiquidityQuality:moveConfig.minLiquidityQuality,
    deepKlines:moveConfig.deepKlines,
    deepConcurrency:moveConfig.deepConcurrency
  }});
  const moveSentinel=new EarlyMoveSentinel({
    rest,store,pushManager:push,config:moveConfig,logger,
    scannerFactory:()=>moveScanner,
    tickerWsFactory:opts=>new BinanceAllMarketTickerClient(opts)
  });
  const strongRadarRest=new RestClient({...config.rest,baseUrls:config.rest.baseUrls??config.rest.urls});
  const strongMoveRadar=new StrongMoveRadar({rest:strongRadarRest,store,pushManager:push,config:config.strongMoveRadar||{},logger});
  const rotationRadarRest=new RestClient({...config.rest,baseUrls:config.rest.baseUrls??config.rest.urls});
  const rotationLagRadar=new RotationLagRadar({rest:rotationRadarRest,store,pushManager:push,config:config.rotationRadar||{},logger});
  const liquidityRadarRest=new RestClient({...config.rest,baseUrls:config.rest.baseUrls??config.rest.urls});
  const liquidityAbsorptionRadar=new LiquidityAbsorptionRadar({rest:liquidityRadarRest,store,pushManager:push,config:config.liquidityAbsorptionRadar||{},logger});
  const kahirRadarRest=new RestClient({...config.rest,baseUrls:config.rest.baseUrls??config.rest.urls});
  const kahirRadar=new KahirRadar({rest:kahirRadarRest,store,pushManager:push,config:config.kahirRadar||{},logger});
  // The deep symbol scanner gets its own REST client so background radar traffic cannot
  // race its endpoint selection. Prefer Binance's market-data-only mirror first; it is
  // explicitly documented to serve depth, klines and 24h ticker without authentication.
  const deepRestUrls=[
    'https://data-api.binance.vision',
    ...(config.rest.baseUrls??config.rest.urls??[])
  ].filter((url,index,arr)=>arr.indexOf(url)===index);
  const deepScanRest=new RestClient({...config.rest,baseUrls:deepRestUrls});
  const symbolDeepAnalyzer=new SymbolDeepAnalyzer({rest:deepScanRest,config:config.symbolDeepScan||{}});
  const professorRadar=new ProfessorRadar({rest,store,pushManager:push,deepAnalyzer:symbolDeepAnalyzer,config:config.professorRadar||{},logger});
  const doomsdayRadar=new DoomsdayRadar({rest,store,pushManager:push,config:config.doomsdayRadar||{},logger});
  const multiAnalystRestUrls=[
    'https://data-api.binance.vision',
    ...(config.rest.baseUrls??config.rest.urls??[])
  ].filter((url,index,arr)=>arr.indexOf(url)===index);
  const multiAnalystRest=new RestClient({...config.rest,baseUrls:multiAnalystRestUrls});
  const multiAnalystRadar=new MultiAnalystEngine({rest:multiAnalystRest,store,config:config.multiAnalyst||{}});
  const alMuqawimRadar=new AlMuqawimRadar({rest,store,pushManager:push,config:config.alMuqawimRadar||{},logger});
  const marketWideKlineCache=new MarketWideKlineCache({
    rest,
    urls:config.websocket.urls,
    initialBackoffMs:config.websocket.initialBackoffMs,
    maxBackoffMs:config.websocket.maxBackoffMs,
    jitterRatio:config.websocket.jitterRatio,
    heartbeatTimeoutMs:config.websocket.heartbeatTimeoutMs,
    maxConnectionMs:config.websocket.maxConnectionMs,
    maxCandlesPerSymbol:120,
    logger
  });
  const earlyExpansionRadar=new EarlyExpansionRadar({rest,store,pushManager:push,marketWideKlineCache,config:config.earlyExpansionRadar||{},logger});
  const coinHunterUrls=['https://data-api.binance.vision',...(config.rest.baseUrls??config.rest.urls??[])].filter((url,index,arr)=>arr.indexOf(url)===index);
  const coinHunterRest=new RestClient({...config.rest,baseUrls:coinHunterUrls});
  const coinHunterRadar=new CoinHunterRadar({rest:coinHunterRest,store,pushManager:push,config:config.coinHunterRadar||{},logger});
  const whaleAccumulationUrls=['https://data-api.binance.vision',...(config.rest.baseUrls??config.rest.urls??[])].filter((url,index,arr)=>arr.indexOf(url)===index);
  const whaleAccumulationRest=new RestClient({...config.rest,baseUrls:whaleAccumulationUrls});
  const whaleAccumulationRadar=new WhaleAccumulationRadar({rest:whaleAccumulationRest,store,pushManager:push,config:config.whaleAccumulationRadar||{},logger});
  // Falcon Eye uses public Binance Spot + public Futures market data. No API keys are required.
  const falconFuturesRest=new RestClient({...config.rest,baseUrls:['https://fapi.binance.com']});
  const falconEyeRadar=new FalconEyeRadar({rest, futuresRest:falconFuturesRest, store, pushManager:push, config:config.falconEyeRadar||{}, logger});
  const radarSwarm=new RadarSwarmCoordinator({expectedCount:12,startupSpacingMs:config.radarSwarm?.startupSpacingMs??700,logger,runners:[
    {id:'RADAR1',name:'المدمر',instance:moveSentinel},
    {id:'RADAR2',name:'ملك الظلام',instance:strongMoveRadar},
    {id:'RADAR3',name:'الجوكر',instance:rotationLagRadar},
    {id:'RADAR4',name:'الكاسح',instance:liquidityAbsorptionRadar},
    {id:'RADAR5',name:'القاهر',instance:kahirRadar},
    {id:'RADAR6',name:'يوم القيامة',instance:doomsdayRadar},
    {id:'RADAR7',name:'المقاوم',instance:alMuqawimRadar},
    {id:'RADAR8',name:'البرق',instance:earlyExpansionRadar},
    {id:'RADAR9_FALCON_EYE',name:'عين الصقر',instance:falconEyeRadar},
    {id:'RADAR10_COIN_HUNTER',name:'صائد العملات',instance:coinHunterRadar},
    {id:'RADAR11_WHALE',name:'تجمع الحيتان',instance:whaleAccumulationRadar},
    {id:'RADAR12_PROFESSOR',name:'البروفيسور',instance:professorRadar}
  ]});
  // Install cycle timing before any radar starts so the first real cycle is measured.
  const radarCycleTelemetrySetup=[
    ['RADAR1',moveSentinel],['RADAR2',strongMoveRadar],['RADAR3',rotationLagRadar],
    ['RADAR4',liquidityAbsorptionRadar],['RADAR5',kahirRadar],['RADAR6',doomsdayRadar],
    ['RADAR7',alMuqawimRadar],['RADAR8',earlyExpansionRadar],['RADAR9_FALCON_EYE',falconEyeRadar],
    ['RADAR10_COIN_HUNTER',coinHunterRadar],['RADAR11_WHALE',whaleAccumulationRadar],
    ['RADAR12_PROFESSOR',professorRadar]
  ].map(([radar,instance])=>({radar,instrumented:instrumentRadarCycle(instance,radar)}));
  logger.info?.('[RADAR_CYCLE_TELEMETRY_SETUP] '+JSON.stringify({
    expected:12,instrumented:radarCycleTelemetrySetup.filter(x=>x.instrumented).length,
    skipped:radarCycleTelemetrySetup.filter(x=>!x.instrumented).map(x=>x.radar)
  }));
  // Queue emitted radar symbols for the next bounded analyst scan without waiting
  // for that scan or changing the existing push-delivery decision.
  const analystReviewBridge=connectRadarAlertsToAnalysts({pushManager:push,multiAnalystRadar,logger});
  logger.info?.('[RADAR_ANALYST_REVIEW_BRIDGE] '+JSON.stringify({
    ...analystReviewBridge,expected_specialists:19,expected_final_analyst:1,
    mode:'NON_BLOCKING_REVIEW_ONLY',paper_trading:true,real_order_execution:false
  }));
  const api=createApiServer({config,store,monitor,pushProvider:provider,pushManager:push,moveSentinel,strongMoveRadar,rotationLagRadar,liquidityAbsorptionRadar,kahirRadar,professorRadar,doomsdayRadar,alMuqawimRadar,symbolDeepAnalyzer,multiAnalystRadar,earlyExpansionRadar,coinHunterRadar,whaleAccumulationRadar,falconEyeRadar,marketRadarRest,radarSwarm,radarSignalOutcomeWorker});
  await new Promise((resolveStart,reject)=>api.listen(config.port,config.host,resolveStart).on('error',reject));
  logger.info('RadarX Phase 2 API listening on http://'+config.host+':'+config.port);
  const safeStart=(name,instance)=>{
    try{
      const result=instance.start();
      Promise.resolve(result).catch(error=>logger.warn?.(name+' start failed: '+String(error?.message??error)));
    }catch(error){
      logger.warn?.(name+' start failed: '+String(error?.message??error));
    }
  };
  safeStart('MONITOR',monitor);
  // Staging smoke tests must never start live market polling unless explicitly opted in.
  // Production retains the continuous analyst worker and all twelve coordinated radars.
  const explicitStagingRadarStart=process.env.RADARX_RADARS_AUTOSTART==='true';
  const stagingSmokeMode=config.environment==='staging'&&!explicitStagingRadarStart;
  if(!stagingSmokeMode){
    // Keep the 20-analyst intelligence cache warm continuously in real runtime environments.
    safeStart('MULTI_ANALYST_XFACTOR',multiAnalystRadar);
  } else {
    logger.info('Staging smoke mode: live market workers are disabled unless RADARX_RADARS_AUTOSTART=true.');
  }
  const autoStart=!stagingSmokeMode&&config.radarControl?.autostart!==false;
  if(autoStart){
    const swarmStatus=await radarSwarm.start();
    logger.info('[RADAR_SWARM_START] '+JSON.stringify({status:swarmStatus.status,expected:swarmStatus.expected_count,registered:swarmStatus.registered_count,spacing_ms:swarmStatus.startup_spacing_ms}));
  } else if(stagingSmokeMode){
    logger.info('[RADAR_SWARM_START] '+JSON.stringify({status:'DISABLED_FOR_STAGING_SMOKE',expected:12,registered:12,spacing_ms:config.radarSwarm?.startupSpacingMs??700}));
  } else {
    logger.info('Optional radar auto-start disabled; Falcon Eye remains an independent continuous recorder.');
    // Preserve Build 224's background discovery invariant when optional auto-start is disabled in production.
    safeStart('RADAR9',falconEyeRadar);
  }
  if(!stagingSmokeMode)safeStart('RADAR_SIGNAL_OUTCOME_WORKER',radarSignalOutcomeWorker);
  logger.info('Push provider: '+provider.status().provider+' enabled='+provider.status().enabled);
  return {server:api,monitor,moveSentinel,strongMoveRadar,rotationLagRadar,liquidityAbsorptionRadar,kahirRadar,professorRadar,doomsdayRadar,alMuqawimRadar,earlyExpansionRadar,marketWideKlineCache,coinHunterRadar,whaleAccumulationRadar,falconEyeRadar,radarSwarm,multiAnalystRadar,symbolDeepAnalyzer,store,strongRadarRest,rotationRadarRest,liquidityRadarRest,kahirRadarRest,multiAnalystRest,coinHunterRest,whaleAccumulationRest,marketRadarRest,radarSignalOutcomeWorker,push,close:async()=>{radarSignalOutcomeWorker.stop();await radarSwarm.stop();multiAnalystRadar.stop();await monitor.stop();api.closeAllConnections?.();await new Promise(r=>api.close(r));}};
}

if(process.argv[1]&&resolve(fileURLToPath(import.meta.url))===resolve(process.argv[1])){
  startServer().catch(error=>{console.error(sanitizeLogMessage(error?.stack??error,process.env));process.exitCode=1;});
}
