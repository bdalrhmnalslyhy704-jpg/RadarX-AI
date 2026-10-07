test('TEST_FIXTURE: independent radar status/control and unified alerts preserve radar source/time',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'radarx-independent-radar-api-')),store=await new DurableStore({dir}).init();
  const makeRadar=(id,name)=>({
    running:false,
    async start(){this.running=true;},
    async stop(){this.running=false;},
    health(){return{running:this.running,radar:id,radar_name:name,closed_candles_only:true};}
  });
  const early=makeRadar('EARLY_MOVE_RADAR','Radar 1 — Early-Wake');
  const strong=makeRadar('STRONG_MOVE_RADAR','Radar 2 — Strong-Move');
  const rotation=makeRadar('ROTATION_LAG_RADAR','Radar 3 — Rotation/Lag');
  const r4=makeRadar('LIQUIDITY_ABSORPTION_RADAR','Radar 4 — Liquidity Absorption');
  const r5=makeRadar('KAHIR_RADAR','Radar 5 — القاهر');
  await store.appendMoveAlert({id:'R1',radar:'EARLY_MOVE_RADAR',symbol:'R1USDT',processed_at:Date.now()-1000,detected_at:Date.now()-1000,price:1});
  await store.appendLiquidityAbsorptionAlert({id:'R4',radar:'LIQUIDITY_ABSORPTION_RADAR',radar_name:'Radar 4 — Liquidity Absorption',symbol:'R4USDT',processed_at:Date.now(),detected_at:Date.now(),price:2});
  const server=createApiServer({config:{auth:{secret:'TEST_FIXTURE_AUTH_SECRET',allowedOrigins:[]},api:{maxBodyBytes:65536,rateLimitPerMinute:100}},store,
    monitor:{health:()=>({database:{state:'LIVE'},websocket:{state:'LIVE'},rest:{state:'LIVE'}})},
    pushProvider:new NoopPushProvider(),moveSentinel:early,strongMoveRadar:strong,rotationLagRadar:rotation,liquidityAbsorptionRadar:r4,kahirRadar:r5});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+server.address().port;
  const status=await (await fetch(base+'/api/radar-status')).json();
  assert.equal(status.radars.length,7);assert.equal(status.radars.every(x=>x.running===false),true);
  assert.equal(status.radars.at(5).radar_name,'Radar 6 — يوم القيامة');
  const start=await (await fetch(base+'/api/radar-control?radar=LIQUIDITY_ABSORPTION_RADAR&action=start',{method:'POST'})).json();
  assert.equal(start.running,true);assert.equal(early.running,false);assert.equal(strong.running,false);assert.equal(rotation.running,false);assert.equal(r4.running,true);
  const alerts=await (await fetch(base+'/api/radar-alerts?radar=ALL&limit=10')).json();
  assert.equal(alerts.meta.time_format,'12h');assert.equal(alerts.meta.detected_timezone,'Asia/Aden');
  assert.equal(alerts.alerts[0].radar_name,'Radar 4 — Liquidity Absorption');
  assert.equal('detected_time_12h' in alerts.alerts[0],true);
  const stop=await (await fetch(base+'/api/radar-control?radar=LIQUIDITY_ABSORPTION_RADAR&action=stop',{method:'POST'})).json();
  assert.equal(stop.running,false);assert.equal(r4.running,false);
  const startViaGet=await (await fetch(base+'/api/radar-control?radar=LIQUIDITY_ABSORPTION_RADAR&action=start')).json();
  assert.equal(startViaGet.running,true);assert.equal(r4.running,true);
  const stopViaGet=await (await fetch(base+'/api/radar-control?radar=LIQUIDITY_ABSORPTION_RADAR&action=stop')).json();
  assert.equal(stopViaGet.running,false);assert.equal(r4.running,false);
  await new Promise(resolve=>server.close(resolve));
});


test('TEST_FIXTURE: Professor route exposes fused live intelligence and is independently controllable',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'radarx-professor-api-')),store=await new DurableStore({dir}).init(); let ticked=0;
  await store.appendProfessorAlert({id:'P1',radar:'PROFESSOR_RADAR',radar_name:'البروفيسور — استخبارات عامة',symbol:'BTCUSDT',processed_at:Date.now(),detected_at:Date.now()});
  const professor={
    health:()=>({running:true,busy:false,last_scan_at:Date.now(),radar:'PROFESSOR_RADAR',radar_name:'البروفيسور — استخبارات عامة'}),
    tick:async()=>{ticked++;},
    snapshot:()=>({radar:'PROFESSOR_RADAR',radar_name:'البروفيسور — استخبارات عامة',as_of:new Date().toISOString(),universe:{eligible_spot_symbols:100,mentioned_symbols:2,deep_scanned:2},streams:{count:3,live_count:2,source_status:'LIVE',items:[]},news:{count:8,source_status:'LIVE',items:[]},candidates:[],meta:{live:true,paper_trading:true,real_order_execution:false,confidence_score:'UNKNOWN'}})
  };
  const server=createApiServer({config:{auth:{secret:'TEST_FIXTURE_AUTH_SECRET',allowedOrigins:[]},api:{maxBodyBytes:65536,rateLimitPerMinute:100}},store,
    monitor:{health:()=>({database:{state:'LIVE'},websocket:{state:'LIVE'},rest:{state:'LIVE'}})},pushProvider:new NoopPushProvider(),professorRadar:professor});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const status=await (await fetch('http://127.0.0.1:'+server.address().port+'/api/radar-status')).json();
    assert.equal(status.radars.length,8);assert.equal(status.radars.at(-1).radar_name,'البروفيسور — استخبارات عامة');
    const res=await fetch('http://127.0.0.1:'+server.address().port+'/api/professor-radar?scan=1&limit=10');
    assert.equal(res.status,200);const body=await res.json();assert.equal(ticked,1);assert.equal(body.meta.radar,'PROFESSOR_RADAR');assert.equal(body.alerts.length,1);assert.equal(body.alerts[0].radar_name,'البروفيسور — استخبارات عامة');
    assert.equal(body.meta.real_order_execution,false);
  }finally{await new Promise(resolve=>server.close(resolve));}
});