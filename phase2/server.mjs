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
import {SymbolDeepAnalyzer} from './core/symbol-deep-analyzer.mjs';
import {MarketUniverseScanner} from './market/universe-scanner.mjs';
import {createApiServer} from './http/api.mjs';
import {assertDeploymentEnvironment,assertReadOnlyStagingConfig} from './deploy/preflight.mjs';
import {sanitizeLogMessage} from './runtime.mjs';

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
  const symbolDeepAnalyzer=new SymbolDeepAnalyzer({rest,config:config.symbolDeepScan||{}});
  const professorRadar=new ProfessorRadar({rest,store,pushManager:push,deepAnalyzer:symbolDeepAnalyzer,config:config.professorRadar||{},logger});
  const doomsdayRadar=new DoomsdayRadar({rest,store,pushManager:push,config:config.doomsdayRadar||{},logger});
  const api=createApiServer({config,store,monitor,pushProvider:provider,pushManager:push,moveSentinel,strongMoveRadar,rotationLagRadar,liquidityAbsorptionRadar,kahirRadar,professorRadar,doomsdayRadar,symbolDeepAnalyzer});
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
    safeStart('RADAR1',moveSentinel);
    safeStart('RADAR2',strongMoveRadar);
    safeStart('RADAR3',rotationLagRadar);
    safeStart('RADAR4',liquidityAbsorptionRadar);
    safeStart('RADAR5',kahirRadar);
    safeStart('RADAR6',doomsdayRadar);
    safeStart('PROFESSOR_INTELLIGENCE',professorRadar);
  }
  logger.info('Push provider: '+provider.status().provider+' enabled='+provider.status().enabled);
  return {server:api,monitor,moveSentinel,strongMoveRadar,rotationLagRadar,liquidityAbsorptionRadar,kahirRadar,professorRadar,doomsdayRadar,symbolDeepAnalyzer,store,rest,strongRadarRest,rotationRadarRest,liquidityRadarRest,kahirRadarRest,push,close:async()=>{await professorRadar.stop();await doomsdayRadar.stop();await kahirRadar.stop();await liquidityAbsorptionRadar.stop();await rotationLagRadar.stop();await strongMoveRadar.stop();await moveSentinel.stop();await monitor.stop();api.closeAllConnections?.();await new Promise(r=>api.close(r));}};
}

if(process.argv[1]&&resolve(fileURLToPath(import.meta.url))===resolve(process.argv[1])){
  startServer().catch(error=>{console.error(sanitizeLogMessage(error?.stack??error,process.env));process.exitCode=1;});
}
