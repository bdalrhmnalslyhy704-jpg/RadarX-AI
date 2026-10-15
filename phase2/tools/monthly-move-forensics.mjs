#!/usr/bin/env node
/**
 * Read-only rolling 30-day Binance Spot USDT move forensics for RadarX Build 224.
 * Closed OHLCV/trade-count/taker-buy quote data only. Historical order-book depth
 * is not available from standard Spot klines; taker-buy ratio is a flow proxy.
 * This is an event-aligned descriptive study, not evidence of predictive accuracy.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const HOSTS = ['https://data-api.binance.vision', 'https://api.binance.com'];
const DAY = 86400000, HOUR = 3600000, M5 = 300000;
const END = Number(process.env.FORENSICS_END_TIME_MS || Date.now());
const DAYS = Math.max(30, Math.min(60, Number(process.env.FORENSICS_DAYS || 30)));
const MIN_QV = 750000;
const JSON_OUT = process.env.FORENSICS_JSON_PATH || 'monthly-move-forensics.json';
const MD_OUT = process.env.FORENSICS_MARKDOWN_PATH || 'monthly-move-forensics.md';
const STABLE = new Set(['USDT','USDC','FDUSD','TUSD','BUSD','USDP','DAI','USDE','USDS','USD1','EUR','EURI','AEUR','TRY','BRL','BIDR','IDRT','UAH','RUB','GBP','AUD','BTCB','WBTC','WETH','WBETH','BETH']);
let requests = 0, rateLimitResponses = 0, fallbackSuccesses = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const num = v => { const x=Number(v); return Number.isFinite(x)?x:null; };
const med = values => { const a=values.map(Number).filter(Number.isFinite).sort((x,y)=>x-y); if(!a.length)return null;const m=Math.floor(a.length/2);return a.length%2?a[m]:(a[m-1]+a[m])/2; };
const avg = values => { const a=values.map(Number).filter(Number.isFinite);return a.length?a.reduce((s,x)=>s+x,0)/a.length:null; };
const pct = (a,b) => Number.isFinite(a)&&Number.isFinite(b)&&b>0?(a/b-1)*100:null;
const rnd = (x,d=3) => Number.isFinite(x)?Number(x.toFixed(d)):null;
const time = x => new Date(x).toISOString();
const fmt = x => Number.isFinite(x)?(x>=0?'+':'')+x.toFixed(2)+'%':'n/a';

async function getJson(route, params={}) {
  const qs = new URLSearchParams();
  Object.entries(params).forEach(([k,v])=>{if(v!==undefined&&v!==null)qs.set(k,String(v));});
  const urlSuffix = qs.toString() ? '?' + qs.toString() : '';
  let last = null;
  for(let attempt=0;attempt<4;attempt++){
    for(let off=0;off<HOSTS.length;off++){
      const hi=(requests+attempt+off)%HOSTS.length, controller=new AbortController();
      const timer=setTimeout(()=>controller.abort(),18000);
      try{
        requests++;
        const res=await fetch(HOSTS[hi]+route+urlSuffix,{headers:{accept:'application/json','user-agent':'RadarX-Build224-MonthlyForensics/1.0'},signal:controller.signal});
        if(res.status===429||res.status===418){
          rateLimitResponses++;
          const retry=num(res.headers.get('retry-after'));
          await res.arrayBuffer().catch(()=>null);
          last=new Error('BINANCE_RATE_LIMIT_'+res.status);
          await sleep(retry&&retry>0?Math.min(60000,retry*1000):Math.min(30000,1200*(2**attempt)));
          continue;
        }
        if(!res.ok){
          last=new Error('BINANCE_HTTP_'+res.status+' '+(await res.text()).slice(0,100));
          if([400,403,404,451].includes(res.status))continue;
          await sleep(500*(2**attempt));continue;
        }
        const data=await res.json();
        if(hi>0)fallbackSuccesses++;
        return data;
      }catch(e){last=e;}finally{clearTimeout(timer);}
    }
    await sleep(Math.min(10000,500*(2**attempt)));
  }
  throw last||new Error('BINANCE_REQUEST_FAILED');
}
async function mapLimit(list,limit,fn){
  const out=new Array(list.length);let next=0;
  await Promise.all(Array.from({length:limit},async()=>{while(true){const i=next++;if(i>=list.length)return;try{out[i]=await fn(list[i],i);}catch(e){out[i]={error:String(e&&e.message||e)};}}}));
  return out;
}
function klines(raw, intervalMs){
  return (Array.isArray(raw)?raw:[]).map(r=>{
    if(!Array.isArray(r)||r.length<11)return null;
    const c={openTime:num(r[0]),open:num(r[1]),high:num(r[2]),low:num(r[3]),close:num(r[4]),volume:num(r[5]),closeTime:num(r[6]),quoteVolume:num(r[7]),trades:num(r[8]),buyBase:num(r[9]),buyQuote:num(r[10])};
    if(Object.values(c).some(v=>v===null)||c.open<=0||c.close<=0||c.high<c.low||c.volume<0||c.quoteVolume<0||c.trades<0)return null;
    return c.closeTime<END&&c.closeTime<c.openTime+intervalMs?c:null;
  }).filter(Boolean).sort((a,b)=>a.openTime-b.openTime).filter((c,i,a)=>!i||c.openTime>a[i-1].openTime);
}
function baseIsRisky(base){return STABLE.has(base)||/(UP|DOWN|BULL|BEAR|[2356]L|[2356]S)$/.test(base);}
function makeTickerMap(rows){return new Map((rows||[]).filter(x=>x&&x.symbol).map(x=>[x.symbol,{qv:num(x.quoteVolume)||0,trades:num(x.count)||0,day:num(x.priceChangePercent)}]));}
function monthly(daily){
  const a=klines(daily,DAY).slice(-(DAYS+1));
  if(a.length<DAYS+1)return null;
  const first=a[0],last=a.at(-1);
  return {returnPct:pct(last.close,first.close),start:first.openTime,end:last.closeTime,open:first.close,close:last.close,count:a.length,elapsedDays:(last.closeTime-first.closeTime)/DAY};
}
function pickCohorts(coins){
  const sorted=coins.filter(x=>Number.isFinite(x.monthlyReturnPct)&&x.quoteVolume24h>=MIN_QV).sort((a,b)=>b.monthlyReturnPct-a.monthlyReturnPct);
  const strong=sorted.filter(x=>x.monthlyReturnPct>=20).slice(0,12);
  const s=new Set(strong.map(x=>x.symbol));
  const mid=sorted.filter(x=>!s.has(x.symbol)&&x.monthlyReturnPct>=5&&x.monthlyReturnPct<20).slice(0,12);
  const p=new Set([...s,...mid.map(x=>x.symbol)]);
  const target=med([...strong,...mid].map(x=>x.quoteVolume24h))||1000000;
  const control=sorted.filter(x=>!p.has(x.symbol)&&x.monthlyReturnPct>=-5&&x.monthlyReturnPct<=5)
    .sort((a,b)=>Math.abs(Math.log10(Math.max(1,a.quoteVolume24h))-Math.log10(target))-Math.abs(Math.log10(Math.max(1,b.quoteVolume24h))-Math.log10(target))).slice(0,8);
  return {STRONG:strong,MEDIUM:mid,CONTROL:control};
}
function findAnchor(hourlyRaw){
  const a=klines(hourlyRaw,HOUR), lb=24;let best={score:-Infinity,index:Math.min(lb,a.length-1)};
  for(let i=lb;i<a.length-lb;i++){
    const past=a.slice(i-lb,i),prev=a.slice(Math.max(0,i-12),i),low=Math.min(...past.map(c=>c.low)),high=Math.max(...prev.map(c=>c.high));
    const rise=pct(a[i].close,low),nextHigh=Math.max(...a.slice(i,i+lb).map(c=>c.high)),follow=pct(nextHigh,a[i].close);
    if((rise??-Infinity)>best.score)best={score:rise,index:i,rise,follow,low,high};
    if(a[i].close>high*1.001&&rise>=4&&follow>=8)
      return {rows:a,index:i,at:a[i].closeTime+1,marker:'FIRST_4PCT_RANGE_BREAK_WITH_8PCT_24H_FOLLOW_THROUGH',rise,follow};
  }
  const i=Math.max(0,Math.min(a.length-1,best.index)),c=a[i];
  return {rows:a,index:i,at:c?c.closeTime+1:END,marker:'FALLBACK_MAX_24H_RANGE_EXPANSION_NO_CONFIRMED_CONTINUATION',rise:best.rise??null,follow:best.follow??null};
}
function loc(c){const r=c.high-c.low;return r>0?(c.close-c.low)/r:null;}
function rangePct(c){return c.open>0?(c.high-c.low)/c.open*100:null;}
function taker(c){return c.quoteVolume>0?c.buyQuote/c.quoteVolume:null;}
function ratio(a,b){return Number.isFinite(a)&&Number.isFinite(b)&&b>0?a/b:null;}
function summarizeWindow(rows,baseline,at){
  const a=rows.filter(c=>c.openTime<at&&c.closeTime<at),b=baseline.filter(c=>c.closeTime<at);
  if(!a.length||!b.length)return {bars:a.length,complete:false};
  const bq=med(b.map(c=>c.quoteVolume)),bt=med(b.map(c=>c.trades)),br=med(b.map(rangePct).filter(Number.isFinite));
  const q=a.reduce((s,c)=>s+c.quoteVolume,0),buy=a.reduce((s,c)=>s+c.buyQuote,0);
  const ranges=a.map(rangePct).filter(Number.isFinite),locs=a.map(loc).filter(Number.isFinite);
  return {bars:a.length,volume_median_ratio:rnd(ratio(med(a.map(c=>c.quoteVolume)),bq)),trades_median_ratio:rnd(ratio(med(a.map(c=>c.trades)),bt)),
    taker_buy_share:rnd(q>0?buy/q:null,4),mean_close_location:rnd(avg(locs)),green_candle_pct:rnd(100*a.filter(c=>c.close>c.open).length/a.length,2),
    range_vs_baseline:rnd(ratio(med(ranges),br)),phase_return_pct:rnd(pct(a.at(-1).close,a[0].open))};
}
function forensics(raw,at,symbol){
  const a=klines(raw,M5),base=a.filter(c=>c.openTime>=at-48*HOUR&&c.closeTime<at-24*HOUR),wins={};
  for(const [name,dur] of [['pre_24h',24*HOUR],['pre_12h',12*HOUR],['pre_6h',6*HOUR],['pre_3h',3*HOUR],['pre_1h',HOUR],['pre_30m',30*60*1000]])
    wins[name]=summarizeWindow(a.filter(c=>c.openTime>=at-dur&&c.closeTime<at),base,at);
  const bar=a.find(c=>c.openTime>=at)||null,pre=a.filter(c=>c.openTime>=at-DAY&&c.closeTime<at),p4=a.filter(c=>c.openTime>=at&&c.closeTime<=at+4*HOUR),p24=a.filter(c=>c.openTime>=at&&c.closeTime<=at+DAY);
  const start=bar?.open??a.find(c=>c.closeTime>=at)?.close??null;
  const next=(rows,field,fn)=>rows.length&&start>0?rnd(fn(rows.map(c=>c[field]))/start-1)*100:null;
  const baseQuote=med(base.map(c=>c.quoteVolume)),baseTrades=med(base.map(c=>c.trades));
  return {symbol,anchor_time:time(at),anchor_candle:bar?{open:bar.open,high:bar.high,low:bar.low,close:bar.close,return_pct:rnd(pct(bar.close,bar.open)),
      volume_vs_baseline:rnd(ratio(bar.quoteVolume,baseQuote)),trades_vs_baseline:rnd(ratio(bar.trades,baseTrades)),taker_buy_share:rnd(taker(bar),4),close_location:rnd(loc(bar)),range_pct:rnd(rangePct(bar),4)}:null,
    baseline_24h:{bars:base.length,median_quote_volume_5m:rnd(baseQuote),median_trades_5m:rnd(baseTrades),median_range_pct:rnd(med(base.map(rangePct).filter(Number.isFinite)),4),
      taker_buy_share:rnd(base.reduce((s,c)=>s+c.buyQuote,0)/Math.max(1,base.reduce((s,c)=>s+c.quoteVolume,0)),4),
      preceding_low:rnd(pre.length?Math.min(...pre.map(c=>c.low)):null,10),preceding_high:rnd(pre.length?Math.max(...pre.map(c=>c.high)):null,10),
      higher_lows_last_12:pre.slice(-12).slice(1).filter((c,i)=>c.low>pre.slice(-12)[i].low).length},
    windows:wins,outcomes:{next_4h_mfe_pct:start>0&&p4.length?rnd((Math.max(...p4.map(c=>c.high))/start-1)*100):null,
      next_4h_mae_pct:start>0&&p4.length?rnd((Math.min(...p4.map(c=>c.low))/start-1)*100):null,
      next_24h_mfe_pct:start>0&&p24.length?rnd((Math.max(...p24.map(c=>c.high))/start-1)*100):null,
      next_24h_mae_pct:start>0&&p24.length?rnd((Math.min(...p24.map(c=>c.low))/start-1)*100):null,
      complete_4h:p4.length>=48,complete_24h:p24.length>=288},
    quality:{closed_5m_candles:a.length,baseline_complete:base.length>=288,full_24h_phase:wins.pre_24h?.bars===288,orderbook_depth:'NOT_AVAILABLE_FROM_STANDARD_KLINES'}};
}
function aggregate(cases,cohort){
  const a=cases.filter(c=>c.cohort===cohort&&c.forensics),out={cohort,cases:a.length,phases:{},outcomes:{}};
  for(const phase of ['pre_24h','pre_12h','pre_6h','pre_3h','pre_1h','pre_30m']){
    out.phases[phase]={};
    for(const key of ['volume_median_ratio','trades_median_ratio','taker_buy_share','mean_close_location','green_candle_pct','range_vs_baseline','phase_return_pct'])
      out.phases[phase][key]=rnd(med(a.map(c=>c.forensics.windows[phase]?.[key]).filter(Number.isFinite)),4);
  }
  for(const key of ['next_4h_mfe_pct','next_4h_mae_pct','next_24h_mfe_pct','next_24h_mae_pct'])
    out.outcomes[key]=rnd(med(a.map(c=>c.forensics.outcomes[key]).filter(Number.isFinite)));
  return out;
}
function markdown(report){
  const lines=['# RadarX Build 224 — rolling 30-day Spot move forensics','',
    '- Window: '+report.window.start_utc+' → '+report.window.end_utc,
    '- Eligible pairs above the existing '+MIN_QV.toLocaleString('en-US')+' USDT 24h quote-volume floor: '+report.universe.eligible_symbols,
    '- Deep cases: '+report.cases.filter(c=>c.forensics).length+'; failures: '+report.cases.filter(c=>c.error).length,
    '- Data: closed Binance Spot daily, hourly and 5m klines. No account endpoints, keys, fabricated candles or unfinished candles.',
    '- Kline taker-buy ratio is an aggressor-flow proxy. Historical order-book depth/imbalance cannot be reconstructed from the standard kline endpoint.',
    '- Anchor is an ex-post event alignment only; it is not a model alert or proof of predictiveness. Only outcomes observed after the anchor are reported.','',
    '## Cohort comparison','','| Cohort | Cases | Pre-6h volume ratio | Pre-6h trade ratio | Pre-6h taker-buy share | Median next-24h MFE | Median next-24h MAE |','|---|---:|---:|---:|---:|---:|---:|'];
  for(const c of report.cohort_summary)lines.push('| '+c.cohort+' | '+c.cases+' | '+(c.phases.pre_6h.volume_median_ratio??'n/a')+' | '+(c.phases.pre_6h.trades_median_ratio??'n/a')+' | '+(c.phases.pre_6h.taker_buy_share??'n/a')+' | '+(c.outcomes.next_24h_mfe_pct??'n/a')+'% | '+(c.outcomes.next_24h_mae_pct??'n/a')+'% |');
  lines.push('','## Cases','','| Cohort | Pair | 30d return | 24h USDT volume | Anchor UTC | Marker | Pre-3h volume | Pre-3h trades | Pre-3h buy share | Next 24h MFE | Next 24h MAE |','|---|---|---:|---:|---|---|---:|---:|---:|---:|---:|');
  for(const c of report.cases){
    if(!c.forensics){lines.push('| '+c.cohort+' | '+c.symbol+' | '+fmt(c.monthlyReturnPct)+' | '+Math.round(c.quoteVolume24h||0)+' | n/a | FAILED | n/a | n/a | n/a | n/a | n/a |');continue;}
    const w=c.forensics.windows.pre_3h,o=c.forensics.outcomes;
    lines.push('| '+c.cohort+' | '+c.symbol+' | '+fmt(c.monthlyReturnPct)+' | '+Math.round(c.quoteVolume24h||0)+' | '+c.forensics.anchor_time+' | '+c.anchorMarker+' | '+(w.volume_median_ratio??'n/a')+' | '+(w.trades_median_ratio??'n/a')+' | '+(w.taker_buy_share??'n/a')+' | '+(o.next_24h_mfe_pct??'n/a')+'% | '+(o.next_24h_mae_pct??'n/a')+'% |');
  }
  lines.push('','## Timeline feature summary','','| Cohort | Window before anchor | Volume ratio | Trade ratio | Taker-buy share | Close-location | Green candles % | Range ratio | Return % |','|---|---|---:|---:|---:|---:|---:|---:|---:|');
  for(const c of report.cohort_summary)for(const p of ['pre_24h','pre_12h','pre_6h','pre_3h','pre_1h','pre_30m']){
    const f=c.phases[p];lines.push('| '+c.cohort+' | '+p+' | '+(f.volume_median_ratio??'n/a')+' | '+(f.trades_median_ratio??'n/a')+' | '+(f.taker_buy_share??'n/a')+' | '+(f.mean_close_location??'n/a')+' | '+(f.green_candle_pct??'n/a')+' | '+(f.range_vs_baseline??'n/a')+' | '+(f.phase_return_pct??'n/a')+' |');
  }
  lines.push('','## Top gainers within the eligible universe','','| Pair | 30d return | 24h quote volume | trades in 24h |','|---|---:|---:|---:|');
  for(const x of report.top_20)lines.push('| '+x.symbol+' | '+fmt(x.return_pct)+' | '+Math.round(x.quote_volume_24h)+' | '+x.trades_24h+' |');
  lines.push('','## Guardrails','','- The selected strong/mid cohorts and control group are not a full unbiased backtest; cohort selection uses the completed 30-day return window.',
    '- Do not reduce anti-chase or data-quality protections just because a coin later advanced.',
    '- Evidence for an improvement requires an increase in alerts before a move on strong and medium cases, alongside bounded false positives on controls and full matured closed-candle outcomes.',
    '- No actual signal precision/recall claim is possible unless the full historical detector state and signal-stage/rejection path can be replayed at each historical timestamp.','');
  return lines.join('\n');
}
async function main(){
  const start=END-DAYS*DAY;
  console.log('[FORENSICS] UTC window '+time(start)+' to '+time(END)+'; closed candles only.');
  const [info,tickerRows]=await Promise.all([getJson('/api/v3/exchangeInfo'),getJson('/api/v3/ticker/24hr')]);
  const tm=new Map((tickerRows||[]).map(r=>[r.symbol,{qv:num(r.quoteVolume)||0,trades:num(r.count)||0,day:num(r.priceChangePercent)}]));
  const symbols=(info.symbols||[]).filter(s=>s.quoteAsset==='USDT'&&s.status==='TRADING'&&s.isSpotTradingAllowed===true&&!baseIsRisky(s.baseAsset)&&tm.has(s.symbol)&&tm.get(s.symbol).qv>=MIN_QV&&tm.get(s.symbol).trades>0);
  console.log('[FORENSICS] Eligible symbol count '+symbols.length+'. Downloading closed daily candles (concurrency 5).');
  const daily=await mapLimit(symbols,5,async s=>{
    const raw=await getJson('/api/v3/klines',{symbol:s.symbol,interval:'1d',limit:DAYS+3}),d=monthly(raw);
    if(!d)return {symbol:s.symbol,error:'INSUFFICIENT_CLOSED_DAILY_HISTORY'};
    const t=tm.get(s.symbol);
    return {symbol:s.symbol,baseAsset:s.baseAsset,quoteVolume24h:t.qv,trades24h:t.trades,change24hPct:t.day,
      monthlyReturnPct:d.returnPct,monthStart:d.start,monthEnd:d.end,dailyCandles:d.count,elapsedDays:d.elapsedDays};
  });
  const coins=daily.filter(x=>x&&!x.error&&Number.isFinite(x.monthlyReturnPct)).sort((a,b)=>b.monthlyReturnPct-a.monthlyReturnPct);
  const sets=pickCohorts(coins), selected=[];
  for(const cohort of Object.keys(sets))for(const coin of sets[cohort])selected.push({...coin,cohort});
  console.log('[FORENSICS] completed daily histories '+coins.length+'; selected '+sets.STRONG.length+' strong / '+sets.MEDIUM.length+' medium / '+sets.CONTROL.length+' controls.');
  const rawCases=await mapLimit(selected,3,async coin=>{
    const hourly=await getJson('/api/v3/klines',{symbol:coin.symbol,interval:'1h',startTime:start-DAY,endTime:END,limit:800});
    const anchor=findAnchor(hourly);
    if(!anchor.rows.length)throw new Error('NO_CLOSED_HOURLY_CANDLES');
    const five=await getJson('/api/v3/klines',{symbol:coin.symbol,interval:'5m',startTime:Math.max(start-2*DAY,anchor.at-48*HOUR),endTime:Math.min(END,anchor.at+DAY+M5),limit:1000});
    return {anchorMarker:anchor.marker,anchorDiagnostics:{rise_pct:rnd(anchor.rise),follow_through_pct:rnd(anchor.follow)},forensics:forensics(five,anchor.at,coin.symbol)};
  });
  const cases=selected.map((coin,i)=>({symbol:coin.symbol,baseAsset:coin.baseAsset,cohort:coin.cohort,monthlyReturnPct:rnd(coin.monthlyReturnPct),
    quoteVolume24h:rnd(coin.quoteVolume24h,0),trades24h:coin.trades24h,monthStart:time(coin.monthStart),monthEnd:time(coin.monthEnd),
    anchorMarker:rawCases[i]?.anchorMarker||'FAILED',anchorDiagnostics:rawCases[i]?.anchorDiagnostics||null,forensics:rawCases[i]?.forensics||null,error:rawCases[i]?.error||null}));
  const report={schema_version:'radarx.monthly-move-forensics.v1',build:'Build 224',generated_at_utc:time(Date.now()),
    window:{days:DAYS,start_utc:time(start),end_utc:time(END),closed_daily_return:'last 31 completed daily candles: 30 close-to-close days'},
    policy:{quote:'USDT',minimum_24h_quote_volume_usdt:MIN_QV,paper_trading:true,real_order_execution:false,confidence_score:'UNKNOWN',
      market_data:'BINANCE_SPOT_PUBLIC_READ_ONLY',historical_order_book_depth:'UNAVAILABLE_FROM_STANDARD_KLINES',taker_buy_ratio:'aggressor-flow proxy only'},
    universe:{active_usdt_spot_symbols:(info.symbols||[]).filter(s=>s.quoteAsset==='USDT'&&s.status==='TRADING').length,eligible_symbols:symbols.length,
      completed_daily_histories:coins.length,insufficient_histories:daily.filter(x=>x&&x.error).length,
      detailed_strong:sets.STRONG.length,detailed_medium:sets.MEDIUM.length,detailed_controls:sets.CONTROL.length},
    acquisition:{binance_http_requests:requests,rate_limit_responses:rateLimitResponses,fallback_host_successes:fallbackSuccesses,
      daily_failures:daily.filter(x=>x&&x.error).slice(0,60).map(x=>({symbol:x.symbol,error:x.error})),
      case_errors:cases.filter(x=>x.error).map(x=>({symbol:x.symbol,cohort:x.cohort,error:x.error}))},
    top_20:coins.slice(0,20).map(x=>({symbol:x.symbol,return_pct:rnd(x.monthlyReturnPct,2),quote_volume_24h:x.quoteVolume24h,trades_24h:x.trades24h})),
    cohort_summary:['STRONG','MEDIUM','CONTROL'].map(c=>aggregate(cases,c)),cases};
  await fs.mkdir(path.dirname(path.resolve(JSON_OUT)),{recursive:true});
  await fs.mkdir(path.dirname(path.resolve(MD_OUT)),{recursive:true});
  await fs.writeFile(JSON_OUT,JSON.stringify(report,null,2));
  await fs.writeFile(MD_OUT,markdown(report));
  console.log('[FORENSICS] TOP20='+JSON.stringify(report.top_20));
  console.log('[FORENSICS] COHORTS='+JSON.stringify(report.cohort_summary));
  console.log('[FORENSICS] DEEP_CASES='+cases.filter(x=>x.forensics).length+' ERRORS='+cases.filter(x=>x.error).length);
  console.log('[FORENSICS] Markdown '+MD_OUT+'; JSON '+JSON_OUT);
}
main().catch(error=>{console.error('[FORENSICS_FATAL]',String(error&&error.stack||error));process.exitCode=1;});
