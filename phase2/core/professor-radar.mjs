import {buildSpotUniverse} from '../market/universe-scanner.mjs';
import {formatRadarTime12h} from './radar-alert-meta.mjs';

const clamp=(x,lo=0,hi=100)=>Math.max(lo,Math.min(hi,Number(x)||0));
const finite=(x,d=null)=>Number.isFinite(Number(x))?Number(x):d;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

export const PROFESSOR_RADAR_DEFAULTS=Object.freeze({
  quote:'USDT',pollMs:120000,universeRefreshMs:15*60*1000,liveSearchLimit:8,transcriptStreams:2,
  newsLimit:35,deepCandidates:5,deepConcurrency:2,alertCooldownMs:30*60*1000,minEntryScore:78,minWatchScore:66,
  webTimeoutMs:7000,transcriptTimeoutMs:6000,
  searchQueries:['crypto trading live','bitcoin trading live','altcoin trading live','binance trading live','crypto scalping live']
});

const BULL_WORDS=['buy','long','bullish','breakout','entry','accumulate','support','reclaim','pump','upside','شراء','لونغ','صعود','اختراق','دخول','تجميع'];
const BEAR_WORDS=['sell','short','bearish','breakdown','exit','distribution','resistance','reject','dump','downside','بيع','شورت','هبوط','كسر','خروج','تصريف'];
const NEWS_BULL=['approval','approved','partnership','integration','launch','adoption','etf','inflow','upgrade','listing','record','surge','bullish','breakout','growth','positive','اعتماد','شراكة','إطلاق','ترقية','إدراج','تدفقات','إيجابي'];
const NEWS_BEAR=['hack','exploit','ban','lawsuit','liquidation','outflow','delist','delisting','attack','fraud','bearish','breakdown','negative','collapse','اختراق','حظر','دعوى','تصفية','خروج','شطب','هجوم','سلبي','انهيار'];

function cleanText(v){return String(v??'').replace(/\s+/g,' ').trim();}
function safeUrl(raw){try{const u=new URL(raw);return u.protocol==='https:'?u.toString():null;}catch{return null;}}
function wordScore(text,positive,negative){
  const t=cleanText(text).toLowerCase().split(/[^a-z0-9\u0600-\u06ff]+/i).filter(Boolean);let p=0,n=0;
  for(const x of t){if(positive.includes(x))p++;if(negative.includes(x))n++;}
  return {score:clamp(50+(p-n)*12),positive:p,negative:n};
}
async function fetchText(url,{timeoutMs=7000,fetchImpl=globalThis.fetch}={}){
  const ac=new AbortController();const tm=setTimeout(()=>ac.abort(),timeoutMs);
  try{
    const r=await fetchImpl(url,{method:'GET',redirect:'follow',headers:{accept:'text/html,application/json,application/rss+xml,text/xml','user-agent':'RadarX-Professor/1.0'},signal:ac.signal});
    if(!r.ok)throw new Error('HTTP_'+r.status);
    return await r.text();
  }finally{clearTimeout(tm);}
}
function extractBalancedJson(text,marker){
  const i=text.indexOf(marker);if(i<0)return null;const start=text.indexOf('{',i+marker.length);if(start<0)return null;
  let depth=0,inString=false,esc=false;
  for(let j=start;j<text.length;j++){
    const ch=text[j];
    if(inString){if(esc)esc=false;else if(ch==='\\')esc=true;else if(ch==='"')inString=false;continue;}
    if(ch==='"'){inString=true;continue;}
    if(ch==='{')depth++;
    else if(ch==='}'&&--depth===0){try{return JSON.parse(text.slice(start,j+1));}catch{return null;}}
  }
  return null;
}
function simpleText(x){return cleanText(x?.simpleText||x?.runs?.map(r=>r?.text||'').join(' ')||'');}
function walkVideoRenderers(node,out=[],seen=new Set()){
  if(!node||typeof node!=='object'||seen.has(node))return out;seen.add(node);
  if(node.videoRenderer?.videoId)out.push(node.videoRenderer);
  for(const v of Object.values(node))walkVideoRenderers(v,out,seen);
  return out;
}
function parseYoutubeSearch(html,query,limit){
  const data=extractBalancedJson(html,'var ytInitialData = ')||extractBalancedJson(html,'window["ytInitialData"] = ');
  const videos=walkVideoRenderers(data,[]),seen=new Set(),out=[];
  for(const v of videos){
    if(seen.has(v.videoId))continue;seen.add(v.videoId);
    const title=simpleText(v.title),description=simpleText(v.descriptionSnippet),channel=simpleText(v.ownerText);
    const badge=(v.badges||[]).map(b=>simpleText(b?.metadataBadgeRenderer)).join(' ');
    const overlay=(v.thumbnailOverlays||[]).map(x=>simpleText(x?.thumbnailOverlayTimeStatusRenderer?.text)).join(' ');
    const live=/live|مباشر|جار(?:ي|ٍ) الآن/i.test([title,badge,overlay].join(' '));
    if(!live&&!/trading|crypto|bitcoin|binance|تداول|مباشر|live/i.test(title))continue;
    const views=Number((simpleText(v.viewCountText)||'').replace(/[^0-9.]/g,''))||0;
    out.push({id:v.videoId,title,description,channel,viewers:views,published_text:simpleText(v.publishedTimeText),live,url:'https://www.youtube.com/watch?v='+encodeURIComponent(v.videoId),query});
    if(out.length>=limit)break;
  }
  return out;
}
async function readYoutubeTranscript(stream,{timeoutMs=6000,fetchImpl=globalThis.fetch}={}){
  try{
    const html=await fetchText(stream.url,{timeoutMs,fetchImpl});
    const player=extractBalancedJson(html,'var ytInitialPlayerResponse = ')||extractBalancedJson(html,'window["ytInitialPlayerResponse"] = ');
    const tracks=player?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if(!Array.isArray(tracks)||!tracks.length)return{available:false,text:'',reason:'NO_PUBLIC_CAPTIONS'};
    const track=tracks.find(x=>/^ar/i.test(String(x.languageCode)))||tracks.find(x=>/^en/i.test(String(x.languageCode)))||tracks[0];
    if(!track?.baseUrl)return{available:false,text:'',reason:'CAPTION_URL_MISSING'};
    const u=new URL(track.baseUrl);u.searchParams.set('fmt','json3');
    const body=await fetchText(u.toString(),{timeoutMs,fetchImpl});const json=JSON.parse(body);const parts=[];
    for(const e of json?.events||[])for(const s of e?.segs||[])if(s?.utf8)parts.push(cleanText(s.utf8));
    const text=parts.join(' ').replace(/\s+/g,' ').trim();
    return text?{available:true,text:text.slice(0,14000),language:track.languageCode||null,reason:null}:{available:false,text:'',reason:'CAPTION_EMPTY'};
  }catch(error){return{available:false,text:'',reason:String(error?.message??error)};}
}
function stripHtml(v){return cleanText(String(v||'').replace(/<[^>]+>/g,' '));}
function parseGdelt(text,limit){
  let json;try{json=JSON.parse(text);}catch{return[];}
  return (Array.isArray(json?.articles)?json.articles:[]).slice(0,limit).map(a=>({
    title:stripHtml(a?.title||''),url:safeUrl(a?.url),domain:cleanText(a?.domain||''),
    published_at:Date.parse(String(a?.datetime||a?.seendate||''))||null,tone:finite(a?.tone),source:'GDELT DOC 2.0'
  })).filter(x=>x.title&&x.url);
}
function buildAssetIndex(universe){
  const map=new Map();
  for(const row of universe){
    const symbol=String(row?.symbol||'').toUpperCase();const base=String(row?.baseAsset||symbol.replace(/USDT$/,'')).toUpperCase();
    if(!symbol.endsWith('USDT'))continue;const entry={symbol,baseAsset:base};map.set(symbol,entry);if(base.length>=2&&base.length<=12)map.set(base,entry);
  }
  return map;
}
function mentionedAssets(text,index){
  const t=String(text||'').toUpperCase();const hits=[];
  for(const [token,entry] of index){
    const safe=token.replace(/[^A-Z0-9]/gi,'');
    if(safe&&new RegExp('(^|[^A-Z0-9])'+safe+'([^A-Z0-9]|$)','i').test(t))hits.push(entry);
  }
  return [...new Map(hits.map(x=>[x.symbol,x])).values()].slice(0,20);
}
function streamClaim(text){
  const s=wordScore(text,BULL_WORDS,BEAR_WORDS);
  return {...s,action:s.positive>s.negative&&s.positive?'BUY_BIAS':s.negative>s.positive&&s.negative?'SELL_BIAS':'MENTION'};
}
function streamWeight(stream,evidence){
  const viewerBoost=clamp(Math.log10(Math.max(1,Number(stream.viewers||0)+1))*12,0,25);
  const evidenceBoost=evidence==='CAPTION'?25:evidence==='DESCRIPTION'?12:5;return 35+viewerBoost+evidenceBoost;
}
function newsSentiment(item){return Number.isFinite(item.tone)?clamp(50+item.tone*3):wordScore(item.title,NEWS_BULL,NEWS_BEAR).score;}
function aggregateMentions({streams,news,index}){
  const map=new Map();
  const get=s=>{if(!map.has(s))map.set(s,{symbol:s,baseAsset:s.replace(/USDT$/,''),stream_mentions:0,news_mentions:0,stream_weight:0,stream_signed:0,news_weight:0,news_sum:0,trade_claims:[],news_items:[]});return map.get(s);};
  for(const stream of streams){
    const text=[stream.title,stream.description,stream.transcript?.text||''].join(' ');const assets=mentionedAssets(text,index);
    const evidence=stream.transcript?.available?'CAPTION':stream.description?'DESCRIPTION':'TITLE';const claim=streamClaim(text);const w=streamWeight(stream,evidence);
    for(const a of assets){
      const c=get(a.symbol);c.stream_mentions++;c.stream_weight+=w;c.stream_signed+=(claim.action==='BUY_BIAS'?1:claim.action==='SELL_BIAS'?-1:0)*w;
      c.trade_claims.push({source:'YOUTUBE_PUBLIC',video_id:stream.id,channel:stream.channel,title:stream.title,url:stream.url,evidence,evidenced_action:claim.action,asset:a.symbol});
    }
  }
  for(const item of news){
    const assets=mentionedAssets(item.title,index);const score=newsSentiment(item);const w=35;
    for(const a of assets){const c=get(a.symbol);c.news_mentions++;c.news_sum+=score*w;c.news_weight+=w;c.news_items.push({title:item.title,url:item.url,domain:item.domain,published_at:item.published_at,tone:item.tone,sentiment_score:Number(score.toFixed(1)),source:item.source});}
  }
  return [...map.values()].map(c=>({...c,stream_score:Number((c.stream_weight?50+(c.stream_signed/c.stream_weight)*50:50).toFixed(1)),news_score:Number((c.news_weight?c.news_sum/c.news_weight:50).toFixed(1))}));
}
async function mapLimit(items,limit,fn){
  const out=new Array(items.length);let next=0;
  const worker=async()=>{while(true){const i=next++;if(i>=items.length)return;try{out[i]=await fn(items[i],i);}catch(error){out[i]={error:String(error?.message??error)};}}};
  await Promise.all(Array.from({length:Math.max(1,Math.min(limit,items.length))},worker));return out;
}
function buildOpinion(candidate,deep,now,entryThreshold=75,watchThreshold=66){
  const tech=finite(deep?.assessment?.direction_score,50);const trap=finite(deep?.assessment?.trap_risk,50);
  const technical=clamp(tech-(trap>65?(trap-65)*0.6:0));const stream=finite(candidate.stream_score,50);const news=finite(candidate.news_score,50);
  const evidenceTypes=[candidate.stream_mentions>0,candidate.news_mentions>0,deep].filter(Boolean).length;const score=clamp(technical*.48+stream*.30+news*.22);
  let action='WAIT_CONFIRMATION',stance='رأيي: انتظار';
  if(score>=entryThreshold&&technical>=68&&stream>=60&&news>=50){action='PAPER_ENTRY_CANDIDATE';stance='رأيي: أميل للشراء الورقي المشروط';}
  else if(score>=watchThreshold){action='PAPER_WATCH';stance='رأيي: أميل للصعود لكن أحتاج تأكيدًا قبل الدخول الورقي';}
  else if(score<48){action='SPOT_AVOID';stance='رأيي: أتجنب الشراء Spot حاليًا';}
  const px=finite(deep?.price?.last,finite(deep?.price?.last_closed_15m));const support=finite(deep?.zones?.support);const resistance=finite(deep?.zones?.resistance);
  let paperTrade=null;
  if(px>0&&action==='PAPER_ENTRY_CANDIDATE'){
    const low=support&&support<px?support:px*.998,high=px*1.003,stop=support&&support<low?support*.992:low*.988;
    const tp1=resistance&&resistance>px?resistance:px*1.025,tp2=Math.max(tp1*1.018,px*1.05),risk=Math.max(high-stop,px*.002),reward=Math.max(tp1-high,0);
    paperTrade={mode:'PAPER_ONLY',direction:'BUY',entry_range:{low:Number(low.toFixed(8)),high:Number(high.toFixed(8))},stop_loss:Number(stop.toFixed(8)),take_profit_1:Number(tp1.toFixed(8)),take_profit_2:Number(tp2.toFixed(8)),risk_reward:Number((reward/risk).toFixed(2)),invalidation:'إلغاء الفكرة إذا أُغلق السعر تحت وقف الخطة'};
  }
  return {score:Number(score.toFixed(1)),stance,action,evidence_types:evidenceTypes,evidence_strength:Number(clamp(candidate.stream_mentions*12+candidate.news_mentions*5+(deep?20:0)).toFixed(1)),technical_score:Number(technical.toFixed(1)),stream_score:Number(stream.toFixed(1)),news_score:Number(news.toFixed(1)),trap_risk:Number(trap.toFixed(1)),paper_trade:paperTrade,as_of:new Date(now).toISOString(),disclaimer:'رأي تحليلي آلي مبني على بيانات عامة؛ ليس ضمانًا للربح. التنفيذ الحقيقي غير متاح في RadarX.'};
}
function buildAlert(candidate,opinion,now){
  return {id:'PROFESSOR:'+candidate.symbol+':'+now,event:'PROFESSOR_LIVE_TRADE_INTELLIGENCE',radar:'PROFESSOR_RADAR',radar_name:'Radar 6 — البروفيسور',symbol:candidate.symbol,market:'SPOT',direction:opinion.action==='PAPER_ENTRY_CANDIDATE'?'UP_BIAS':opinion.action==='SPOT_AVOID'?'DOWN_OR_RISK':'NEUTRAL',opportunity_score:opinion.score,potential_label:opinion.action,professor_opinion:opinion,trade_claims:candidate.trade_claims.slice(0,12),news_items:candidate.news_items.slice(0,12),stream_mentions:candidate.stream_mentions,news_mentions:candidate.news_mentions,source:'YouTube Public Search + GDELT DOC 2.0 + Binance Public REST',detected_at:now,processed_at:now,detected_at_iso:new Date(now).toISOString(),detected_time_12h:formatRadarTime12h(now),detected_timezone:'Asia/Aden',paper_trading:true,real_order_execution:false,confidence_score:'UNKNOWN',closed_candles_only:true,disclaimer:opinion.disclaimer};
}
export function classifyStreamClaim(text){return streamClaim(text);}
export function calculateProfessorOpinion(input){return buildOpinion(input.candidate||input,input.deep||null,input.now||Date.now(),input.entryThreshold??75,input.watchThreshold??66);}

export class ProfessorRadar{
  constructor({rest,store,pushManager=null,deepAnalyzer=null,config={},clock=()=>Date.now(),logger=console,fetchImpl=globalThis.fetch}={}){
    if(!rest)throw new Error('REST_CLIENT_REQUIRED');if(!store)throw new Error('STORE_REQUIRED');
    this.rest=rest;this.store=store;this.pushManager=pushManager;this.deepAnalyzer=deepAnalyzer;this.config={...PROFESSOR_RADAR_DEFAULTS,...config};this.clock=clock;this.logger=logger;this.fetchImpl=fetchImpl;
    this.running=false;this.busy=false;this.timer=null;this.universe=[];this.universeAt=0;this.lastScanAtMs=null;this.lastError=null;this.alertCount=0;this.scans=0;this.latestCandidates=[];this.latestStreams=[];this.latestNews=[];this.lastResult=null;this.lastAlertAt=new Map();
  }
  start(){if(this.running)return;this.running=true;this.lastError=null;this.refreshUniverse().then(()=>this.tick()).catch(e=>this.noteError(e,'bootstrap'));this.timer=setInterval(()=>this.tick().catch(e=>this.noteError(e,'tick')),this.config.pollMs);}
  async stop(){this.running=false;if(this.timer)clearInterval(this.timer);this.timer=null;}
  noteError(e,where='scan'){this.lastError=String(e?.message??e);this.logger.warn?.('PROFESSOR_RADAR_'+where,this.lastError);}
  async refreshUniverse(){const r=await this.rest.request('/api/v3/exchangeInfo');this.universe=buildSpotUniverse(r.data,this.config.quote);this.universeAt=this.clock();}
  async discoverStreams(){
    const found=new Map();const errors=[];
    for(const query of this.config.searchQueries){
      try{
        const url='https://www.youtube.com/results?search_query='+encodeURIComponent(query);
        const html=await fetchText(url,{timeoutMs:this.config.webTimeoutMs,fetchImpl:this.fetchImpl});
        for(const s of parseYoutubeSearch(html,query,this.config.liveSearchLimit))found.set(s.id,s);
      }catch(e){errors.push(query+':'+String(e?.message??e));}
      await sleep(120);
    }
    const streams=[...found.values()].slice(0,this.config.liveSearchLimit);const targets=streams.filter(s=>s.live).slice(0,this.config.transcriptStreams);
    const transcripts=await mapLimit(targets,2,s=>readYoutubeTranscript(s,{timeoutMs:this.config.transcriptTimeoutMs,fetchImpl:this.fetchImpl}));
    const tm=new Map(targets.map((s,i)=>[s.id,transcripts[i]]));for(const s of streams)s.transcript=tm.get(s.id)||{available:false,text:'',reason:'NOT_ATTEMPTED'};
    return {streams,errors};
  }
  async discoverNews(){
    const queries=['(bitcoin OR ethereum OR crypto OR cryptocurrency OR binance OR altcoin)','(SEC OR ETF OR regulation OR hack OR exploit) (crypto OR bitcoin OR ethereum)','(listing OR partnership OR upgrade OR unlock OR liquidation) (crypto OR token)'];
    const found=new Map();const errors=[];
    for(const query of queries){
      const url='https://api.gdeltproject.org/api/v2/doc/doc?mode=artlist&format=json&maxrecords='+Math.min(75,this.config.newsLimit)+'&timespan=2h&query='+encodeURIComponent(query);
      try{const body=await fetchText(url,{timeoutMs:this.config.webTimeoutMs,fetchImpl:this.fetchImpl});for(const item of parseGdelt(body,this.config.newsLimit))found.set(item.url,item);}
      catch(e){errors.push('GDELT:'+String(e?.message??e));}
    }
    return {news:[...found.values()].sort((a,b)=>(Number(b.published_at)||0)-(Number(a.published_at)||0)).slice(0,this.config.newsLimit),errors};
  }
  async tick(){
    if(!this.running||this.busy)return false;this.busy=true;const now=this.clock();
    try{
      if(now-this.universeAt>this.config.universeRefreshMs)await this.refreshUniverse();
      const [streamResult,newsResult]=await Promise.all([this.discoverStreams(),this.discoverNews()]);
      this.latestStreams=streamResult.streams;this.latestNews=newsResult.news;const index=buildAssetIndex(this.universe);
      const mentions=aggregateMentions({streams:this.latestStreams,news:this.latestNews,index}).sort((a,b)=>(b.stream_mentions+b.news_mentions)-(a.stream_mentions+a.news_mentions)).slice(0,Math.max(1,this.config.deepCandidates));
      const deep=await mapLimit(mentions,this.config.deepConcurrency,async c=>({candidate:c,deep:this.deepAnalyzer?await this.deepAnalyzer.scan(c.symbol):null}));const enriched=[];
      for(const row of deep){
        if(row?.error)continue;const opinion=buildOpinion(row.candidate,row.deep,now,this.config.minEntryScore,this.config.minWatchScore);const result={...row.candidate,deep_scan:row.deep,opinion};enriched.push(result);this.scans++;
        if(opinion.action==='PAPER_ENTRY_CANDIDATE'&&opinion.evidence_types>=2&&now-(this.lastAlertAt.get(result.symbol)||0)>=this.config.alertCooldownMs){
          const alert=buildAlert(result,opinion,now);this.lastAlertAt.set(result.symbol,now);await this.store.appendProfessorAlert(alert);if(this.pushManager?.notifyRadarAlert)await this.pushManager.notifyRadarAlert(alert);this.alertCount++;
        }
      }
      this.latestCandidates=enriched.sort((a,b)=>b.opinion.score-a.opinion.score).slice(0,20);this.lastScanAtMs=now;
      this.lastError=[...streamResult.errors,...newsResult.errors].join(' | ')||null;
      this.lastResult={radar:'PROFESSOR_RADAR',radar_name:'Radar 6 — البروفيسور',as_of:new Date(now).toISOString(),universe:{eligible_spot_symbols:this.universe.length,mentioned_symbols:mentions.length,deep_scanned:enriched.length},streams:{count:this.latestStreams.length,live_count:this.latestStreams.filter(x=>x.live).length,source_status:streamResult.errors.length?'PARTIAL':'LIVE',items:this.latestStreams},news:{count:this.latestNews.length,source_status:newsResult.errors.length?'PARTIAL':'LIVE',items:this.latestNews},candidates:this.latestCandidates,meta:{live:true,paper_trading:true,real_order_execution:false,confidence_score:'UNKNOWN',discovery_scope:'Public YouTube search pages are not exhaustive; news via GDELT realtime coverage.'},errors:this.lastError?this.lastError.split(' | ').slice(0,8):[]};
      return true;
    }catch(e){
      this.lastScanAtMs=now;this.noteError(e,'tick');this.lastResult={...(this.lastResult||{}),radar:'PROFESSOR_RADAR',radar_name:'Radar 6 — البروفيسور',as_of:new Date(now).toISOString(),scan_error:this.lastError,meta:{live:false,paper_trading:true,real_order_execution:false,confidence_score:'UNKNOWN'}};return false;
    }finally{this.busy=false;}
  }
  snapshot(limit=10){return {...(this.lastResult||{radar:'PROFESSOR_RADAR',radar_name:'Radar 6 — البروفيسور',as_of:null,universe:{eligible_spot_symbols:this.universe.length,mentioned_symbols:0,deep_scanned:0},streams:{count:0,live_count:0,source_status:'INIT',items:[]},news:{count:0,source_status:'INIT',items:[]},candidates:[],meta:{live:false,paper_trading:true,real_order_execution:false,confidence_score:'UNKNOWN'}}),candidates:(this.latestCandidates||[]).slice(0,Math.max(1,Math.min(50,Number(limit)||10))) };}
  health(){return {running:this.running,busy:this.busy,radar:'PROFESSOR_RADAR',radar_name:'Radar 6 — البروفيسور',universe:this.universe.length,last_universe_refresh_at:this.universeAt||null,last_scan_at:this.lastScanAtMs,scans:this.scans,alerts_emitted:this.alertCount,last_error:this.lastError,stream_count:this.latestStreams.length,news_count:this.latestNews.length,source:'YouTube Public Search + GDELT DOC 2.0 + Binance Public REST',closed_candles_only:true,paper_trading:true,real_order_execution:false,confidence_score:'UNKNOWN',algorithms:['Public live-stream discovery','Trade-claim extraction','Caption-first evidence','GDELT news clustering','News tone fusion','Binance deep technical confirmation','Spot-only paper decision']};}
}
