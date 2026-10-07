function num(v,d=null){const n=Number(v);return Number.isFinite(n)?n:d;}
function clamp(v){const n=num(v,50);return Math.max(0,Math.min(100,n));}
function mean(a){const x=(Array.isArray(a)?a:[]).map(Number).filter(Number.isFinite);return x.length?x.reduce((s,v)=>s+v,0)/x.length:null;}
function pct(a,b){return Number.isFinite(Number(a))&&Number.isFinite(Number(b))&&Number(b)!==0?(Number(a)-Number(b))/Number(b)*100:null;}
function closed(rows,now){return (Array.isArray(rows)?rows:[]).filter(c=>c&&c.closed!==false&&num(c.closeTime,Infinity)<=now&&num(c.open)>0&&num(c.high)>=num(c.low)&&num(c.close)>0&&num(c.volume)>=0);}
function largeTradeStats(trades,minNotional){
  const rows=(Array.isArray(trades)?trades:[]).map(t=>{const p=num(t?.p),q=num(t?.q);return p>0&&q>0?{notional:p*q,buy:t?.m!==true,time:num(t?.T,0)}:null;}).filter(Boolean);
  if(!rows.length)return{count:0,bigCount:0,buyRatio:null,netRatio:null,buyNotional:0,sellNotional:0,threshold:null,repeatBuyScore:0,burstScore:0,topPrints:[]};
  const ns=rows.map(x=>x.notional).sort((a,b)=>a-b);
  const p90=ns[Math.max(0,Math.floor(ns.length*.9)-1)]||0;
  const threshold=Math.max(num(minNotional,25000),p90);
  const big=rows.filter(x=>x.notional>=threshold);
  const buy=big.filter(x=>x.buy).reduce((s,x)=>s+x.notional,0);
  const sell=big.filter(x=>!x.buy).reduce((s,x)=>s+x.notional,0);
  const total=buy+sell;
  const ordered=[...big].sort((a,b)=>b.notional-a.notional);
  const bins=new Map();
  for(const x of big){const b=Math.floor(x.time/60000);bins.set(b,(bins.get(b)||0)+1);}
  const repeated=[...bins.values()].filter(x=>x>=2).length;
  return {
    count:rows.length,bigCount:big.length,buyRatio:total>0?buy/total:null,netRatio:total>0?(buy-sell)/total:null,
    buyNotional:buy,sellNotional:sell,threshold,
    repeatBuyScore:clamp(50+Math.min(40,(repeated/Math.max(1,bins.size))*60)+(big.filter(x=>x.buy).length>2?10:0)),
    burstScore:clamp(40+Math.min(60,big.length/Math.max(1,rows.length)*250)),
    topPrints:ordered.slice(0,4).map(x=>({notional:x.notional,side:x.buy?'BUY':'SELL',time:x.time}))
  };
}
function orderbookMetrics(depth,price){
  const bids=Array.isArray(depth?.bids)?depth.bids:[],asks=Array.isArray(depth?.asks)?depth.asks:[];
  const p=num(price,null);if(!(p>0)||!bids.length||!asks.length)return{nearImbalance:null,spreadBps:null};
  const band=.005;
  const bv=bids.filter(x=>num(x?.[0],0)>=p*(1-band)).reduce((s,x)=>s+num(x[0],0)*num(x[1],0),0);
  const av=asks.filter(x=>num(x?.[0],0)<=p*(1+band)).reduce((s,x)=>s+num(x[0],0)*num(x[1],0),0);
  const total=bv+av;
  return{nearImbalance:total>0?(bv-av)/total:null,spreadBps:(num(asks[0]?.[0])-num(bids[0]?.[0]))/p*10000};
}
function supportPersistence(rows){
  if(rows.length<12)return 45;
  const lows=rows.slice(-12).map(x=>num(x.low)).filter(Number.isFinite);
  const recent=Math.min(...lows.slice(-4)),base=Math.min(...lows.slice(0,-4));
  const hold=recent>=base*.995;
  return clamp(hold?76:52);
}
function whaleAnalysis({ticker,series5m,series1h,depth,trades,btc5m,now,minNotional=25000}){
  const c5=closed(series5m,now),h1=closed(series1h,now);
  const price=num(ticker?.lastPrice,null),move24=num(ticker?.priceChange24h,0);
  const tp=largeTradeStats(trades,minNotional);
  const ob=orderbookMetrics(depth,price);
  const recentVol=mean(c5.slice(-4).map(x=>num(x.volume)));
  const baseVol=mean(c5.slice(-20,-4).map(x=>num(x.volume)));
  const volumeRatio=Number.isFinite(recentVol)&&baseVol>0?recentVol/baseVol:null;
  const takerVol=mean(c5.slice(-6).map(x=>num(x.volume)));
  const takerBuy=c5.slice(-6).reduce((s,x)=>s+Math.max(0,num(x.takerBuyBaseVolume,0)),0);
  const takerRatio=takerVol>0?takerBuy/(takerVol*6):null;
  const fiveMove=pct(num(c5.at(-1)?.close),num(c5.at(-3)?.close));
  const btcMove=pct(num(btc5m?.at(-1)?.close),num(btc5m?.at(-3)?.close));
  const relativeVsBtc=Number.isFinite(fiveMove)&&Number.isFinite(btcMove)?fiveMove-btcMove:null;
  const stability=Number.isFinite(fiveMove)?clamp(86-Math.abs(fiveMove)*14):50;
  const support=supportPersistence(c5);
  const largeBuyScore=Number.isFinite(tp.buyRatio)?clamp(25+tp.buyRatio*90+(tp.netRatio||0)*60):45;
  const absorptionScore=avg([support,Number.isFinite(volumeRatio)?clamp(72+Math.min(30,(volumeRatio-1)*40)):55,stability,Number.isFinite(ob.nearImbalance)?clamp(50+ob.nearImbalance*130):50]);
  const flowScore=avg([largeBuyScore,Number.isFinite(takerRatio)?clamp(50+(takerRatio-.5)*220):50,tp.repeatBuyScore,tp.burstScore]);
  const quality=avg([num(ticker?.quoteVolume24h,0)>0?clamp(50+Math.log10(Math.max(1,num(ticker.quoteVolume24h)/300000))*18):20,
    Number.isFinite(ob.spreadBps)?clamp(100-ob.spreadBps*7):50,
    h1.length>=50?100:60]);
  const opportunity=avg([
    flowScore,absorptionScore,Number.isFinite(ob.nearImbalance)?clamp(50+ob.nearImbalance*120):50,
    support,Number.isFinite(relativeVsBtc)?clamp(50+relativeVsBtc*10):50,
    clamp(100-Math.max(0,move24-5)*7),quality
  ]);
  const eligible=tp.bigCount>=3&&(tp.buyRatio??0)>=.60&&(tp.netRatio??0)>=.12&&opportunity>=82&&quality>=65;
  return {
    eligible,stage:eligible?'CONFIRMED_ACCUMULATION':opportunity>=68?'BUILDING':'WATCH',
    opportunity_score:Number(clamp(opportunity).toFixed(1)),
    whale_accumulation:{
      stage:eligible?'CONFIRMED_ACCUMULATION':opportunity>=68?'BUILDING':'WATCH',
      direction:(tp.netRatio??0)>=.08?'ACCUMULATION':'BALANCED',
      support_score:Number(clamp(support).toFixed(1)),
      stability_score:Number(clamp(stability).toFixed(1)),
      relative:{relativeVsBtc},
      price_context:{five_minute_move_pct:fiveMove}
    },
    large_prints:{largeBuyRatio:tp.buyRatio,largeNotionalRatio:tp.netRatio,repeatBuyScore:tp.repeatBuyScore,burstScore:tp.burstScore,topPrints:tp.topPrints},
    candle_flow:{volumeRatio,takerBuyRatio:takerRatio},
    orderbook:{nearImbalance:ob.nearImbalance,spreadBps:ob.spreadBps},
    radar_quality_v3:{score:Number(clamp(quality).toFixed(1))},
    whale_streak:{count:eligible?1:0,required:2},
    reasons:[
      tp.bigCount>=3?'LARGE_PRINT_REPETITION':'NEED_MORE_LARGE_PRINTS',
      (tp.buyRatio??0)>=.60?'LARGE_BUY_DOMINANCE':'BUY_DOMINANCE_WEAK',
      (tp.netRatio??0)>=.12?'NET_LARGE_BUY_FLOW':'NET_LARGE_FLOW_WEAK',
      support>=65?'SUPPORT_PERSISTENCE':'SUPPORT_NOT_CONFIRMED',
      (ob.nearImbalance??0)>=.05?'BID_DEPTH_SUPPORT':'ORDERBOOK_NEUTRAL',
      Number.isFinite(relativeVsBtc)&&relativeVsBtc>0?'RELATIVE_STRENGTH':'RELATIVE_STRENGTH_NEUTRAL'
    ].filter(Boolean),
    thresholds:{minLargeBuyRatio:.60,minLargeNotionalImbalance:.12,minOpportunityScore:82},
    source:'Binance Public REST',closed_candles_only:true,
    paper_trading:true,real_order_execution:false,confidence_score:'UNKNOWN'
  };
}

export class WhaleAccumulationRadar{
  constructor({rest,store,pushManager=null,config={},clock=()=>Date.now(),logger=console}={}){
    if(!rest||!store)throw new Error('REST_CLIENT_AND_STORE_REQUIRED');
    this.rest=rest;this.store=store;this.pushManager=pushManager;this.config={quote:'USDT',pollMs:60000,discoveryLimit:12,scanLimit:20,minQuoteVolume24h:500000,minLargeTradeNotional:25000,streakRequired:2,max24hMovePct:10,...config};
    this.clock=clock;this.logger=logger;this.running=false;this.busy=false;this.timer=null;this.lastScanAt=null;this.lastError=null;this.universeTotal=0;this.scanned=0;this.confirmed=0;this.persistence=new Map();this.latest=new Map();this.btc5m=[];
  }
  async start(){if(this.running)return;this.running=true;try{await this.tick();}catch(e){this.noteError(e);}this.timer=setInterval(()=>this.tick().catch(e=>this.noteError(e)),this.config.pollMs);}
  async stop(){this.running=false;if(this.timer)clearInterval(this.timer);this.timer=null;}
  noteError(e){this.lastError=String(e?.message??e);this.logger.warn?.('WHALE_ACCUMULATION',this.lastError);}
  async tick({force=false}={}){
    if(this.busy||(!this.running&&!force))return;
    this.busy=true;try{
      const info=await this.rest.request('/api/v3/exchangeInfo');
      const universe=(info.data?.symbols||[]).filter(x=>x.symbol?.endsWith(this.config.quote)&&x.status==='TRADING'&&x.isSpotTradingAllowed!==false).map(x=>x.symbol);
      this.universeTotal=universe.length;
      const tk=await this.rest.request('/api/v3/ticker/24hr');
      const rows=(Array.isArray(tk.data)?tk.data:[]).filter(x=>universe.includes(x.symbol)).map(x=>({symbol:x.symbol,lastPrice:num(x.lastPrice),quoteVolume24h:num(x.quoteVolume,0),priceChange24h:num(x.priceChangePercent,0),highPrice24h:num(x.highPrice),lowPrice24h:num(x.lowPrice)})).filter(x=>x.quoteVolume24h>=this.config.minQuoteVolume24h&&Math.abs(x.priceChange24h)<=this.config.max24hMovePct).sort((a,b)=>b.quoteVolume24h-a.quoteVolume24h).slice(0,this.config.discoveryLimit);
      try{this.btc5m=(await this.rest.klines('BTCUSDT','5m',{limit:60})).candles||[];}catch{}
      let scanned=0,confirmed=0;
      for(const row of rows){
        try{
          const [k5,k1,d,tr]=await Promise.all([
            this.rest.klines(row.symbol,'5m',{limit:80}),
            this.rest.klines(row.symbol,'1h',{limit:60}),
            this.rest.depth(row.symbol,100),
            this.rest.request('/api/v3/aggTrades',{symbol:row.symbol,limit:500})
          ]);
          const analysis=whaleAnalysis({ticker:row,series5m:k5.candles,series1h:k1.candles,depth:d.data,trades:tr.data,btc5m:this.btc5m,now:this.clock(),minNotional:this.config.minLargeTradeNotional});
          const prev=this.persistence.get(row.symbol)||0;
          const streak=analysis.eligible?Math.min(this.config.streakRequired,prev+1):0;
          this.persistence.set(row.symbol,streak);
          const confirmedNow=analysis.eligible&&streak>=this.config.streakRequired;
          const candidate={...row,symbol:row.symbol,eligible:confirmedNow,opportunity_score:analysis.opportunity_score,whale_accumulation:analysis.whale_accumulation,large_prints:analysis.large_prints,candle_flow:analysis.candle_flow,orderbook:analysis.orderbook,radar_quality_v3:analysis.radar_quality_v3,whale_streak:{count:streak,required:this.config.streakRequired},reasons:analysis.reasons,source:analysis.source,detected_at:this.clock(),processed_at:this.clock(),paper_trading:true,real_order_execution:false,confidence_score:'UNKNOWN'};
          this.latest.set(row.symbol,candidate);scanned++;if(confirmedNow)confirmed++;
          if(confirmedNow&&prev<this.config.streakRequired){
            const alert={id:'WHALE:'+row.symbol+':'+this.clock(),radar:'WHALE_ACCUMULATION_RADAR',symbol:row.symbol,radar_name:'🐋 تجمع الحيتان',opportunity_score:analysis.opportunity_score,whale_accumulation:analysis.whale_accumulation,large_prints:analysis.large_prints,candle_flow:analysis.candle_flow,orderbook:analysis.orderbook,radar_quality_v3:analysis.radar_quality_v3,whale_streak:{count:streak,required:this.config.streakRequired},reasons:analysis.reasons,source:'Binance Public REST',detected_at:this.clock(),processed_at:this.clock(),paper_trading:true,real_order_execution:false,confidence_score:'UNKNOWN'};
            await this.store.appendWhaleAccumulationAlert(alert);
            if(this.pushManager?.notifyRadarAlert)await this.pushManager.notifyRadarAlert(alert);
          }
        }catch(e){this.noteError(e);}
      }
      this.scanned=scanned;this.confirmed=confirmed;this.lastScanAt=this.clock();
    }finally{this.busy=false;}
  }
  async scanOnce(){return this.tick({force:true});}
  snapshot(limit=20){return [...this.latest.values()].sort((a,b)=>b.opportunity_score-a.opportunity_score).slice(0,Math.max(1,Math.min(50,Math.trunc(Number(limit)||20))));}
  health(){return{running:this.running,busy:this.busy,radar:'WHALE_ACCUMULATION_RADAR',radar_name:'🐋 تجمع الحيتان',universe:this.universeTotal,scanned_successfully:this.scanned,confirmed_count:this.confirmed,last_scan_at:this.lastScanAt,last_error:this.lastError,source:'Binance Public REST',closed_candles_only:true,paper_trading:true,real_order_execution:false,confidence_score:'UNKNOWN'};}
  report(){return{thresholds:{minLargeBuyRatio:.60,minLargeNotionalImbalance:.12,minOpportunityScore:82},what_it_measures:['Large Prints','Taker Flow','Absorption','Orderbook Imbalance','Support Persistence','5m Confirmation','Relative Strength'],methodology:'Large Prints + Taker Flow + Absorption + Orderbook + Support + 5m + Relative Strength',source:'Binance Public REST: aggTrades + depth + closed klines'};}
  coverage(){return{universe_total:this.universeTotal,scanned_successfully:this.scanned,confirmed_after_persistence:this.confirmed};}
}
