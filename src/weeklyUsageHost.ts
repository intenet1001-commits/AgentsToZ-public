import {closeSync,existsSync,fsyncSync,lstatSync,mkdirSync,openSync,renameSync,unlinkSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {withOwnedPortalFileLock} from './portalFileLock';
import {RELEASED_WEEKLY_USAGE_HOOK_SHA256,WEEKLY_USAGE_HOOK} from './weeklyUsageHook';
import {readLocalMetadataFile} from './localMetadataFile';
import {normalizeWeeklyUsageRequest,weeklyBuckets,type WeeklyUsage,type WeeklyUsageRequest} from './weeklyUsage';
type Provider='claude'|'agy';
export async function readWeeklyUsageRequest(request:Request):Promise<WeeklyUsageRequest>{
 const reader=request.body?.getReader();let size=0;const parts:Uint8Array[]=[];let timer:ReturnType<typeof setTimeout>|undefined;
 const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{void reader?.cancel().catch(()=>{});reject(Error('사용량 요청 수신 시간이 초과됐습니다.'));},2000);});
 try{if(reader)while(true){const part=await Promise.race([reader.read(),deadline]);if(part.done)break;size+=part.value.byteLength;if(size>1024){void reader.cancel();throw Error('사용량 요청이 너무 큽니다.');}parts.push(part.value);}
  return normalizeWeeklyUsageRequest(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(parts))));
 }finally{if(timer)clearTimeout(timer);reader?.releaseLock();}
}
const quote=(s:string)=>`'${s.replaceAll("'","'\\''")}'`;
function safeDir(path:string,privateDir=false){
 const s=lstatSync(path);if(!s.isDirectory()||s.isSymbolicLink()||process.platform!=='win32'&&(s.uid!==process.getuid?.()||s.mode&(privateDir?0o077:0o022)))throw Error('사용량 연결 폴더의 안전성을 확인하지 못했습니다.');
}
function read(path:string):string|null {
 let s;try{s=lstatSync(path);}catch(e:any){if(e.code==='ENOENT')return null;throw e;}
 safeDir(dirname(path));
 if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.size>65536||process.platform!=='win32'&&(s.uid!==process.getuid?.()||s.mode&0o022))throw Error('사용량 연결 설정이 안전한 일반 파일이 아닙니다.');
 const text=readLocalMetadataFile(path,65536);if(text===null)throw Error('사용량 연결 설정을 안전하게 읽지 못했습니다.');return text;
}
function atomic(path:string,text:string){
 const temp=path+'.'+randomUUID()+'.tmp';
 try{const fd=openSync(temp,'wx',0o600);try{writeFileSync(fd,text);fsyncSync(fd);}finally{closeSync(fd);}renameSync(temp,path);}finally{if(existsSync(temp))unlinkSync(temp);}
}
export class WeeklyUsageHost {
 readonly root:string;
 constructor(private readonly deps:{appDataDir:string;home:string;python:string|null;available:(provider:Provider)=>boolean;codex:()=>Promise<{rateLimits:unknown;checkedAt?:string;source?:string}>;
  /** 「휴대폰 알림」 (src/weeklyUsagePushHost.ts): every reading goes to it; absent where AgentsToZ Screen cannot exist. */
  alerts?:{observe(items:WeeklyUsage[]):Promise<unknown>;perform(request:Extract<WeeklyUsageRequest,{operation:'alerts'}>):Promise<unknown>}}){this.root=join(deps.appDataDir,'weekly-usage');}
 private settings(provider:Provider){return provider==='claude'?join(this.deps.home,'.claude','settings.json'):join(this.deps.home,'.gemini','antigravity-cli','settings.json');}
 private command(provider:Provider){return `${quote(this.deps.python??'python3')} -I ${quote(join(this.root,'statusline-v1.py'))} ${provider} ${quote(this.root)}`;}
 private previous(provider:Provider){
  if(!existsSync(this.root))return null;safeDir(this.root,true);const v=JSON.parse(read(join(this.root,provider+'-previous.json'))??'null');
  return v?.version===1&&Object.hasOwn(v,'statusLine')&&(v.statusLine===null||typeof v.statusLine==='object'&&!Array.isArray(v.statusLine))?v:null;
 }
 private owns(provider:Provider,command:unknown,previous:any){return typeof command==='string'&&(command===this.command(provider)||command===previous?.installedCommand);}
 private canConnect(provider:Provider){return process.platform!=='win32'&&!!this.deps.python&&this.deps.available(provider);}
 private local(provider:Provider):WeeklyUsage {
  let connected=false,buckets:WeeklyUsage['buckets']=[],checkedAt:string|null=null;
  try{const config=JSON.parse(read(this.settings(provider))??'{}');const previous=this.previous(provider);connected=!!previous&&this.owns(provider,config.statusLine?.command,previous);if(connected){safeDir(this.root,true);const v=JSON.parse(read(join(this.root,provider+'.json'))??'null');
   if(v?.version===1&&v.provider===provider&&typeof v.checkedAt==='string'&&Number.isFinite(Date.parse(v.checkedAt))&&Array.isArray(v.buckets)){
    buckets=v.buckets.slice(0,8).filter((b:any)=>b&&['주간','Gemini','Claude/GPT','추가 한도'].includes(b.label)&&typeof b.remainingPercent==='number'&&Number.isFinite(b.remainingPercent)&&b.remainingPercent>=0&&b.remainingPercent<=100&&(b.resetsAt===null||typeof b.resetsAt==='number'&&Number.isFinite(b.resetsAt))).map((b:any)=>({label:b.label,remainingPercent:b.remainingPercent,resetsAt:b.resetsAt}));checkedAt=v.checkedAt;
   }
  }}catch{/* A missing/unsafe snapshot is unknown, never 0 or 100. */}
  return {provider,buckets,checkedAt,source:buckets.length?'statusline':'unavailable',connected,canConnect:this.canConnect(provider)};
 }
 #hookChecked=false;
 /** An unmodified older app copy of the hook is replaced in place: same path, so the CLI setting is untouched. A file
  *  the app did not write (any other hash) is left alone; the next 「사용량 연결」 rewrites it. Once per process. */
 upgradeHook(){
  if(this.#hookChecked)return;
  try{
   const path=join(this.root,'statusline-v1.py');
   if(existsSync(this.root)){safeDir(this.root,true);const text=read(path);
    if(text!==null&&text!==WEEKLY_USAGE_HOOK&&RELEASED_WEEKLY_USAGE_HOOK_SHA256.includes(createHash('sha256').update(text,'utf8').digest('hex')))atomic(path,WEEKLY_USAGE_HOOK);}
   this.#hookChecked=true;
  }catch{/* Unsafe or unreadable: keep the installed hook. */}
 }
 async status():Promise<WeeklyUsage[]>{
  this.upgradeHook();
  const codex:WeeklyUsage={provider:'codex',buckets:[],checkedAt:null,source:'unavailable',connected:true,canConnect:false};
  try{const v=await this.deps.codex();codex.buckets=weeklyBuckets('codex',v.rateLimits);codex.checkedAt=v.checkedAt??null;codex.source=v.source==='session-log'?'statusline':'live';}catch{/* Provider is offline or not signed in. */}
  const items=[this.local('claude'),codex,this.local('agy')];
  // Nothing waits on it: the alert state is stored and handed over in its own queue, and a failure there is not this answer's.
  void this.deps.alerts?.observe(items).catch(()=>{});
  return items;
 }
 async perform(request:WeeklyUsageRequest){
  if(request.operation==='status')return {items:await this.status()};
  if(request.operation==='alerts'){if(!this.deps.alerts)throw Error('이 기기에서는 휴대폰 알림을 쓸 수 없습니다.');return this.deps.alerts.perform(request);}
  const provider=request.provider;
  if(request.operation==='connect'&&!this.canConnect(provider))throw Error('이 기기의 CLI와 Python 연결을 확인하지 못했습니다.');
  const path=this.settings(provider);safeDir(dirname(path));
  return withOwnedPortalFileLock(path+'.agentstoz-usage.lock',async()=>{
   const before=read(path),config=JSON.parse(before??'{}');
   if(!config||typeof config!=='object'||Array.isArray(config)||config.statusLine&&(typeof config.statusLine!=='object'||Array.isArray(config.statusLine)))throw Error('기존 CLI 상태줄 설정을 확인하지 못했습니다.');
   const previous=this.previous(provider),own=this.owns(provider,config.statusLine?.command,previous);
   if(request.operation==='connect'){
    if(!existsSync(this.root))mkdirSync(this.root,{mode:0o700});safeDir(this.root,true);
    if(own&&!previous)throw Error('원래 상태줄을 복원할 자료가 없습니다. 기존 설정을 유지합니다.');
    if(!own&&typeof config.statusLine?.command==='string'&&config.statusLine.command.includes(join(this.root,'statusline-v1.py')))throw Error('현재 상태줄이 기존 사용량 연결을 참조하고 있습니다. 설정을 먼저 확인하세요.');
    atomic(join(this.root,'statusline-v1.py'),WEEKLY_USAGE_HOOK);
    atomic(join(this.root,provider+'-previous.json'),JSON.stringify({version:1,statusLine:own?previous.statusLine:config.statusLine??null,installedCommand:this.command(provider)}));
    config.statusLine={...config.statusLine,type:'command',command:this.command(provider),...(provider==='agy'?{enabled:true,...(!config.statusLine?.command||config.statusLine.enabled===false?{stack_with_default:true}:{})}:{})};
   }else{
    if(!own)return {connected:false}; // An external edit is never overwritten.
    safeDir(this.root,true);if(!previous)throw Error('원래 상태줄 설정을 복원할 자료가 없습니다.');
    if(previous.statusLine===null)delete config.statusLine;else config.statusLine=previous.statusLine;
   }
   if(read(path)!==before)throw Error('CLI 설정이 변경됐습니다. 다시 확인해 주세요.');
   atomic(path,JSON.stringify(config,null,2)+'\n');return {connected:request.operation==='connect'};
  },{attempts:3,retryMs:50,label:'weekly usage settings'});
 }
}
