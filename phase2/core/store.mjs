import {mkdir,readFile,writeFile,rename,appendFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash,randomUUID,timingSafeEqual} from 'node:crypto';

const hashToken=value=>createHash('sha256').update(String(value)).digest('hex');
const tokenMatches=(value,expectedHash)=>{try{const a=Buffer.from(hashToken(value),'hex'),b=Buffer.from(String(expectedHash||''),'hex');return a.length===b.length&&timingSafeEqual(a,b);}catch{return false;}};
const defaultStagingPushValidation=()=>({status:'NOT_VALIDATED',updated_at:null,subscription_id:null,test_event_id:null,validated_at:null,pending:null,acknowledgment:null});

export class DurableStore {
  constructor({dir='./.radarx-data'}={}){this.dir=dir;this.queue=Promise.resolve();this.ready=false;this.lastWriteAt=null;
    this.files={subscriptions:join(dir,'subscriptions.json'),settings:join(dir,'settings.json'),dedup:join(dir,'dedup.json'),
      signals:join(dir,'signals.jsonl'),notifications:join(dir,'notifications.jsonl'),stagingPushValidation:join(dir,'staging_push_validation_status.json')};}
  async init(){await mkdir(this.dir,{recursive:true});
    for(const [k,p] of Object.entries(this.files)){try{await readFile(p,'utf8');}catch{
      await writeFile(p,p.endsWith('.jsonl')?'':'{}',{flag:'wx'}).catch(()=>{});
    }}this.ready=true;return this;}
  async lock(fn){const p=this.queue.then(fn);this.queue=p.catch(()=>{});return p;}
  async readJson(p){try{return JSON.parse(await readFile(p,'utf8'));}catch{return{};}}
  async writeJson(p,v){const t=p+'.tmp-'+process.pid+'-'+Date.now();await writeFile(t,JSON.stringify(v,null,2)+'\n');await rename(t,p);this.lastWriteAt=Date.now();}
  async getSubscriptions(userId=null){const a=await this.readJson(this.files.subscriptions);const r=Object.values(a);
    return userId?r.filter(x=>x.user_id===userId&&!x.disabled):r.filter(x=>!x.disabled);}
  async upsertSubscription(userId,s){return this.lock(async()=>{const a=await this.readJson(this.files.subscriptions);
    const old=Object.values(a).find(x=>x.user_id===userId&&x.endpoint===s.endpoint),id=old?.id||randomUUID();
    a[id]={id,user_id:userId,endpoint:String(s.endpoint),expirationTime:s.expirationTime??null,
      device_token:String(s?.device_token||old?.device_token||''),
      keys:{p256dh:String(s?.keys?.p256dh||''),auth:String(s?.keys?.auth||'')},disabled:false,
      created_at:old?.created_at||Date.now(),updated_at:Date.now()};await this.writeJson(this.files.subscriptions,a);return a[id];});}
  async deleteSubscription(userId,id){return this.lock(async()=>{const a=await this.readJson(this.files.subscriptions);
    if(!a[id]||a[id].user_id!==userId)return false;delete a[id];await this.writeJson(this.files.subscriptions,a);return true;});}
  async disableSubscription(id){return this.lock(async()=>{const a=await this.readJson(this.files.subscriptions);if(!a[id])return false;
    a[id].disabled=true;a[id].updated_at=Date.now();await this.writeJson(this.files.subscriptions,a);return true;});}
  async getUserSettings(userId){const a=await this.readJson(this.files.settings);return a[userId]||null;}
  async getStagingPushValidationStatus(){const a=await this.readJson(this.files.stagingPushValidation);return {...defaultStagingPushValidation(),...a,pending:a.pending?{test_event_id:a.pending.test_event_id,subscription_id:a.pending.subscription_id,user_id:a.pending.user_id,requested_at:a.pending.requested_at,delivery_status:a.pending.delivery_status,sent_at:a.pending.sent_at??null}:null,acknowledgment:a.acknowledgment?{audit_record_id:a.acknowledgment.audit_record_id,subscription_id:a.acknowledgment.subscription_id,test_event_id:a.acknowledgment.test_event_id,delivered_at:a.acknowledgment.delivered_at,acknowledged_at:a.acknowledgment.acknowledged_at}:null};}
  async createStagingPushValidationChallenge({userId,subscriptionId,testEventId,deviceToken,ackToken,requestedAt=Date.now()}){return this.lock(async()=>{const record={status:'NOT_VALIDATED',updated_at:requestedAt,subscription_id:null,test_event_id:null,validated_at:null,pending:{user_id:String(userId),subscription_id:String(subscriptionId),test_event_id:String(testEventId),requested_at:requestedAt,delivery_status:'PENDING',sent_at:null,device_token_hash:hashToken(deviceToken),ack_token_hash:hashToken(ackToken)},acknowledgment:null};await this.writeJson(this.files.stagingPushValidation,record);return this.getStagingPushValidationStatus();});}
  async recordStagingPushValidationDelivery({subscriptionId,testEventId,status,sentAt=Date.now()}){return this.lock(async()=>{const record={...defaultStagingPushValidation(),...await this.readJson(this.files.stagingPushValidation)},p=record.pending;if(!p||p.subscription_id!==String(subscriptionId)||p.test_event_id!==String(testEventId))return this.getStagingPushValidationStatus();p.delivery_status=String(status);if(String(status)==='SENT')p.sent_at=sentAt;record.updated_at=Date.now();await this.writeJson(this.files.stagingPushValidation,record);return this.getStagingPushValidationStatus();});}
  async acknowledgeStagingPushValidation({subscriptionId,testEventId,deviceToken,ackToken,deliveredAt,now=Date.now()}){return this.lock(async()=>{const record={...defaultStagingPushValidation(),...await this.readJson(this.files.stagingPushValidation)},p=record.pending;if(record.status==='VALIDATED')return{accepted:false,reason:'ALREADY_VALIDATED',status:'VALIDATED',validation:await this.getStagingPushValidationStatus()};if(!p)return{accepted:false,reason:'NO_PENDING_TEST',status:'NOT_VALIDATED',validation:await this.getStagingPushValidationStatus()};if(p.subscription_id!==String(subscriptionId)||p.test_event_id!==String(testEventId))return{accepted:false,reason:'VALIDATION_BINDING_MISMATCH',status:'NOT_VALIDATED'};if(String(p.delivery_status)!=='SENT')return{accepted:false,reason:'TEST_PUSH_NOT_SENT',status:'NOT_VALIDATED'};if(!tokenMatches(deviceToken,p.device_token_hash)||!tokenMatches(ackToken,p.ack_token_hash))return{accepted:false,reason:'VALIDATION_TOKEN_MISMATCH',status:'NOT_VALIDATED'};const t=Number(deliveredAt);if(!Number.isFinite(t)||t>now+30000||t<now-10*60*1000)return{accepted:false,reason:'DELIVERED_AT_INVALID',status:'NOT_VALIDATED'};const active=await this.getSubscriptions(String(p.user_id));if(!active.some(x=>x.id===String(subscriptionId)))return{accepted:false,reason:'SUBSCRIPTION_NOT_ACTIVE',status:'NOT_VALIDATED'};const auditRecordId=randomUUID();record.status='VALIDATED';record.updated_at=now;record.subscription_id=String(subscriptionId);record.test_event_id=String(testEventId);record.validated_at=now;record.pending=null;record.acknowledgment={audit_record_id:auditRecordId,subscription_id:String(subscriptionId),test_event_id:String(testEventId),delivered_at:t,acknowledged_at:now,user_id:String(p.user_id),device_token_hash:p.device_token_hash};await this.writeJson(this.files.stagingPushValidation,record);return{accepted:true,reason:'VALIDATED',status:'VALIDATED',audit_record_id:auditRecordId,validation:await this.getStagingPushValidationStatus(),user_id:String(p.user_id)};});}
  async putUserSettings(userId,s){return this.lock(async()=>{const a=await this.readJson(this.files.settings);a[userId]={...s,user_id:userId,updated_at:Date.now()};
    await this.writeJson(this.files.settings,a);return a[userId];});}
  async getDedupKey(k){const a=await this.readJson(this.files.dedup);return a[k]||null;}
  async putDedupKey(k,v){return this.lock(async()=>{const a=await this.readJson(this.files.dedup);a[k]=v;await this.writeJson(this.files.dedup,a);});}
  async appendSignalAudit(v){return this.lock(async()=>{await appendFile(this.files.signals,JSON.stringify(v)+'\n');this.lastWriteAt=Date.now();});}
  async appendNotificationAudit(v){return this.lock(async()=>{await appendFile(this.files.notifications,JSON.stringify(v)+'\n');this.lastWriteAt=Date.now();});}
  async readRecent(kind,limit=100){let s='';try{s=await readFile(this.files[kind],'utf8');}catch{return[];}
    return s.split('\n').filter(Boolean).slice(-limit).reverse().map(x=>JSON.parse(x));}
  async health(){try{await mkdir(this.dir,{recursive:true});return{state:this.ready?'LIVE':'INIT',path:this.dir,last_write_at:this.lastWriteAt};}
    catch(e){return{state:'ERROR',path:this.dir,error:String(e?.message??e),last_write_at:this.lastWriteAt};}}
  static publicSubscription(s){return{id:s.id,endpoint:s.endpoint,expirationTime:s.expirationTime,created_at:s.created_at,updated_at:s.updated_at,disabled:Boolean(s.disabled)};}
}
