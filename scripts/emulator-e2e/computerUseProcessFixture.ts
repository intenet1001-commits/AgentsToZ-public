/** J3A fixture child. This source is never part of the installed app. */
import {basename, join, resolve} from 'node:path';
import {realpathSync, existsSync, readFileSync, writeFileSync, appendFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {dlopen, FFIType} from 'bun:ffi';
import {generateKeyPairSync, sign} from 'node:crypto';
import {realHome} from './environment';

// Before importing any product host code or opening a socket, reject installed/compiled executables and real profiles.
const repo=resolve(import.meta.dir,'../..');
const args=process.argv.slice(2);
if(args.length!==1)throw Error('fixture requires one config path');
const configPath=realpathSync(args[0]!);
const systemHome=realHome(); // Directory Services resolves the real account, not the injected HOME.
const within=(path:string,base:string)=>path===base||path.startsWith(base+'/');
if(process.platform!=='darwin'||basename(realpathSync(process.execPath))!=='bun'||import.meta.path.includes('$bunfs')||
   !within(realpathSync(repo),systemHome+'/agentstoz-emulator')||existsSync(join(repo,'.git'))||
   !process.env.HOME||!process.env.APP_DATA_DIR||!within(configPath,realpathSync(process.env.HOME+'/..'))||
   within(realpathSync(process.env.HOME),systemHome)||within(realpathSync(process.env.APP_DATA_DIR),systemHome)||
   realpathSync(homedir())!==realpathSync(process.env.HOME))throw Error('fixture refused production or unisolated process');
const lib=dlopen('/usr/lib/libSystem.B.dylib',{sandbox_check:{args:[FFIType.i32,FFIType.ptr,FFIType.i32],returns:FFIType.i32}});
let sandboxed=false;try{sandboxed=lib.symbols.sandbox_check(process.pid,null,0)===1;}finally{lib.close();}
if(!sandboxed)throw Error('fixture requires kernel sandbox');
const config=JSON.parse(readFileSync(configPath,'utf8'));
if(!['a','b'].includes(config.role)||!/^http:\/\/127\.0\.0\.1:\d+$/.test(config.shim)||
   [3001,52741,4723].includes(Number(new URL(config.shim).port))||!Number.isInteger(config.port)||config.port<1024||
   [3001,52741,4723].includes(config.port)||!within(realpathSync(config.scratch),realpathSync(process.env.HOME+'/..')))throw Error('invalid fixture config');

const [{AgentDialogueHost},{createCommunityControlExecutor},{createComputerUseRemoteSidecar},{ComputerUseRuntime,computerUseRemoteSettingsMemory},
  {ComputerUseRecovery},{COMPUTER_USE_SCOPE_OPERATIONS,COMPUTER_USE_SCOPE_PERMISSIONS,COMPUTER_USE_SCOPE_LIMITS},{computerScopeApprovalBytes},
  {createClient}]=await Promise.all([
  import('../../src/agentDialogueHost'),import('../../src/agentDialogueControl'),import('../../src/computerUseRemoteSidecar'),import('../../src/computerUseRuntime'),
  import('../../src/computerUseRecovery'),import('../../src/computerUseScopeProtocol'),import('../../src/computerUseScopeApproval'),import('@supabase/supabase-js')]);
const dialogue=new AgentDialogueHost({appDataDir:process.env.APP_DATA_DIR,identity:()=>({profileId:config.profile,deviceId:config.device}),
  secret:async()=>config.device.replaceAll('-','').padEnd(44,'x'),resolveTarget:async()=>({kind:'ops',displayName:`Fixture ${config.role} / OPS`}),
  rpc:async(operation,profile,device,secret,args)=>{
    const client=createClient(config.shim,config.serviceKey,{auth:{persistSession:false,autoRefreshToken:false}});
    const {data,error}=await client.rpc('portmgr_agent_dialogue_call',{p_operation:operation,p_profile_id:profile,p_device_id:device,p_secret:secret,p_args:args}).abortSignal(AbortSignal.timeout(15000));
    const request=args.request as any;const wire=operation==='control-send'&&request?.kind==='computer-use'?{envelope:request.op,hasBox:typeof request.box==='string',containsSentinel:JSON.stringify(request).includes('j3a-click-0001')}:{};
    appendFileSync(join(config.scratch,'rpc.log'),JSON.stringify({operation,error:error?.message??null,...wire})+'\n');
    if(error)throw Error(error.message);return data;
  }});
const originalCall=dialogue.controlCall.bind(dialogue);dialogue.controlCall=async(...input)=>{try{return await originalCall(...input);}catch(error){appendFileSync(join(config.scratch,'rpc.log'),JSON.stringify({operation:'controlCall-throw',error:(error as Error).message,code:(error as any).code})+'\n');throw error;}};
const endpoint=await dialogue.enable({target:'ops'},true);await dialogue.uiCommunity({target:'ops'},'join');
const approvals:any[]=[];let grant:string|null=null;let snapshot=0;const keys=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),jwk=keys.publicKey.export({format:'jwk'});
const point=Buffer.concat([Buffer.from([4]),Buffer.from(jwk.x!,'base64url'),Buffer.from(jwk.y!,'base64url')]).toString('base64');
const owner={pid:912,start:'100001'};
const control={available:true,dispose(){},retire(){},async request(body:any):Promise<any>{
  appendFileSync(join(config.scratch,'control.jsonl'),JSON.stringify({operation:body.operation,requestId:body.requestId??null})+'\n');
  switch(body.operation){
    case 'status':return {success:true,protocolVersion:1,workerProtocol:2,backgroundOnly:true,accessibility:true,secureInput:false,operations:['capture','click']};
    case 'scope-status':return {success:true,scopeProtocolVersion:2,operations:[...COMPUTER_USE_SCOPE_OPERATIONS,'scope-standing-off'],accessibility:true,screenRecording:true,secureInput:false,owner,standing:{scope:{kind:'desktop'},since:1793400000000}};
    case 'scope-request-approval':approvals.push({...body,owner});return {success:true,state:'approved'};
    case 'scope-approval-status':{const r=approvals.find(v=>v.approvalId===body.approvalId);if(!r)return {success:true,state:'unknown'};
      const payload={version:2 as const,approvalId:r.approvalId,scope:r.scope,permissions:[...COMPUTER_USE_SCOPE_PERMISSIONS],caller:r.caller,owner:r.owner,issuedAt:Date.now(),expiresAt:r.expiresAt};
      return {success:true,state:'approved',approval:{...payload,signature:sign('sha256',computerScopeApprovalBytes(payload),keys.privateKey).toString('base64')},helperPublicKey:point};}
    case 'scope-open-grant':grant='b'.repeat(32);return {success:true,bound:true,grant,expiresAt:Date.now()+COMPUTER_USE_SCOPE_LIMITS.grantMs,scopeProtocolVersion:2,operations:[...COMPUTER_USE_SCOPE_OPERATIONS],scope:body.scope,permissions:[...COMPUTER_USE_SCOPE_PERMISSIONS]};
    case 'scope-observe':return {success:true,snapshotId:`snap-${++snapshot}`,scope:{kind:'desktop'},applications:[{id:'app_1',name:'Synthetic',bundleId:'com.example.fixture'}],displays:[{id:'display_1',originX:0,originY:0,width:100,height:100,scale:1,rotation:0}],foreground:{applicationId:'app_1',bundleId:'com.example.fixture',pid:123,processStart:'1000'}};
    case 'scope-capture':return {success:true,displayId:'display_1',mediaType:'image/jpeg',data:Buffer.concat([Buffer.from([0xff,0xd8]),Buffer.alloc(64),Buffer.from([0xff,0xd9])]).toString('base64'),width:100,height:100,displayWidth:100,displayHeight:100,originX:0,originY:0};
    case 'scope-click':return {success:true,receipt:{requestId:body.requestId,state:'confirmed'}};
    case 'scope-revoke':case 'scope-revoke-session':grant=null;return {success:true,revoked:true};
    default:return {success:false,code:'fixture-unimplemented',notDispatched:true};
  }
}};
const recovery=new ComputerUseRecovery(':memory:');let runtime:InstanceType<typeof ComputerUseRuntime>|null=null;
const remote=createComputerUseRemoteSidecar({dialogue,runtime:()=>runtime??=new ComputerUseRuntime(control,recovery,{acceptRemote:true,remoteSettings:computerUseRemoteSettingsMemory(),remoteHumanInput:async()=>null}),existingRuntime:()=>runtime,
  selfDeviceId:()=>config.device,deviceName:()=>`Fixture ${config.role}`,bundled:true,platform:'darwin'});
const executor=createCommunityControlExecutor({terminal:async()=>({}),workspace:async()=>({}),projects:async()=>({projects:[],opsTargetId:null,deviceName:'fixture'}),computerUse:remote.computerUse});
let running=true;const loop=(async()=>{while(running){await dialogue.controlPoll(executor,remote.pollOptions).catch(()=>{});await Bun.sleep(40);}})();
const server=Bun.serve({hostname:'127.0.0.1',port:config.port,fetch(req){
  if(new URL(req.url).pathname!=='/api/computer-use-agent/remote')return new Response('not found',{status:404});
  return remote.route(req,{authorized:req.headers.get('X-AgentsToZ-Control-Profile')===config.token,host:async()=> 'Terminal'});
}});
writeFileSync(join(config.scratch,'ready.json'),JSON.stringify({pid:process.pid,port:server.port,endpoint:endpoint.endpointId,device:config.device,sandboxed:true}),{mode:0o600});
process.on('SIGTERM',()=>{running=false;});
while(running)await Bun.sleep(50);
await loop;server.stop(true);await remote.dispose();runtime?.dispose();recovery.close();
