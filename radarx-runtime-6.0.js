/* RadarX Runtime/Data Governor 6.0
   One client-side request broker for every REST JSON call.
   Goals: dedupe identical requests, cap concurrency, short-lived cache,
   adaptive mobile limits, stale-safe failure handling, and diagnostics.
*/
(function(){
  'use strict';
  if(window.RadarXRuntime && window.RadarXRuntime.version) return;

  var isMobile=/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent||'');
  var LIMIT=isMobile?2:6;
  var queue=[],active=0,inflight=new Map(),cache=new Map(),stats={queued:0,started:0,ok:0,failed:0,coalesced:0,cacheHits:0,rateLimited:0,lastError:'',lastLatency:0};
  var CACHE_TTL=Object.freeze({
    ticker:3500, tickerPrice:2500, exchangeInfo:300000, klines:2200, depth:900, trades:900, health:5000, market:5000, default:2500
  });

  function now(){return Date.now();}
  function keyOf(url){
    try{
      var u=new URL(url,location.href);
      if(u.origin!==location.origin || !u.pathname.startsWith('/api/')) return u.toString();
      ['ts','fresh','nocache','_'].forEach(function(k){u.searchParams.delete(k);});
      return u.pathname+(u.search?u.search:'');
    }catch(_){return String(url);}
  }
  function ttlOf(url){
    var p=String(url);
    if(/ticker\/24hr|ticker\/price/.test(p)) return p.indexOf('/price')>=0?CACHE_TTL.tickerPrice:CACHE_TTL.ticker;
    if(/exchangeInfo/.test(p)) return CACHE_TTL.exchangeInfo;
    if(/klines|uiKlines/.test(p)) return CACHE_TTL.klines;
    if(/depth/.test(p)) return CACHE_TTL.depth;
    if(/aggTrades|\/trades/.test(p)) return CACHE_TTL.trades;
    if(/\/api\/(health|market)/.test(p)) return /health/.test(p)?CACHE_TTL.health:CACHE_TTL.market;
    if(/radarx-news/.test(p)) return CACHE_TTL.news;
    if(/radarx-onchain/.test(p)) return CACHE_TTL.onchain;
    if(/radarx-social/.test(p)) return CACHE_TTL.social;
    if(/radarx-context/.test(p)) return CACHE_TTL.context;
    if(/\/api\/metals/.test(p)) return CACHE_TTL.metals;
    return CACHE_TTL.default;
  }
  function clone(v){
    if(v==null || typeof v!=='object') return v;
    try{return JSON.parse(JSON.stringify(v));}catch(_){return v;}
  }
  function makeAbort(ms,outerSignal){
    var c=new AbortController(),timer=setTimeout(function(){c.abort();},Math.max(1000,ms||8000));
    var off=null;
    if(outerSignal){
      if(outerSignal.aborted)c.abort();
      else{off=function(){try{c.abort();}catch(_){};};outerSignal.addEventListener('abort',off,{once:true});}
    }
    return {signal:c.signal,clear:function(){clearTimeout(timer);if(off&&outerSignal)outerSignal.removeEventListener('abort',off);}};
  }
  function pump(){
    while(active<LIMIT && queue.length){
      var job=queue.shift(); active++; job.run().finally(function(){active--;pump();});
    }
  }
  function enqueue(run){
    return new Promise(function(resolve,reject){
      queue.push({run:function(){return run().then(resolve,reject);}});
      stats.queued++; pump();
    });
  }
  async function requestJSON(url,opts){
    opts=opts||{};
    var target=String(url||'');
    var timeout=Number(opts.timeout)||6500;
    var retries=Math.max(0,Number(opts.retries)||0);
    var backoff=Number(opts.backoff)||350;
    var key=keyOf(target),ttl=ttlOf(target);
    var cached=cache.get(key);
    if(cached && now()-cached.ts<=ttl){stats.cacheHits++;return clone(cached.data);}
    if(inflight.has(key)){stats.coalesced++;return clone(await inflight.get(key));}

    var promise=enqueue(async function(){
      stats.started++;
      var last=null;
      for(var attempt=0;attempt<=retries;attempt++){
        if(navigator.onLine===false) throw new Error('OFFLINE');
        var started=performance.now(),ctrl=makeAbort(timeout,opts.signal);
        try{
          var init=Object.assign({method:'GET',headers:{Accept:'application/json'},credentials:'omit',cache:'no-store',redirect:'follow'},opts.init||{});
          init.signal=ctrl.signal;
          var r=await fetch(target,init);
          var raw=await r.text(),data=null;
          try{data=raw?JSON.parse(raw):null;}catch(_){throw new Error('INVALID_JSON');}
          if(!r.ok){
            if(r.status===429) stats.rateLimited++;
            throw new Error('HTTP '+r.status);
          }
          stats.ok++; stats.lastLatency=Math.round(performance.now()-started); stats.lastError='';
          cache.set(key,{ts:now(),data:clone(data),ttl:ttl});
          if(cache.size>240){
            var oldest=Array.from(cache.entries()).sort(function(a,b){return a[1].ts-b[1].ts;}).slice(0,60);
            oldest.forEach(function(x){cache.delete(x[0]);});
          }
          return clone(data);
        }catch(e){
          last=e;stats.failed++;stats.lastError=String(e&&e.message||e);
          if(attempt<retries) await new Promise(function(r){setTimeout(r,backoff*Math.pow(2,attempt));});
        }finally{ctrl.clear();}
      }
      var stale=cache.get(key);
      if(stale && now()-stale.ts<=Math.max(12000,ttl*8)) return clone(stale.data);
      throw last||new Error('API_UNAVAILABLE');
    });
    inflight.set(key,promise);
    try{return await promise;}finally{inflight.delete(key);}
  }

  window.RadarXRuntime={
    version:'6.0.0',
    requestJSON:requestJSON,
    getStats:function(){return Object.assign({},stats,{active:active,queued:queue.length,cache:cache.size,concurrency:LIMIT,mobile:isMobile});},
    clearCache:function(){cache.clear();},
    isBusy:function(){return active>0||queue.length>0;},
    flush:function(){queue.length=0;}
  };
})();