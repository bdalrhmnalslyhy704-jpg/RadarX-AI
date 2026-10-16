import test from 'node:test';
import assert from 'node:assert/strict';
import {createVerify,generateKeyPairSync} from 'node:crypto';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApiServer} from '../http/api.mjs';
import {DurableStore} from '../core/store.mjs';
import {FcmPushProvider} from '../push/index.mjs';

const TOKEN='TEST_FIXTURE_FCM_TOKEN_'.padEnd(160,'A');
const INSTALLATION_ID='2e65bf17-39f6-45b0-989a-2bf1235a144e';
function accountFixture(){
  const pair=generateKeyPairSync('rsa',{modulusLength:2048});
  return {
    serviceAccount:{
      project_id:'radarx-fixture-project',
      client_email:'radarx-push-fixture@radarx-fixture-project.iam.gserviceaccount.com',
      private_key:pair.privateKey.export({type:'pkcs8',format:'pem'})
    },
    publicKey:pair.publicKey
  };
}
function mockResponse(status,body){
  return{ok:status>=200&&status<300,status,json:async()=>body};
}
function fixturePushPayload(){
  return{type:'RADARX_RADAR_ALERT',event_class:'RADAR_ALERT',event:'EARLY_WAKE',
    radar:'EARLY_MOVE_RADAR',radar_name:'Radar 1 — Early-Wake',symbol:'BTCUSDT',
    title:'Radar 1 • BTCUSDT',detected_at:1700000000000,paper_trading:true,real_order_execution:false};
}

test('FCM provider signs a short-lived OAuth assertion and sends high-priority, paper-only notification',async()=>{
  const {serviceAccount,publicKey}=accountFixture(),calls=[];
  const fetchImpl=async(url,options)=>{
    calls.push({url:String(url),options});
    if(String(url)==='https://oauth2.googleapis.com/token'){
      const params=new URLSearchParams(options.body),jwt=params.get('assertion');
      assert.equal(params.get('grant_type'),'urn:ietf:params:oauth:grant-type:jwt-bearer');
      const parts=jwt.split('.');assert.equal(parts.length,3);
      const claims=JSON.parse(Buffer.from(parts[1],'base64url').toString('utf8'));
      assert.equal(claims.iss,serviceAccount.client_email);
      assert.equal(claims.scope,'https://www.googleapis.com/auth/firebase.messaging');
      const verifier=createVerify('RSA-SHA256');verifier.update(parts[0]+'.'+parts[1]);verifier.end();
      assert.equal(verifier.verify(publicKey,Buffer.from(parts[2],'base64url')),true);
      return mockResponse(200,{access_token:'TEST_FIXTURE_ACCESS_TOKEN',expires_in:3600});
    }
    assert.equal(String(url),'https://fcm.googleapis.com/v1/projects/radarx-fixture-project/messages:send');
    assert.equal(options.headers.authorization,'Bearer TEST_FIXTURE_ACCESS_TOKEN');
    const body=JSON.parse(options.body);
    assert.equal(body.message.token,TOKEN);
    assert.equal(body.message.notification,undefined,'native data-only messages must be handled by our service in foreground and background');
    assert.equal(body.message.data.title,'Radar 1 • BTCUSDT');
    assert.equal(body.message.data.body,'BTCUSDT • EARLY_WAKE');
    assert.equal(body.message.android.priority,'HIGH');
    assert.equal(body.message.android.ttl,'30s');
    assert.equal(body.message.data.paper_trading,'true');
    assert.equal(body.message.data.real_order_execution,'false');
    assert.equal(body.message.data.confidence_score,'UNKNOWN');
    return mockResponse(200,{name:'projects/radarx-fixture-project/messages/fixture-id'});
  };
  const provider=new FcmPushProvider({projectId:serviceAccount.project_id,serviceAccountJson:JSON.stringify(serviceAccount),fetchImpl,clock:()=>1700000000000});
  assert.deepEqual(provider.status(),{provider:'fcm',enabled:true});
  const sub={provider:'fcm',fcm_token:TOKEN};
  const first=await provider.send(sub,fixturePushPayload());
  const second=await provider.send(sub,fixturePushPayload());
  assert.equal(first.status,'SENT');assert.equal(first.messageId,'projects/radarx-fixture-project/messages/fixture-id');
  assert.equal(second.status,'SENT');
  assert.equal(calls.filter(x=>x.url==='https://oauth2.googleapis.com/token').length,1,'OAuth token should be cached');
  assert.equal(calls.filter(x=>x.url.includes('messages:send')).length,2);
});

test('FCM provider fails closed when credentials are absent',async()=>{
  const provider=new FcmPushProvider({projectId:'',serviceAccountJson:''});
  assert.deepEqual(provider.status(),{provider:'fcm',enabled:false});
  const result=await provider.send({provider:'fcm',fcm_token:TOKEN},fixturePushPayload());
  assert.equal(result.status,'DISABLED');
  assert.equal(result.reason,'FCM_CONFIGURATION_MISSING');
});

test('FCM provider marks only an explicitly UNREGISTERED device token as gone',async()=>{
  const {serviceAccount}=accountFixture();
  const fetchImpl=async url=>String(url)==='https://oauth2.googleapis.com/token'
    ?mockResponse(200,{access_token:'TEST_FIXTURE_ACCESS_TOKEN',expires_in:3600})
    :mockResponse(404,{error:{status:'NOT_FOUND',details:[{'@type':'type.googleapis.com/google.firebase.fcm.v1.FcmError',errorCode:'UNREGISTERED'}]}});
  const provider=new FcmPushProvider({projectId:serviceAccount.project_id,serviceAccountJson:serviceAccount,fetchImpl,clock:()=>1700000000000});
  const result=await provider.send({provider:'fcm',fcm_token:TOKEN},fixturePushPayload());
  assert.equal(result.status,'GONE');
  assert.equal(result.reason,'FCM_TOKEN_UNREGISTERED');
});

test('native device registration stores the FCM token privately and supports uninstall cleanup',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'radarx-fcm-device-'));
  const store=await new DurableStore({dir}).init();
  const config={
    environment:'production',push:{provider:'fcm'},
    auth:{secret:'',allowedOrigins:[]},
    api:{maxBodyBytes:65536,rateLimitPerMinute:100},
    symbols:['BTCUSDT'],timeframes:['15m','1h','4h']
  };
  const provider={status:()=>({provider:'fcm',enabled:true})};
  const monitor={health:()=>({running:true})};
  const server=createApiServer({config,store,monitor,pushProvider:provider});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+server.address().port;
  try{
    const registered=await fetch(base+'/api/push/device/register',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({installation_id:INSTALLATION_ID,token:TOKEN,notifications_enabled:true})});
    assert.equal(registered.status,201);
    const publicBody=await registered.json();
    assert.equal(publicBody.ok,true);assert.equal(publicBody.provider,'fcm');
    assert.equal(JSON.stringify(publicBody).includes(TOKEN),false,'FCM send token must never be returned');
    const row=await store.getFcmDevice(INSTALLATION_ID);
    assert.equal(row.fcm_token,TOKEN);assert.equal(row.user_id,'android:'+INSTALLATION_ID);
    assert.equal(row.provider,'fcm');
    const denied=await fetch(base+'/api/push/device/register',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({installation_id:'5ce8df33-b6fb-45fd-86b9-30ca8ff8deef',token:TOKEN,notifications_enabled:false})});
    assert.equal(denied.status,403);
    const removed=await fetch(base+'/api/push/device/'+INSTALLATION_ID,{method:'DELETE'});
    assert.equal(removed.status,200);assert.equal((await removed.json()).deleted,true);
    assert.equal(await store.getFcmDevice(INSTALLATION_ID),null);
  }finally{
    await new Promise(resolve=>server.close(resolve));
  }
});

test('native FCM registration rejects invalid installation IDs and malformed token values',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'radarx-fcm-invalid-'));
  const store=await new DurableStore({dir}).init();
  const config={environment:'production',push:{provider:'fcm'},auth:{secret:'',allowedOrigins:[]},
    api:{maxBodyBytes:65536,rateLimitPerMinute:100},symbols:['BTCUSDT'],timeframes:['15m','1h','4h']};
  const provider={status:()=>({provider:'fcm',enabled:true})};
  const server=createApiServer({config,store,monitor:{health:()=>({running:true})},pushProvider:provider});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+server.address().port;
  try{
    const badId=await fetch(base+'/api/push/device/register',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({installation_id:'not-a-uuid',token:TOKEN,notifications_enabled:true})});
    assert.equal(badId.status,400);assert.equal((await badId.json()).error,'INVALID_INSTALLATION_ID');
    const badToken=await fetch(base+'/api/push/device/register',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({installation_id:INSTALLATION_ID,token:'short',notifications_enabled:true})});
    assert.equal(badToken.status,400);assert.equal((await badToken.json()).error,'INVALID_FCM_TOKEN');
    assert.equal((await store.getSubscriptions()).length,0);
  }finally{
    await new Promise(resolve=>server.close(resolve));
  }
});


test('FCM provider accepts a base64-encoded Firebase service-account file',()=>{
  const {serviceAccount}=accountFixture();
  const encoded=Buffer.from(JSON.stringify(serviceAccount),'utf8').toString('base64');
  const provider=new FcmPushProvider({projectId:'',serviceAccountJson:encoded,fetchImpl:async()=>mockResponse(200,{})});
  assert.deepEqual(provider.status(),{provider:'fcm',enabled:true});
});

test('FCM provider still fails closed for malformed or incomplete base64 service-account data',()=>{
  assert.deepEqual(new FcmPushProvider({projectId:'fixture-project',serviceAccountJson:Buffer.from('{}').toString('base64')}).status(),{provider:'fcm',enabled:false});
  assert.deepEqual(new FcmPushProvider({projectId:'fixture-project',serviceAccountJson:'not-base64-json'}).status(),{provider:'fcm',enabled:false});
});

test('FCM data-only payload carries shared lifecycle state and uses the lifecycle label in notification copy',async()=>{
  const {serviceAccount}=accountFixture();
  let sent=null;
  const fetchImpl=async url=>{
    if(String(url)==='https://oauth2.googleapis.com/token')return mockResponse(200,{access_token:'TEST_FIXTURE_ACCESS_TOKEN',expires_in:3600});
    sent=JSON.parse(arguments[1]?.body||'{}');
    return mockResponse(200,{name:'projects/radarx-fixture-project/messages/lifecycle-id'});
  };
  const saferFetch=async(url,options)=>{
    if(String(url)==='https://oauth2.googleapis.com/token')return mockResponse(200,{access_token:'TEST_FIXTURE_ACCESS_TOKEN',expires_in:3600});
    sent=JSON.parse(options.body);
    return mockResponse(200,{name:'projects/radarx-fixture-project/messages/lifecycle-id'});
  };
  const provider=new FcmPushProvider({projectId:serviceAccount.project_id,serviceAccountJson:JSON.stringify(serviceAccount),fetchImpl:saferFetch,clock:()=>1700000000000});
  const result=await provider.send({provider:'fcm',fcm_token:TOKEN},{
    type:'RADARX_RADAR_ALERT',event_class:'RADAR_ALERT',event:'RADAR_ALERT',symbol:'EARLYUSDT',
    title:'Radar 8 • EARLYUSDT',message:'EARLYUSDT • إعداد مبكر',
    signal_lifecycle_state:'EARLY_SETUP',signal_lifecycle_label:'إعداد مبكر',
    signal_lifecycle_transition:'EARLY_EVIDENCE_CONVERGED',
    signal_lifecycle_reason_codes:['RELATED_EARLY_EVIDENCE'],
    paper_trading:true,real_order_execution:false
  });
  assert.equal(result.status,'SENT');
  assert.equal(sent.message.data.signal_lifecycle_state,'EARLY_SETUP');
  assert.equal(sent.message.data.signal_lifecycle_label,'إعداد مبكر');
  assert.equal(sent.message.data.signal_lifecycle_transition,'EARLY_EVIDENCE_CONVERGED');
  assert.equal(sent.message.data.signal_lifecycle_reason_codes,'RELATED_EARLY_EVIDENCE');
  assert.equal(sent.message.data.body,'EARLYUSDT • إعداد مبكر');
  assert.equal(sent.message.data.real_order_execution,'false');
});

