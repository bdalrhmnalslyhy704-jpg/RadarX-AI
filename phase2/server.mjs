import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {CONFIG} from './config.mjs';
import {RestClient} from './market/binance-rest.mjs';
import {BinanceStreamClient} from './market/binance-ws.mjs';
import {BinanceAllMarketTickerClient} from './market/binance-market-ticker-ws.mjs';
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
import {EarlyExpansionRadar} from './core/early-expansion-radar.mjs';
import {AlMuqawimRadar} from './core/al-muqawim-radar.mjs';
import {CoinHunterRadar} from './core/coin-hunter-radar.mjs';
import {WhaleAccumulationRadar} from './core/whale-accumulation-radar.mjs';
import {FalconEyeRadar} from './core/falcon-eye-radar.mjs';
import {RadarSwarmCoordinator} from './core/radar-swarm-coordinator.mjs';
import {SymbolDeepAnalyzer} from './core/symbol-deep-analyzer.mjs';
import {AutonomousAgentMarket} from './core/autonomous-agent-market.mjs';
import {MarketUniverseScanner} from './market/universe-scanner.mjs';
import {createApiServer} from './http/api.mjs';
import {assertDeploymentEnvironment,assertReadOnlyStagingConfig} from './deploy/preflight.mjs';
import {sanitizeLogMessage} from './runtime.mjs';
import {instrumentRadarCycle} from './core/radar-telemetry.mjs';

export async function startServer({
  config=CONFIG,
  logger=console,
  monitorFactory=opts=>new MarketMonitor({...opts,wsFactory:wsOpts=>new BinanceStreamClient(wsOpts)})
}={}){
  if(['staging','production'].includes(config.environment)){
    assertDeploymentEnvironment(process.env);
    assertReadOnlyStagingConfig(config);
  }
  const store=await new DurableStore({dir:process.env.RADARX_DATA_DIR||'./.radarx-data'}).init();
  const rest=new RestClient({...config.rest,baseUrls:config.rest.baseUrls??config.rest.urls});
  const dedup=new SignalDeduplicator({store,windowMs:15*60*1000});
  const provider=createPushProvider(config.push);
  const push=new PushManager({provider,store,deduplicator:dedup,retryBaseMs:config.monitoring.pushRetryMs});
  const service=new SignalService({deduplicator:dedup,store,pushManager:push,config});
  const monitor=monitorFactory({config,rest,signalService:service,store,pushManager:push,logger});
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
  const earlyExpansionRadarRest=new RestClient({...config.rest,baseUrls:deepRestUrls});
  const earlyExpansionRadar=new EarlyExpansionRadar({rest:earlyExpansionRadarRest,store,pushManager:push,config:config.earlyExpansionRadar||{},logger});
  // These workers use public market data only; one shared Spot REST client keeps the request budget coordinated.
  const alMuqawimRadar=new AlMuqawimRadar({rest,store,pushManager:push,config:config.alMuqawimRadar||{},logger});
  const coinHunterRadar=new CoinHunterRadar({rest,store,pushManager:push,config:config.coinHunterRadar||{},logger});
  const whaleAccumulationRadar=new WhaleAccumulationRadar({rest,store,pushManager:push,config:config.whaleAccumulationRadar||{},logger});
  const falconFuturesRest=new RestClient({...config.rest,baseUrls:['https://fapi.binance.com']});
  const falconEyeRadar=new FalconEyeRadar({rest,futuresRest:falconFuturesRest,store,pushManager:push,config:config.falconEyeRadar||{},logger});
  const radarSwarm=new RadarSwarmCoordinator({expectedCount:12,startupSpacingMs:config.radarSwarm?.startupSpacingMs??150,logger,runners:[
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
  const agentMarketRest=new RestClient({...config.rest,baseUrls:deepRestUrls});
  const agentMarketScanner=new MarketUniverseScanner({rest:agentMarketRest,config:{quote:config.aiAgents?.quote||'USDT',minQuoteVolume24h:Number(config.aiAgents?.minQuoteVolume24h??750000),deepCandidates:Number(config.aiAgents?.deepCandidates??6),deepConcurrency:Number(config.aiAgents?.deepConcurrency??3),deepKlines:Number(config.aiAgents?.deepKlines??220),scanLimit:Math.max(10,Number(config.aiAgents?.deepCandidates??6)),returnLimit:Math.max(10,Number(config.aiAgents?.resultLimit??20))}});
  const agentMarket=new AutonomousAgentMarket({scanner:agentMarketScanner,store,config:config.aiAgents||{},logger});
  for (const [radarId,instance] of [
    ['EARLY_MOVE_RADAR',moveSentinel],
    ['STRONG_MOVE_RADAR',strongMoveRadar],
    ['ROTATION_LAG_RADAR',rotationLagRadar],
    ['LIQUIDITY_ABSORPTION_RADAR',liquidityAbsorptionRadar],
    ['KAHIR_RADAR',kahirRadar],
    ['PROFESSOR_RADAR',professorRadar],
    ['DOOMSDAY_RADAR',doomsdayRadar],
    ['EARLY_EXPANSION_RADAR',earlyExpansionRadar],
    ['ALMUQAWIM_RADAR',alMuqawimRadar],
    ['COIN_HUNTER_RADAR',coinHunterRadar],
    ['WHALE_ACCUMULATION_RADAR',whaleAccumulationRadar],
    ['FALCON_EYE_RADAR',falconEyeRadar],
    ['AUTONOMOUS_AI_MARKET',agentMarket],
    ['MARKET_MONITOR',monitor]
  ]) instrumentRadarCycle(instance,radarId);
  const api=createApiServer({config,store,monitor,pushProvider:provider,pushManager:push,moveSentinel,strongMoveRadar,rotationLagRadar,liquidityAbsorptionRadar,kahirRadar,professorRadar,doomsdayRadar,symbolDeepAnalyzer,agentMarket,earlyExpansionRadar,alMuqawimRadar,coinHunterRadar,whaleAccumulationRadar,falconEyeRadar,radarSwarm});
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
  const autoStart=config.radarControl?.autostart!==false;
  if(autoStart){
    safeStart('AUTONOMOUS_AI_MARKET',agentMarket);
    const swarmStatus=await radarSwarm.start();
    logger.info('[RADAR_SWARM_START] '+JSON.stringify({status:swarmStatus.status,expected:swarmStatus.expected_count,registered:swarmStatus.registered_count,spacing_ms:swarmStatus.startup_spacing_ms}));
  }else logger.info('Radar auto-start disabled; all 12 workers are registered but remain stopped.');
  logger.info('Push provider: '+provider.status().provider+' enabled='+provider.status().enabled);
  return {server:api,monitor,moveSentinel,strongMoveRadar,rotationLagRadar,liquidityAbsorptionRadar,kahirRadar,professorRadar,doomsdayRadar,alMuqawimRadar,earlyExpansionRadar,coinHunterRadar,whaleAccumulationRadar,falconEyeRadar,radarSwarm,earlyExpansionRadarRest,symbolDeepAnalyzer,agentMarket,agentMarketRest,store,rest,strongRadarRest,rotationRadarRest,liquidityRadarRest,kahirRadarRest,push,close:async()=>{await radarSwarm.stop();await agentMarket.stop();await monitor.stop();api.closeAllConnections?.();await new Promise(r=>api.close(r));}};
}

if(process.argv[1]&&resolve(fileURLToPath(import.meta.url))===resolve(process.argv[1])){
  startServer().catch(error=>{console.error(sanitizeLogMessage(error?.stack??error,process.env));process.exitCode=1;});
}
