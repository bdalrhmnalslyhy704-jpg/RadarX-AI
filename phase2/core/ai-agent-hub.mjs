const C=(v,a=0,b=100)=>Math.max(a,Math.min(b,Number.isFinite(Number(v))?Number(v):50));
const N=(v,d=null)=>Number.isFinite(Number(v))?Number(v):d;
const U=a=>[...new Set((Array.isArray(a)?a:[]).filter(Boolean))];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

export const AGENT_REGISTRY=Object.freeze([
{id:'NEWS_SCOUT',name:'🛰️ مستكشف الأخبار',role:'تغطية واسعة وحداثة وتنوع المصادر'},
{id:'OFFICIAL_VERIFIER',name:'🏛️ المدقق الرسمي',role:'تمييز بيانات الشركات والمؤسسات والمصادر الرسمية'},
{id:'SOCIAL_PULSE',name:'💬 نبض المجتمع',role:'تحليل المنشورات والتعليقات وتقليل الضجيج'},
{id:'CATALYST_HUNTER',name:'⚡ صائد المحفزات',role:'اكتشاف الإدراجات والترقيات والشراكات والمخاطر'},
{id:'NARRATIVE_ENGINE',name:'🧠 محلل السرد',role:'كشف تغير السرد والتوافق بين المصادر'},
{id:'MARKET_REGIME',name:'🌐 حارس نظام السوق',role:'قراءة السياق العام والاتجاه المسيطر قبل الحكم على العملة'},
{id:'MTF_STRUCTURE',name:'🧭 محلل البنية المتعددة',role:'مطابقة 15m و1h و4h ومنع الفريم الصغير من تجاوز الأكبر'},
{id:'TREND_ALIGNMENT',name:'📈 محلل الاتجاه',role:'قياس استمرارية الاتجاه وتوافق المتوسطات عبر الأطر'},
{id:'MOMENTUM_ENGINE',name:'🚀 محرك الزخم',role:'قياس تسارع الزخم وتحولاته دون مطاردة الحركة المتأخرة'},
{id:'VOLATILITY_SQUEEZE',name:'🌀 محلل الانكماش',role:'رصد ضغط التذبذب واستعداد السوق للتوسع'},
{id:'RVOL_ACCELERATION',name:'📊 محلل تسارع الحجم',role:'مقارنة RVOL وتغير المشاركة مع الحركة'},
{id:'LIQUIDITY_QUALITY',name:'💧 حارس جودة السيولة',role:'اختبار قابلية الدخول عبر الحجم وعمق دفتر الأوامر'},
{id:'ORDER_FLOW_PRESSURE',name:'🌊 محلل ضغط التدفق',role:'تحليل Taker Buy واختلال دفتر الأوامر'},
{id:'SUPPORT_RESISTANCE',name:'🧱 محلل الدعم والمقاومة',role:'تحديد مناطق الارتداد والاختبار والمساحة قبل المقاومة'},
{id:'BREAKOUT_VALIDATOR',name:'🔓 مدقق الاختراق',role:'تمييز الاختراق القابل للتصديق عن مجرد لمس المقاومة'},
{id:'TRAP_DETECTOR',name:'🪤 كاشف الفخاخ',role:'كشف الفشل السريع والضغط المعاكس والتمدد الخطِر'},
{id:'RELATIVE_STRENGTH',name:'⚔️ محلل القوة النسبية',role:'قياس التفوق على BTC عندما تكون مقارنة موثقة متاحة'},
{id:'HISTORY_LEARNER',name:'📚 متعلم النتائج',role:'تحديث الأوزان من نتائج التنبؤات السابقة دون اختلاق أداء'},
{id:'RISK_GEOMETRY',name:'📐 مهندس المخاطر',role:'حساب المساحة بين السعر والدعم والمقاومة والتمدد'},
{id:'CHIEF_DECIDER',name:'👑 مدير مجلس المحللين',role:'دمج أحكام المحللين التسعة عشر مع حواجز رفض صلبة'}
]);

const OFFICIAL=['binance.com','coinbase.com','kraken.com','okx.com','bybit.com','kucoin.com','circle.com','tether.to','ripple.com','solana.com','ethereum.org','chain.link','sec.gov','cftc.gov','bis.org'];
const MEDIA=['reuters.com','bloomberg.com','coindesk.com','cointelegraph.com','theblock.co','decrypt.co','dlnews.com','forbes.com','cnbc.com','ft.com'];
const BULL=['buy','bullish','breakout','entry','accumulate','support','reclaim','launch','adoption','approval','approved','partnership','integration','listing','upgrade','inflow','growth','surge','record','شراء','صعود','اختراق','تجميع','شراكة','إطلاق','إدراج','ترقية','تدفقات'];
const BEAR=['sell','bearish','breakdown','exit','distribution','resistance','reject','hack','exploit','ban','lawsuit','liquidation','outflow','delist','delisting','attack','fraud','collapse','risk','بيع','هبوط','كسر','تصريف','اختراق','حظر','دعوى','تصفية','خروج','شطب','هجوم','انهيار','مخاطر'];
const CAT=['listing','approval','etf','partnership','integration','upgrade','mainnet','launch','unlock','tokenomics','airdrop','burn','buyback','adoption','funding','investment','إدراج','اعتماد','شراكة','ترقية','إطلاق','فتح','حرق','شراء','تبنّي','تمويل','استثمار'];
const RISK=['hack','exploit','security','lawsuit','fraud','freeze','halt','delist','unlock','inflation','insolvency','liquidation','investigation','ban','اختراق','استغلال','أمن','دعوى','احتيال','تجميد','تعليق','شطب','فتح','تضخم','إفلاس','تصفية','تحقيق','حظر'];

function clean(v){return String(v??'').replace(/\s+/g,' ').trim()}
function host(v){try{return new URL(v).hostname.replace(/^www\./,'').toLowerCase()}catch{return ''}}
function url(v){try{const u=new URL(v);return u.protocol==='https:'?u.toString():null}catch{return null}}
function sig(text){const t=clean(text).toLowerCase().split(/[^a-z0-9\u0600-\u06ff]+/i).filter(Boolean);let p=0,n=0,c=0,r=0;for(const x of t){if(BULL.includes(x))p++;if(BEAR.includes(x))n++;if(CAT.includes(x))c++;if(RISK.includes(x))r++}return{sent:C(50+(p-n)*9),cat:C(c*20),risk:C(r*20)}}
async function fetchText(u,{timeoutMs=7000,fetchImpl=globalThis.fetch}={}){const ac=new AbortController(),tm=setTimeout(()=>ac.abort(),timeoutMs);try{const r=await fetchImpl(u,{method:'GET',redirect:'follow',headers:{accept:'application/json,application/rss+xml,text/xml,text/html','user-agent':'RadarX-AI-Agent-Hub/1.0'},signal:ac.signal});if(!r.ok)throw new Error('HTTP_'+r.status);return await r.text()}finally{clearTimeout(tm)}}
function parseGdelt(t,lim=40){let j;try{j=JSON.parse(t)}catch{return[]}return(Array.isArray(j?.articles)?j.articles:[]).slice(0,lim).map(a=>({title:clean(a?.title),url:url(a?.url),published_at:Date.parse(String(a?.datetime||a?.seendate||''))||null,domain:clean(a?.domain)||host(a?.url),tone:N(a?.tone,null),source:'GDELT'})).filter(x=>x.title&&x.url)}
function parseRss(t,lim=30){const out=[],bs=String(t||'').match(/<item[\s\S]*?<\/item>/gi)||[];for(const b of bs.slice(0,lim)){const g=n=>{const m=b.match(new RegExp('<'+n+'[^>]*>([\\s\\S]*?)<\\/'+n+'>','i'));return m?clean(m[1].replace(/<!\[CDATA\[|\]\]>/g,'')):''};const u=url(g('link')),title=g('title');if(u&&title)out.push({title,url:u,published_at:Date.parse(g('pubDate')||g('published')||g('dc:date'))||null,domain:host(u),source:'Google News RSS'})}return out}
function parseReddit(t,lim=10){let j;try{j=JSON.parse(t)}catch{return[]}return(j?.data?.children||[]).slice(0,lim).map(x=>{const d=x?.data||{};return{id:d.id,title:clean(d.title),text:clean(d.selftext),url:url('https://www.reddit.com'+(d.permalink||'')),published_at:N(d.created_utc,0)*1000,subreddit:clean(d.subreddit),score:N(d.score,0),num_comments:N(d.num_comments,0),source:'Reddit'}}).filter(x=>x.title&&x.url)}
function parseComments(t,lim=8){let j;try{j=JSON.parse(t)}catch{return[]}const kids=Array.isArray(j)&&j[1]?.data?.children?j[1].data.children:[],out=[];const walk=(a,d=0)=>{if(d>2)return;for(const x of a||[]){const q=x?.data;if(!q)continue;if(typeof q.body==='string')out.push({id:q.id,text:clean(q.body),score:N(q.score,0),published_at:N(q.created_utc,0)*1000,source:'Reddit Comment'});if(Array.isArray(q.replies?.data?.children))walk(q.replies.data.children,d+1);if(out.length>=lim)return}};walk(kids);return out.slice(0,lim)}
function sourceClass(u,kind){const h=host(u);if(OFFICIAL.some(d=>h===d||h.endsWith('.'+d)))return'OFFICIAL';if(MEDIA.some(d=>h===d||h.endsWith('.'+d)))return'MAJOR_MEDIA';if(kind==='social')return'SOCIAL';return'AGGREGATOR'}
export function classifyEvidence(x,now=Date.now()){const s=sig(x.text||x.title||''),age=Math.max(0,now-N(x.published_at,now)),fresh=age<3600000?1:age<6*3600000?.8:age<24*3600000?.55:.3;return{...x,sentiment:s.sent,catalyst_score:s.cat,risk_score:s.risk,freshness:fresh,reliability:x.class==='OFFICIAL'?1:x.class==='MAJOR_MEDIA'?.82:x.class==='SOCIAL'?.35:.62}}
function dedupe(items){const m=new Map();for(const x of items){const k=host(x.url)+'|'+clean(x.title||x.text).toLowerCase().replace(/[^a-z0-9\u0600-\u06ff]+/gi,' ').slice(0,160);if(!m.has(k))m.set(k,x)}return[...m.values()]}
function corroborate(items){const b=new Map();for(const x of items){const k=clean(x.title||x.text).toLowerCase().replace(/[^a-z0-9\u0600-\u06ff]+/gi,' ').split(' ').filter(w=>w.length>3).slice(0,5).join('|');if(!b.has(k))b.set(k,[]);b.get(k).push(x)}let v=0,u=0;for(const a of b.values()){const ds=new Set(a.map(x=>host(x.url)).filter(Boolean));const official=a.some(x=>x.class==='OFFICIAL');if(ds.size>=2&&(official||a.length>=2))v++;else u++}return{verified:v,unverified:u}}
function avg(a,d=50){const x=(a||[]).map(Number).filter(Number.isFinite);return x.length?x.reduce((s,v)=>s+v,0)/x.length:d}
function weights(memory){const latest=new Map();for(const x of memory||[]){const id=String(x?.id||'');if(id&&!latest.has(id))latest.set(id,x)}const st={};for(const x of latest.values()){const id=String(x.agent_id||'');if(!id)continue;st[id]??={wins:0,losses:0,neutral:0};if(x.outcome==='WIN')st[id].wins++;else if(x.outcome==='LOSS')st[id].losses++;else if(x.outcome==='NEUTRAL')st[id].neutral++;}const w={};for(const a of AGENT_REGISTRY){const s=st[a.id]||{wins:0,losses:0,neutral:0},n=s.wins+s.losses,rate=n>=3?(s.wins+2)/(n+4):.5;w[a.id]=Number(Math.max(.82,Math.min(1.18,.82+rate*.36)).toFixed(3))}return{stats:st,weights:w}}
function adj(v,w){return C(50+(v-50)*w)}
function bucketLabel(score){
  return score>=78?'STRONG':score>=62?'SUPPORTIVE':score<=38?'NEGATIVE':'MIXED';
}
function confidenceFor({score,dataPoints=0,unknown=false}={}){
  if(unknown||!Number.isFinite(Number(score))||dataPoints<2)return 'LOW';
  if(dataPoints>=5&&Math.abs(Number(score)-50)>=18)return 'HIGH';
  return 'MEDIUM';
}
function makeAgents(e,d,learning){
  const news=e.news||[],off=e.official||[],soc=e.social||[],all=e.all||[];
  const a=d?.assessment||{},liq=d?.liquidity||{},pr=d?.pressure||{},momBlock=d?.momentum||{};
  const t15=d?.timeframes?.['15m']||{},t1=d?.timeframes?.['1h']||{},t4=d?.timeframes?.['4h']||{};
  const rvol15=N(t15.rvol,1),rvol1=N(t1.rvol,1),rvol4=N(t4.rvol,1);
  const trend=avg([t15.trend_score,t1.trend_score,t4.trend_score]);
  const mom=avg([t15.momentum_score,t1.momentum_score,t4.momentum_score]);
  const dir=N(a.direction_score,50),analysisStrength=N(a.analysis_strength,50);
  const trap=N(a.trap_risk,50),pressure=N(pr.score,50),liquidity=N(liq.score,50);
  const sent=avg(all.map(x=>x.sentiment)),riskNews=avg(all.map(x=>x.risk_score),0),cat=avg(all.map(x=>x.catalyst_score),0);
  const ver=N(e.corroboration?.verified,0),dom=N(e.independent_domains,0);
  const support=N(d?.zones?.support,null),resistance=N(d?.zones?.resistance,null),price=N(d?.price?.last,null);
  const change24=N(d?.price?.change_24h_pct,0),ext=Math.abs(change24);
  const supportDist=support&&price?Math.max(0,(price/support-1)*100):null;
  const resistanceDist=resistance&&price?Math.max(0,(resistance/price-1)*100):null;
  const bb15=N(t15?.bollinger?.width,null),bb1=N(t1?.bollinger?.width,null);
  const atrPct15=t15?.atr14&&price?Math.abs(Number(t15.atr14))/price*100:null;
  const rvolAccel=50+(rvol15-1)*34+(rvol15-rvol1)*22;
  const squeeze=bb15==null?50:C(bb15<=1.2?91:bb15<=2?78:bb15<=3.5?64:bb15<=6?48:32);
  const trendAlignment=50+(trend-50)*.65+(mom-50)*.25+(N(t4.trend_score,50)-N(t15.trend_score,50))*.10;
  const marketRegime=C((dir*.45)+(trend*.35)+(analysisStrength*.20));
  const mtfStructure=C((N(t4.trend_score,50)*.50)+(N(t1.trend_score,50)*.30)+(N(t15.trend_score,50)*.20));
  const momentumEngine=C(N(momBlock.score,mom)*.60+N(t15.momentum_score,mom)*.22+C(rvol15*48)*.18);
  const liquidityAgent=C(liquidity*.72+C((N(liq.quote_volume_24h,0)>0?Math.log10(Math.max(1,N(liq.quote_volume_24h,0))):4)-4)*8);
  const flowAgent=C(pressure*.72+C(rvol15*38)*.28);
  let sr=50;
  if(d?.zones?.position==='NEAR_SUPPORT'&&d?.zones?.bounce_signal==='BULLISH_REBOUND_SETUP')sr+=28;
  if(d?.zones?.position==='NEAR_RESISTANCE')sr-=12;
  if(resistanceDist!=null&&resistanceDist<1.2)sr-=14;
  if(supportDist!=null&&supportDist<1.5)sr+=10;
  sr+=N(d?.zones?.bonus,0);
  const breakout=C(
    (d?.assessment?.signal_context==='MOMENTUM_CONTINUATION_WATCH'?70:50)*.22+
    pressure*.24+
    C(rvol15*42)*.20+
    (resistanceDist!=null&&resistanceDist<2.5?72:54)*.18+
    (dir>=65?75:45)*.16
  );
  const trapDetector=C(100-trap*.78-Math.max(0,ext-8)*2.4+(pressure>=62&&trend>=62?8:0)-(rvol15>=2.5&&Math.abs(N(t15.return_3_candles_pct,0))<.4?14:0));
  const relativeRaw=d?.relative_strength?.score ?? d?.relative_strength_vs_btc?.score ?? d?.market?.relative_strength_vs_btc?.score;
  const relativeUnknown=!Number.isFinite(Number(relativeRaw));
  const relative=C(relativeUnknown?50:Number(relativeRaw));
  const accumulation=C(50+(pressure-50)*.48+(rvol15-1)*18+(trend-50)*.18);
  const historyBase=Object.values(learning.weights||{}).filter(x=>Number.isFinite(Number(x)));
  const historyScore=C(50+(historyBase.length?avg(historyBase.map(x=>(Number(x)-1)*100),0)*.55:0));
  let geometry=52;
  if(price!=null&&support!=null){
    const riskPerUnit=Math.max(price-support,price*.003);
    const reward=Number.isFinite(resistance)&&resistance>price?resistance-price:price*.03;
    const rr=reward/Math.max(riskPerUnit,1e-12);
    geometry=C(30+rr*24-(ext>8?(ext-8)*3:0));
  }else geometry=C(45-(ext>10?(ext-10)*2:0));
  const raw={
    NEWS_SCOUT:C(sent*.55+Math.min(20,news.length)*1.4+Math.min(15,dom*.8)-riskNews*.25),
    OFFICIAL_VERIFIER:C(50+off.length*7+ver*6-riskNews*.3),
    SOCIAL_PULSE:C(50+(avg(soc.map(x=>x.sentiment),50)-50)*.75+Math.min(15,(e.comment_count||0)*.7)-Math.min(20,e.social_spam_penalty||0)),
    CATALYST_HUNTER:C(45+cat*.55+ver*7-riskNews*.55),
    NARRATIVE_ENGINE:C(sent*.7+Math.min(18,dom*1.1)+ver*4-riskNews*.25),
    MARKET_REGIME:marketRegime,
    MTF_STRUCTURE:mtfStructure,
    TREND_ALIGNMENT:trendAlignment,
    MOMENTUM_ENGINE:momentumEngine,
    VOLATILITY_SQUEEZE:squeeze,
    RVOL_ACCELERATION:C(rvolAccel),
    LIQUIDITY_QUALITY:liquidityAgent,
    ORDER_FLOW_PRESSURE:flowAgent,
    SUPPORT_RESISTANCE:C(sr),
    BREAKOUT_VALIDATOR:breakout,
    TRAP_DETECTOR:trapDetector,
    RELATIVE_STRENGTH:relative,
    HISTORY_LEARNER:historyScore,
    RISK_GEOMETRY:geometry,
    CHIEF_DECIDER:50
  };
  raw.CHIEF_DECIDER=avg(Object.entries(raw).filter(([k])=>k!=='CHIEF_DECIDER').map(([k,v])=>adj(v,learning.weights[k]||1)));

  const reasons={
    NEWS_SCOUT:['الأخبار المتاحة: '+news.length,'توزيع المصادر: '+dom],
    OFFICIAL_VERIFIER:['المصادر الرسمية/المؤسسية: '+off.length,'التحقق المستقل: '+ver],
    SOCIAL_PULSE:['التعليقات: '+(e.comment_count||0),'تم خفض أثر الضجيج الاجتماعي'],
    CATALYST_HUNTER:['المحفزات: '+Math.round(cat),'مخاطر الأخبار: '+Math.round(riskNews)],
    NARRATIVE_ENGINE:['النبرة المجمعة: '+Math.round(sent),'توافق مصادر مستقل: '+ver],
    MARKET_REGIME:['قراءة النظام: '+bucketLabel(marketRegime),'الدرجة الاتجاهية: '+Math.round(dir)],
    MTF_STRUCTURE:['15m/1h/4h: '+Math.round(mtfStructure),'الفريم الأعلى له الوزن الأكبر'],
    TREND_ALIGNMENT:['اتساق الاتجاه: '+Math.round(trendAlignment),'زخم داعم: '+Math.round(mom)],
    MOMENTUM_ENGINE:['محرك الزخم: '+Math.round(momentumEngine),'RVOL 15m: '+rvol15.toFixed(2)],
    VOLATILITY_SQUEEZE:['عرض BB 15m: '+(bb15==null?'غير متاح':bb15.toFixed(2)+'%'),'ضغط الانكماش: '+Math.round(squeeze)],
    RVOL_ACCELERATION:['RVOL 15m/1h: '+rvol15.toFixed(2)+' / '+rvol1.toFixed(2),'التسارع: '+Math.round(rvolAccel)],
    LIQUIDITY_QUALITY:['السيولة: '+Math.round(liquidity),'الحجم 24h: '+Math.round(Math.log10(Math.max(1,N(liq.quote_volume_24h,0))))],
    ORDER_FLOW_PRESSURE:['ضغط التدفق: '+Math.round(pressure),'Taker/دفتر الأوامر عند التوفر'],
    SUPPORT_RESISTANCE:['الوضع: '+String(d?.zones?.position||'UNKNOWN'),'المقاومة: '+(resistanceDist==null?'غير متاحة':resistanceDist.toFixed(2)+'%')],
    BREAKOUT_VALIDATOR:['سياق الإشارة: '+String(d?.assessment?.signal_context||'UNKNOWN'),'اختبار الاختراق: '+Math.round(breakout)],
    TRAP_DETECTOR:['خطر الفخ الأساسي: '+Math.round(trap),'درجة أمان بعد الخصم: '+Math.round(trapDetector)],
    RELATIVE_STRENGTH:[relativeUnknown?'مقارنة BTC غير متاحة في هذا المسح':'مقارنة BTC موثقة متاحة','الدرجة: '+Math.round(relative)],
    HISTORY_LEARNER:['الأوزان السابقة مستخدمة للتعلم التدريجي','السجلات المتاحة: '+historyBase.length],
    RISK_GEOMETRY:['المساحة بين السعر والدعم/المقاومة','التمدد 24h: '+ext.toFixed(2)+'%'],
    CHIEF_DECIDER:['دمج موزون لـ19 محللًا متخصصًا','لا يتجاوز حواجز الرفض الصلبة']
  };

  const evidenceCounts={
    NEWS_SCOUT:news.length+dom,OFFICIAL_VERIFIER:off.length+ver,SOCIAL_PULSE:soc.length+(e.comment_count||0),
    CATALYST_HUNTER:news.length+off.length,NARRATIVE_ENGINE:dom+ver,
    MARKET_REGIME:[dir,trend,analysisStrength].filter(Number.isFinite).length,
    MTF_STRUCTURE:[t15.trend_score,t1.trend_score,t4.trend_score].filter(Number.isFinite).length,
    TREND_ALIGNMENT:[t15.trend_score,t1.trend_score,t4.trend_score].filter(Number.isFinite).length,
    MOMENTUM_ENGINE:[mom,momBlock.score,t15.momentum_score,rvol15].filter(Number.isFinite).length,
    VOLATILITY_SQUEEZE:[bb15,bb1,atrPct15].filter(Number.isFinite).length,
    RVOL_ACCELERATION:[rvol15,rvol1,rvol4].filter(Number.isFinite).length,
    LIQUIDITY_QUALITY:[liquidity,liq.quote_volume_24h,liq.near_book_notional].filter(Number.isFinite).length,
    ORDER_FLOW_PRESSURE:[pressure,pr.taker_buy_ratio,pr.orderbook_imbalance].filter(Number.isFinite).length,
    SUPPORT_RESISTANCE:[support,resistance,d?.zones?.position,d?.zones?.bounce_signal].filter(x=>x!=null).length,
    BREAKOUT_VALIDATOR:[breakout,resistanceDist,rvol15,pressure].filter(Number.isFinite).length,
    TRAP_DETECTOR:[trap,pressure,trend,ext].filter(Number.isFinite).length,
    RELATIVE_STRENGTH:relativeUnknown?0:1,
    HISTORY_LEARNER:historyBase.length,
    RISK_GEOMETRY:[price,support,resistance,ext].filter(Number.isFinite).length,
    CHIEF_DECIDER:19
  };

  return AGENT_REGISTRY.map(x=>{
    const baseScore=raw[x.id];
    const score=Number(adj(baseScore,learning.weights[x.id]||1).toFixed(1));
    const unknown=x.id==='RELATIVE_STRENGTH'&&relativeUnknown;
    return {
      id:x.id,name:x.name,role:x.role,score,direction:score>=62?'BUY_BIAS':score<=38?'SELL_BIAS':'WATCH',
      bucket:bucketLabel(score),confidence:confidenceFor({score,dataPoints:evidenceCounts[x.id]||0,unknown}),
      weight:learning.weights[x.id]||1,reasons:U(reasons[x.id]||[]),
      data_points:{news:news.length,official:off.length,social:soc.length,comments:e.comment_count||0,verified:ver,domains:dom,market:evidenceCounts[x.id]||0}
    };
  });
}

export async function collectAgentEvidence({symbol}={}){const sym=String(symbol||'').trim().toUpperCase();if(!/^[A-Z0-9]{5,20}$/.test(sym))throw new Error('INVALID_SYMBOL');const base=sym.endsWith('USDT')?sym.slice(0,-4):sym,q='('+sym+' OR '+base+') crypto';
const [g,n,r]=await Promise.all([fetchText('https://api.gdeltproject.org/api/v2/doc/doc?query='+encodeURIComponent(q)+'&mode=artlist&format=json&maxrecords=40&timespan=24h&sort=HybridRel').then(x=>parseGdelt(x,40)).catch(()=>[]),fetchText('https://news.google.com/rss/search?q='+encodeURIComponent(q)+'&hl=en-US&gl=US&ceid=US:en').then(x=>parseRss(x,30)).catch(()=>[]),fetchText('https://www.reddit.com/search.json?q='+encodeURIComponent(sym+' OR '+base)+'&limit=10&sort=new&t=day&raw_json=1').then(x=>parseReddit(x,10)).catch(()=>[])]);
const comments=[];for(const p of r.slice(0,3)){try{const body=await fetchText(p.url+'.json?raw_json=1&sort=top&limit=8',{timeoutMs:5000});comments.push(...parseComments(body,8))}catch{}await sleep(40)}
const news=dedupe([...g,...n].map(x=>({...x,class:sourceClass(x.url,'news')})).map(x=>classifyEvidence(x))),official=dedupe(g.map(x=>({...x,class:sourceClass(x.url,'news')})).filter(x=>x.class==='OFFICIAL').map(x=>classifyEvidence(x))),social=dedupe([...r,...comments].map(x=>({...x,class:'SOCIAL'})).map(x=>classifyEvidence(x))),all=dedupe([...news,...official,...social]),domains=new Set(all.map(x=>host(x.url)).filter(Boolean));
const spam=Math.max(0,social.filter(x=>x.sentiment!==50).length*.25-social.filter(x=>N(x.score,0)>=5).length*.15);
return{query:q,news:news.slice(0,45),official:official.slice(0,30),social:social.slice(0,30),all,independent_domains:domains.size,comment_count:comments.length,social_spam_penalty:Number(spam.toFixed(1)),corroboration:corroborate(all),source_coverage:{gdelt:g.length,google_news:n.length,reddit_posts:r.length,reddit_comments:comments.length,official_found:official.length},limitations:['لا يمكن ضمان قراءة كل موقع أو منصة مغلقة.','المصادر الاجتماعية عامة وتحتاج تحققًا مستقلًا.']}}
export function buildAgentVerdict({symbol,evidence={},deepScan=null,memory=[]}={}){const learning=weights(memory),agents=makeAgents(evidence,deepScan,learning),guard=agents.find(x=>x.id==='RISK_GUARDIAN')?.score||50,chief=agents.find(x=>x.id==='CHIEF_DECIDER')?.score||50,trap=N(deepScan?.assessment?.trap_risk,50),dq=N(deepScan?.data_quality?.score ?? deepScan?.scores?.data_quality,null),hard=(dq!=null&&dq<70)||trap>=78||guard<35,action=hard?'SPOT_AVOID':chief>=82&&guard>=60?'PAPER_WATCH':chief>=68?'WATCH':'WAIT_CONFIRMATION',direction=chief>=62?'BUY_BIAS':chief<=38?'SELL_BIAS':'NEUTRAL';return{engine:'AI_ANALYST_COUNCIL_20',engine_name:'🧠 مجلس 20 محللًا',council_size:AGENT_REGISTRY.length,specialist_count:AGENT_REGISTRY.length-1,symbol:String(symbol).toUpperCase(),agents,decision:{action,direction,score:Number(chief.toFixed(1)),quorum,quorum_required:12,quorum_ok:quorumOk,risk_score:Number((100-guard).toFixed(1)),trap_risk:trap,hard_reject:hard,stance:action==='PAPER_WATCH'?'اللجنة: مراقبة قوية مشروطة':action==='SPOT_AVOID'?'اللجنة: تجنب حاليًا':'اللجنة: انتظار التأكيد'},evidence_summary:{total:evidence.all?.length||0,news:evidence.news?.length||0,official:evidence.official?.length||0,social:evidence.social?.length||0,comments:evidence.comment_count||0,independent_domains:evidence.independent_domains||0,verified_claims:evidence.corroboration?.verified||0,unverified_claims:evidence.corroboration?.unverified||0},source_coverage:evidence.source_coverage||{},learning:{weights:learning.weights,stats:learning.stats},data_policy:{spot_only:true,paper_trading:true,real_order_execution:false,confidence_score:'UNKNOWN',closed_candles_only:true,no_synthetic_prices:true,hard_reject_on_invalid_data:true},disclaimer:'تحليل آلي احتمالي؛ لا يضمن الربح ولا ينفذ أوامر حقيقية.'}}
export function evaluateMemory(memory,{symbol,currentPrice,now=Date.now()}={}){const p=N(currentPrice,null);if(p==null)return[];const out=[];for(const x of memory||[]){if(String(x.symbol||'').toUpperCase()!==String(symbol||'').toUpperCase()||x.outcome!=='PENDING')continue;const age=now-N(x.created_at,now);if(age<15*60*1000)continue;const e=N(x.entry_price,p),ret=(p-e)/Math.max(e,1e-12)*100,th=age>=4*3600000?3:1.5,win=x.direction==='BUY_BIAS'?ret>=th:x.direction==='SELL_BIAS'?ret<=-th:false,loss=x.direction==='BUY_BIAS'?ret<=-th:x.direction==='SELL_BIAS'?ret>=th:false;if(win||loss||age>=24*3600000)out.push({...x,outcome:win?'WIN':loss?'LOSS':'NEUTRAL',return_pct:Number(ret.toFixed(3)),evaluated_at:now})}return out}
export function createMemoryEntries({symbol,price,agents,now=Date.now()}={}){const p=N(price,null);if(p==null)return[];return(agents||[]).filter(x=>x.id&&x.id!=='CHIEF_DECIDER').map(x=>({id:x.id+':'+String(symbol).toUpperCase()+':'+now,agent_id:x.id,symbol:String(symbol).toUpperCase(),created_at:now,entry_price:p,direction:x.direction==='BUY_BIAS'?'BUY_BIAS':x.direction==='RISK_BIAS'?'SELL_BIAS':'NEUTRAL',score:x.score,outcome:'PENDING'}))}
