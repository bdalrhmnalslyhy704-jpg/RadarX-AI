import {evaluateSymbolSnapshot} from '../../phase1/radarx-phase1-engine.mjs';
import {assessDataGate,assessLiquidity,sourceIsLive} from './data-quality.mjs';

export const READ_ONLY_POLICY=Object.freeze({
  market:'SPOT',paper_trading:true,real_order_execution:false,allows_trade_endpoints:false,
  allows_withdrawals:false,allows_user_data:false
});
export const defaultSettings=()=>({
  enabled:true,symbols:['BTCUSDT','ETHUSDT'],timeframes:['15m'],
  minDataQuality:70,minLiquidityQuality:60,signalTypes:['ENTRY_CANDIDATE','CONFIRMED']
});

export class SignalService{
  constructor({deduplicator,store,pushManager,config,clock=()=>Date.now()}){this.deduplicator=deduplicator;this.store=store;this.pushManager=pushManager;this.config=config;this.clock=clock;}
  async evaluateSnapshot(input){
    const now=this.clock(),dg=assessDataGate({
      series4h:input.series4h,series1h:input.series1h,series15m:input.series15m,now,
      sourceLive:sourceIsLive({wsState:input.wsState,restLastSuccessAt:input.restLastSuccessAt,now,maxStaleMs:this.config.monitoring.maxStaleTriggerMs}),
      unresolvedGap:Boolean(input.unresolvedGap),minDataQuality:this.config.monitoring.minDataQuality,maxStaleTriggerMs:this.config.monitoring.maxStaleTriggerMs
    });
    const liq=assessLiquidity({book:input.bookRaw,ticker24h:input.ticker24hRaw,minQuality:this.config.monitoring.minLiquidityQuality});
    const engineConfig={...this.config,costs:{feeRate:this.config.paper.feeRate,slippageBps:this.config.paper.slippageBps}};
    const r=evaluateSymbolSnapshot({symbol:input.symbol,series4h:input.series4h,series1h:input.series1h,series15m:input.series15m,
      bookRaw:input.bookRaw,ticker24hRaw:input.ticker24hRaw,source:input.source||'UNKNOWN',now},{config:engineConfig});
    const signal={...r.signal,scores:{...r.signal.scores,data_quality:dg.quality,liquidity_quality:liq.quality,confidence_score:'UNKNOWN'},
      data_status:{...r.signal.data_status,source:input.source||'UNKNOWN',stale:dg.staleMs>this.config.monitoring.maxStaleTriggerMs,
        gaps:Boolean(input.unresolvedGap)||!dg.series.v4.valid||!dg.series.v1.valid||!dg.series.v15.valid,future_data_detected:dg.futureIssues.length>0},
      paper_trade:{enabled:true,real_order_execution:false}};
    const blocked=[...dg.blocked,...(liq.allowed?[]:liq.reasons),...(signal.risk_filter==='FAIL'?['RISK_FILTER_FAIL']:[])];
    const audit={event:'SIGNAL_EVALUATION',source_time:signal.candle?.close_time??null,processed_at:now,symbol:input.symbol,
      timeframe:signal.candle?.timeframe||'15m',price:signal.price?.reference??null,strategy:signal.strategy,
      reason:Array.isArray(signal.reason_codes)?signal.reason_codes.join(','):'UNKNOWN',data_quality:dg.quality,
      liquidity_quality:liq.quality,notification_status:'NOT_ATTEMPTED',emitted:false,blocked_reasons:blocked,
      signal_id:signal.signal_id,confidence_score:'UNKNOWN',paper_trading:true,real_order_execution:false,signal_snapshot:signal};
    const eligible=dg.allowed&&liq.allowed&&signal.direction!=='NONE'&&signal.risk_filter!=='FAIL';
    if(!eligible){await this.store.appendSignalAudit(audit);return{emitted:false,signal,blocked,audit,dataGate:dg,liquidity:liq,strategies:r.strategies};}
    const d=await this.deduplicator.canEmit(signal,now);
    if(!d.allowed){audit.blocked_reasons=[...blocked,d.reason];await this.store.appendSignalAudit(audit);return{emitted:false,signal,blocked:audit.blocked_reasons,audit,dataGate:dg,liquidity:liq,strategies:r.strategies};}
    await this.deduplicator.markEmitted(signal,now);audit.emitted=true;audit.notification_status='QUEUED';await this.store.appendSignalAudit(audit);
    const notifications=this.pushManager?await this.pushManager.notifySignal(signal):[];
    const status=notifications.some(x=>x.status==='SENT')?'SENT_OR_ATTEMPTED':notifications.length?'FAILED_OR_DISABLED':'NO_SUBSCRIBERS';
    await this.store.appendSignalAudit({...audit,event:'SIGNAL_NOTIFICATION_RESULT',notification_status:status});
    return{emitted:true,signal,blocked:[],audit,notificationStatus:status,notifications,dataGate:dg,liquidity:liq,strategies:r.strategies};
  }
}
export function assertReadOnlySignal(s){if(s?.paper_trade?.real_order_execution!==false)throw new Error('READ_ONLY_POLICY_VIOLATION');if(s?.paper_trade?.enabled!==true)throw new Error('PAPER_TRADING_POLICY_VIOLATION');}
