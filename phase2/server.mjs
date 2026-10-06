import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {CONFIG} from './config.mjs';
import {RestClient} from './market/binance-rest.mjs';
import {BinanceStreamClient} from './market/binance-ws.mjs';
import {DurableStore} from './core/store.mjs';
import {SignalDeduplicator} from './core/dedup.mjs';
import {SignalService} from './core/signal-service.mjs';
import {createPushProvider,PushManager} from './push/index.mjs';
import {MarketMonitor} from './core/monitor.mjs';
import {EarlyExpansionRadar} from './core/early-expansion-radar.mjs';
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
  await monitor.start();
  const earlyExpansionRadar=new EarlyExpansionRadar({rest,store,pushManager:push,config:config.earlyExpansionRadar||{},logger});
  const api=createApiServer({config,store,monitor,pushProvider:provider,pushManager:push,earlyExpansionRadar});
  await new Promise((resolveStart,reject)=>api.listen(config.port,config.host,resolveStart).on('error',reject));
  logger.info('RadarX Phase 2 API listening on http://'+config.host+':'+config.port);
  logger.info('Push provider: '+provider.status().provider+' enabled='+provider.status().enabled);
  earlyExpansionRadar.start();
  return {server:api,monitor,store,rest,push,earlyExpansionRadar,close:async()=>{await earlyExpansionRadar.stop();await monitor.stop();api.closeAllConnections?.();await new Promise(r=>api.close(r));}};
}

if(process.argv[1]&&resolve(fileURLToPath(import.meta.url))===resolve(process.argv[1])){
  startServer().catch(error=>{console.error(sanitizeLogMessage(error?.stack??error,process.env));process.exitCode=1;});
}
