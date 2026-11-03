import {Database} from 'bun:sqlite';
import {generateKeyPairSync,randomBytes,randomUUID,sign} from 'node:crypto';
import {CommunityRegistry} from '../../cloud/screen-community/src/registry';
import {CommunityAccessRegistry} from '../../cloud/screen-community/src/accessRegistry';
import {DurableRegistryStore} from '../../cloud/screen-community/src/store';
import {keyString,REQUEST_DOMAIN,verifyEnvelope} from '../../cloud/screen-community/src/protocol';
import {ACCESS_REQUEST_DOMAIN,verifyAccessEnvelope,type AccessOperation,type AccessPlan} from '../../cloud/screen-community/src/accessProtocol';
import {safetyPolicyDigest,SAFETY_RESULT_DOMAIN,type SafetySnapshot} from '../../cloud/screen-community/src/screenSafety';
export const safetyKey=()=>generateKeyPairSync('ec',{namedCurve:'prime256v1'});
export const safetyPerson=(name:string)=>({name,device:randomUUID(),host:safetyKey(),bio:safetyKey(),op:safetyKey(),ram:safetyKey(),enrollment:null as string|null,useId:null as string|null,observation:0});
export type SafetyPerson=ReturnType<typeof safetyPerson>;
export function screenSafetyFixture(){
 let now=1_800_000_000_000,pushReady=true,pollObservation=0;
 const db=new Database(':memory:'),store=new DurableRegistryStore({sql:{exec:(sql:string,...args:unknown[])=>db.query(sql).all(...args as never[]) as never},transactionSync:<T>(fn:()=>T)=>db.transaction(fn)()});
 const issuer=safetyKey(),issuerPublic=keyString(issuer.publicKey),stateKey=randomBytes(32),profile=randomUUID(),root=safetyPerson('Root'),host=safetyPerson('Mac / 수신'),mobile=safetyPerson('iPad / 관리'),topic='com.example.safety.mobile';
 const signature=(bytes:Buffer,key:ReturnType<typeof safetyKey>['privateKey'],domain:Buffer)=>sign('sha256',Buffer.concat([domain,bytes]),{key,dsaEncoding:'ieee-p1363'}).toString('base64url');
 const boot=Buffer.from(JSON.stringify([1,'bootstrap',randomUUID(),now,randomBytes(32).toString('base64url'),null,[profile,root.device,root.name,keyString(root.host.publicKey),keyString(root.bio.publicKey),'none','Fixture']]));
 const legacy=new CommunityRegistry(store,issuer.privateKey,stateKey,()=>now,()=>true,[topic]);
 const bootstrap=verifyEnvelope(legacy.handle({payload:boot.toString('base64url'),signature:signature(boot,root.bio.privateKey,REQUEST_DOMAIN),hostSignature:signature(boot,root.host.privateKey,REQUEST_DOMAIN)},'fixture').envelope,issuerPublic);
 const cid=bootstrap[4] as string;root.enrollment=bootstrap[6] as string;
 const service=()=>new CommunityAccessRegistry(store,issuer.privateKey,issuerPublic,stateKey,()=>now,[topic],pushReady);
 const request=(op:AccessOperation,args:unknown[],person:SafetyPerson=root,role:'host'|'bio'|'op'|'ram'='host',actor=person.enrollment)=>{
   const bytes=Buffer.from(JSON.stringify([2,op,randomUUID(),now,randomBytes(32).toString('base64url'),actor,args]));return {payload:bytes.toString('base64url'),signature:signature(bytes,person[role].privateKey,ACCESS_REQUEST_DOMAIN)};
 };
 const run=(envelope:ReturnType<typeof request>)=>{const response=service().handle(envelope,'fixture'),fields=verifyAccessEnvelope(response.envelope,issuerPublic);return {envelope:response.envelope,kind:fields[1] as string,value:fields[4] as any};};
 const call=(op:AccessOperation,args:unknown[],person:SafetyPerson=root,role:'host'|'bio'|'op'|'ram'='host',actor=person.enrollment)=>run(request(op,args,person,role,actor));
 const enroll=(who:SafetyPerson,caps:AccessPlan['capabilities'],mobileKind=true,admin=false)=>{
   const plan:AccessPlan={version:1,profileId:profile,deviceId:who.device,name:who.name,kind:mobileKind?'mobile':'desktop',hostKey:keyString(who.host.publicKey),biometricKey:keyString(who.bio.publicKey),operationKey:keyString(who.op.publicKey),controlKey:null,agentDeviceId:null,capabilities:caps};
   const pending=call('prepare',[plan],who,'host',null).value;
   const review=call(admin?'review-management':'review',admin?[cid,pending.planId,true]:[cid,pending.planId]).value;
   const result=call(admin?'approve-management':'approve',[cid,review.planId,review.digest,review.challenge,review.revision,...(admin?[review.management.digest]:[])],root,'bio');
   if(result.kind!=='authorization')throw Error(JSON.stringify(result.value));who.enrollment=result.value.enrollmentId;return result;
 };
 const hostGrant=enroll(host,['screen.receive.view'],false),mobileGrant=enroll(mobile,['screen.view'],true,true);
 const authorization=(who:SafetyPerson)=>call('authorization',[cid],who,'op').value;
 const observe=(who:SafetyPerson,subscription:unknown,sequence=++who.observation)=>({sequence,policyDigest:safetyPolicyDigest(authorization(who)),keyEpoch:authorization(who).keyEpoch});
 const subscribe=(who=mobile,token='ab'.repeat(32))=>call('screen-safety-subscribe',[cid,{token,environment:'sandbox',topic},observe(who,{})],who,'op');
 const remove=(who=mobile)=>call('screen-safety-subscribe',[cid,null,observe(who,null)],who,'op');
 const openUse=(who=mobile)=>{who.ram=safetyKey();const reply=call('session-open',[cid,keyString(who.ram.publicKey),['screen.view']],who,'bio');who.useId=reply.value.sessionId;return reply;};
 const activation=randomUUID(),snapshot={power:'on' as const,held:false,session:null as SafetySnapshot['session']};
 const pollRequest=(results:unknown[]=[],cursor=0,id=activation,state:Omit<SafetySnapshot,'observationSequence'>=snapshot)=>request('receiver-safety-poll',[cid,id,cursor,results,{...state,observationSequence:++pollObservation}],host);
 const poll=(results:unknown[]=[],cursor=0,id=activation,state:Omit<SafetySnapshot,'observationSequence'>=snapshot)=>run(pollRequest(results,cursor,id,state));
 const stopRequest=(action:'end'|'turnOff'|'revoke'='turnOff',target:string|null=null,channel:string|null=null,id=activation,who=mobile)=>request('screen-safety-stop',[cid,who.useId,host.enrollment,id,{action,targetEnrollmentId:target,expectedSessionId:channel}],who,'ram');
 const result=(id:string,outcome:string='turned-off',generation=activation)=>{const bytes=Buffer.from(JSON.stringify([1,cid,host.enrollment,generation,id,outcome,now]));return {payload:bytes.toString('base64url'),signature:signature(bytes,host.host.privateKey,SAFETY_RESULT_DOMAIN)};};
 return {db,store,issuer,issuerPublic,stateKey,profile,root,host,mobile,topic,cid,service,request,run,call,enroll,authorization,observe,subscribe,remove,openUse,activation,snapshot,poll,pollRequest,stopRequest,result,hostGrant,mobileGrant,now:()=>now,advance:(ms:number)=>{now+=ms;},pushConfigured:(value:boolean)=>{pushReady=value;}};
}
