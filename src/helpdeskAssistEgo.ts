import {homedir,tmpdir} from 'node:os';
import {join,isAbsolute} from 'node:path';
import {accessSync,constants} from 'node:fs';
import {spawn} from 'node:child_process';
import type {AssistDestination} from './helpdeskAssistRecipes';
import {AssistDriverUnavailable,AssistHumanControl,assistReadable,sanitizeObservation,type AssistBrowserDriver,type AssistControl,type AssistDispatch,type AssistObservation} from './helpdeskAssistBrowser';
/** Runs one fixed `ego-browser nodejs` script and returns its stdout. Tests replace it at this boundary. */
export type EgoRunner=(script:string,timeoutMs:number,signal?:AbortSignal)=>Promise<{code:number;stdout:string}>;
/** The SDK's hard stop when the person holds the space (after handOff or a takeover in the browser). Its output replaces
 * the round's earlier output, so a change sent in that round has an unknown outcome. */
const HARD_STOP=/Control of this task space is with the user|browser commands are paused/;
const RESULT='ATZ_RESULT ';
/** One line of `page.snapshot()`: `[- ]role "name" … ref=N`, nested by indentation. A node without its own quoted name
 * takes the text of its child `text "…"` / `text: …` lines. */
const TEXT_LINE=/^(\s*)(?:-\s+)?text(?::\s*(.*)|\s+"((?:[^"\\]|\\.)*)")/;
export function parseEgoSnapshot(snapshot:string){
 const lines=snapshot.split('\n'),out:{ref:string;role:string;name:string}[]=[],texts:string[]=[];
 const unquote=(v:string)=>v.replace(/\\(.)/g,'$1');
 for(let i=0;i<lines.length;i++){
  const line=lines[i]!,t=TEXT_LINE.exec(line);if(t){const v=t[3]!==undefined?unquote(t[3]):(t[2]??'').trim();if(v)texts.push(v);continue;}
  const m=/^(\s*)(?:-\s+)?([a-zA-Z]+)(?:\s+"((?:[^"\\]|\\.)*)")?(?:.*?\bref=(\d+)\b)?/.exec(line);if(!m||!m[4])continue;
  const indent=m[1]!.length,role=m[2]!;let name=m[3]!==undefined?unquote(m[3]):'';
  if(!name){const parts:string[]=[];for(let j=i+1;j<lines.length;j++){const depth=/^(\s*)/.exec(lines[j]!)![1]!.length;if(depth<=indent)break;const c=TEXT_LINE.exec(lines[j]!);if(c)parts.push(c[3]!==undefined?unquote(c[3]):(c[2]??'').trim());if(parts.join(' ').length>160)break;}name=parts.join(' ');}
  out.push({ref:'@'+m[4],role,name});
 }
 return {elements:out,text:texts.join('\n')};
}
export const EGO_OUTPUT_CAP=256_000;
/** Process groups this module started and has not finished with; the sidecar's own exit stops them. */
const egoGroups=new Set<()=>void>();
process.once('exit',()=>{for(const kill of egoGroups)kill();});
/** One call owns exactly the process group it started (detached: the child leads a new group) and nothing else: a
 * timeout, an output overflow or a cancellation signals that group, TERM then KILL after `graceMs`, and stops reading.
 * A descendant that still holds the output pipes after the command itself ended is in the same group and stopped too, so
 * no call waits on a process it did not need. A process that left the group with setsid() is outside this ownership. */
export function createEgoRunner(options:{home?:string;searchPaths?:string[];cap?:number;graceMs?:number}={}):EgoRunner{
 const home=options.home??homedir(),cap=options.cap??EGO_OUTPUT_CAP,grace=options.graceMs??1500;
 const paths=options.searchPaths??[join(home,'.local/bin'),...(process.env.PATH??'').split(':').filter(isAbsolute),'/opt/homebrew/bin','/usr/local/bin','/usr/bin','/bin'];
 const exe=()=>{for(const p of paths)try{const f=join(p,'ego-browser');accessSync(f,constants.X_OK);return f;}catch{}return null;};
 return (script,timeoutMs,signal)=>new Promise((resolve,reject)=>{
  const file=exe();if(!file)return reject(new AssistDriverUnavailable('에고라이트(ego-browser)를 찾지 못했습니다.'));
  if(signal?.aborted)return resolve({code:-1,stdout:''});
  // A neutral directory and no inherited secrets: the script is fixed text with JSON data inside.
  const child=spawn(file,['nodejs','-e',script],{cwd:tmpdir(),env:{HOME:home,PATH:[...new Set(paths)].join(':'),LANG:'en_US.UTF-8',NO_COLOR:'1'},stdio:['ignore','pipe','pipe'],detached:true});
  const group=(sig:NodeJS.Signals)=>{if(child.pid)try{process.kill(-child.pid,sig);}catch{}};
  const parts:Buffer[]=[];let left=cap,stopped=false,ending=false,settled=false,code:number|null=null;
  let killer:ReturnType<typeof setTimeout>|undefined,drain:ReturnType<typeof setTimeout>|undefined,last:ReturnType<typeof setTimeout>|undefined;
  const kill=()=>group('SIGKILL');egoGroups.add(kill);
  const done=()=>{
   if(settled)return;settled=true;for(const t of [timer,killer,drain,last])clearTimeout(t);signal?.removeEventListener('abort',stop);
   // Like the setup commands: nothing of this call's group outlives it. The pipes are closed rather than drained.
   kill();egoGroups.delete(kill);child.stdout?.destroy();child.stderr?.destroy();
   resolve({code:stopped?-1:code??-1,stdout:Buffer.concat(parts).toString('utf8')});
  };
  // What is left of the group is killed, then its pipes get one more grace to close (they close as it exits).
  const finish=()=>{if(settled||ending)return;ending=true;kill();last=setTimeout(done,grace);};
  function stop(){if(stopped||settled)return;stopped=true;group('SIGTERM');killer=setTimeout(finish,grace);}
  const timer=setTimeout(stop,timeoutMs);signal?.addEventListener('abort',stop,{once:true});
  const read=(chunk:Buffer)=>{if(stopped)return;if(chunk.byteLength>left){parts.push(chunk.subarray(0,left));left=0;stop();return;}left-=chunk.byteLength;parts.push(chunk);};
  child.stdout!.on('data',read);child.stderr!.on('data',read);
  child.on('error',()=>{if(!settled){settled=true;clearTimeout(timer);signal?.removeEventListener('abort',stop);egoGroups.delete(kill);reject(new AssistDriverUnavailable('에고라이트를 실행하지 못했습니다.'));}});
  // The command ended: its output is complete once the pipes close. A descendant keeping them open past the grace is
  // this call's own leftover and is stopped with the group.
  child.on('exit',c=>{code=c??-1;if(!stopped)drain=setTimeout(finish,grace);});
  child.on('close',done);
 });
}
/** 에고라이트 driver: one TaskSpace per run, created and resumed by id, page `p1` only. The general `nodejs`, `evaluate`
 * and CDP surface stays inside these fixed scripts; nothing a model writes is ever executed. */
export class EgoAssistDriver implements AssistBrowserDriver {
 readonly kind='ego' as const;private spaceId:number|null=null;private calls=new AbortController();
 constructor(private run:EgoRunner=createEgoRunner(),private timeoutMs=45_000){}
 private async exec<T>(body:string,args:Record<string,unknown>):Promise<T>{
  // Data, not code: JSON.stringify output is a JavaScript literal, embedded once at the top of a fixed script.
  const script=`const a=${JSON.stringify(args)};\n${body}`;
  const r=await this.run(script,this.timeoutMs,this.calls.signal);
  if(HARD_STOP.test(r.stdout))throw new AssistHumanControl();
  const line=r.stdout.split('\n').find(l=>l.startsWith(RESULT));
  // Raw output never travels further: it may name addresses or page text.
  if(r.code!==0||!line)throw Error(/EGO_TASK_SPACE_NAME_IN_USE/.test(r.stdout)?'EGO_SPACE_IN_USE':'EGO_COMMAND_FAILED');
  return JSON.parse(line.slice(RESULT.length)) as T;
 }
 async ready(){
  try{await this.exec<{ok:true}>(`console.log("${RESULT}"+JSON.stringify({ok:typeof taskSpace==="function"}));`,{});return {available:true};}
  catch(e){return {available:false,reason:e instanceof AssistDriverUnavailable?e.message:'에고라이트를 실행하지 못했습니다. 앱이 설치·실행돼 있는지 확인하세요.'};}
 }
 async attach(runId:string,link:{spaceId?:number}){
  const r=await this.exec<{spaceId:number;ownership:string}>(`const task=a.spaceId?await taskSpace(a.spaceId):await taskSpace(a.name);console.log("${RESULT}"+JSON.stringify({spaceId:task.spaceId,ownership:task.ownership}));`,{spaceId:link.spaceId??null,name:`agentstoz-helpdesk-${runId.slice(0,12)}`});
  if(!Number.isSafeInteger(r.spaceId))throw Error('EGO_COMMAND_FAILED');this.spaceId=r.spaceId;return {spaceId:r.spaceId};
 }
 private space(){if(this.spaceId===null)throw Error('EGO_NOT_ATTACHED');return this.spaceId;}
 async navigate(url:string,_requestId:string):Promise<AssistDispatch>{
  try{await this.exec(`const task=await taskSpace(a.spaceId);const p=task.page("p1");await p.goto(a.url,{timeout:30000,waitUntil:"domcontentloaded"});console.log("${RESULT}"+JSON.stringify({ok:true}));`,{spaceId:this.space(),url});return {state:'confirmed'};}
  catch(e){if(e instanceof AssistHumanControl)throw e;return {state:'unknown',note:'이동 결과를 확인하지 못했습니다.'};}
 }
 async location(){const r=await this.exec<{url:string}>(`const task=await taskSpace(a.spaceId);console.log("${RESULT}"+JSON.stringify({url:await task.page("p1").url()}));`,{spaceId:this.space()});return typeof r.url==='string'?r.url:null;}
 async observe(allow:readonly AssistDestination[]):Promise<AssistObservation>{
  // The address is checked inside the same script before the snapshot: an address outside the reviewed destinations is
  // never read. The reviewed patterns travel as data (origin and path source) and are checked again here after.
  const r=await this.exec<{url:string;title?:string;snapshot?:string}>(`const task=await taskSpace(a.spaceId);const p=task.page("p1");const url=String(await p.url());let ok=false;try{const u=new URL(url);ok=u.protocol==="https:"&&!u.username&&!u.password&&a.allow.some(d=>d.origin===u.origin&&new RegExp(d.path,d.flags).test(u.pathname));}catch{}if(!ok){console.log("${RESULT}"+JSON.stringify({url}));}else{const s=await p.snapshot();console.log("${RESULT}"+JSON.stringify({url,title:await p.title(),snapshot:String(s).slice(0,60000)}));}`,{spaceId:this.space(),allow:allow.map(d=>({origin:d.origin,path:d.path.source,flags:d.path.flags.replace(/[gy]/g,'')}))});
  if(!assistReadable(r.url,allow)||typeof r.snapshot!=='string')throw new AssistHumanControl();
  const parsed=parseEgoSnapshot(r.snapshot);return sanitizeObservation({title:r.title,text:parsed.text,elements:parsed.elements});
 }
 async click(ref:string,label:string,_requestId:string):Promise<AssistDispatch>{
  if(!/^@\d{1,6}$/.test(ref))return {state:'refused',note:'관찰한 요소가 아닙니다.'};
  try{const r=await this.exec<{popups:number;dialog:boolean}>(`const task=await taskSpace(a.spaceId);const r=await task.page("p1").click(a.ref,{label:a.label});console.log("${RESULT}"+JSON.stringify({popups:(r&&r.popups||[]).length,dialog:!!(r&&r.dialog)}));`,{spaceId:this.space(),ref,label:label.slice(0,40)});
   return r.popups||r.dialog?{state:'dispatched-unverified',note:'새 창이나 확인창이 열렸습니다.'}:{state:'dispatched-unverified'};}
  catch(e){if(e instanceof AssistHumanControl)return {state:'unknown',note:'사람이 조작을 넘겨받아 결과를 확인하지 못했습니다.'};return {state:'unknown',note:'클릭 결과를 확인하지 못했습니다.'};}
 }
 async fill(ref:string,label:string,value:string,_requestId:string):Promise<AssistDispatch>{
  if(!/^@\d{1,6}$/.test(ref))return {state:'refused',note:'관찰한 요소가 아닙니다.'};
  try{await this.exec(`const task=await taskSpace(a.spaceId);await task.page("p1").fill(a.ref,a.value,{label:a.label});console.log("${RESULT}"+JSON.stringify({ok:true}));`,{spaceId:this.space(),ref,value,label:label.slice(0,40)});return {state:'dispatched-unverified'};}
  catch(e){return {state:'unknown',note:e instanceof AssistHumanControl?'사람이 조작을 넘겨받아 결과를 확인하지 못했습니다.':'입력 결과를 확인하지 못했습니다.'};}
 }
 /** Ego keeps no receipt ledger of its own: a reviewed outcome changes nothing in the browser. */
 async reviewed(_requestId:string){}
 async settle(allowed:(url:string)=>boolean):Promise<AssistControl>{
  const r=await this.exec<{ownership:string|null}>(`const s=(await listTaskSpaces()).find(x=>x.id===a.spaceId);console.log("${RESULT}"+JSON.stringify({ownership:s?s.ownership:null}));`,{spaceId:this.space()});
  if(r.ownership===null)return 'gone';if(r.ownership!=='agent')return 'human';
  const at=await this.location().catch(()=>null);return at&&allowed(at)?'agent':'human';
 }
 async handOff(){try{await this.exec(`const task=await taskSpace(a.spaceId);await task.handOff();console.log("${RESULT}"+JSON.stringify({ok:true}));`,{spaceId:this.space()});}catch(e){if(!(e instanceof AssistHumanControl))throw e;}}
 async takeBack():Promise<AssistControl>{const r=await this.exec<{ownership:string}>(`const task=await takeOverTaskSpace(a.spaceId);console.log("${RESULT}"+JSON.stringify({ownership:task.ownership}));`,{spaceId:this.space()});return r.ownership==='agent'?'agent':'human';}
 /** Stops the calls in flight now (their processes and output); a later call, such as finish, starts fresh. */
 abort(){this.calls.abort();this.calls=new AbortController();}
 async finish(){if(this.spaceId===null)return;try{await this.exec(`const task=await taskSpace(a.spaceId);await task.finish({keep:[]});console.log("${RESULT}"+JSON.stringify({ok:true}));`,{spaceId:this.spaceId});}catch(e){if(!(e instanceof AssistHumanControl))throw e;}finally{this.spaceId=null;}}
}
