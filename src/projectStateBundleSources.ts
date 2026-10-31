import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat,open,realpath,readlink,mkdtemp,mkdir,writeFile,chmod,rm,utimes} from 'node:fs/promises';
import {isAbsolute,join,relative,resolve,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {parseGitWorktreePorcelain} from '../git-worktree-list';
import {recallCuratedProjectMemory} from '../project-memory-server';
import {parseProjectMemoryFeedbackText} from './projectMemoryFeedback';
import {composeMemoryDocument,MEMORY_NOTES_DIR_REL,type MemoryNoteManifest} from './projectMemoryDocument';
import {MEMORY_DOCUMENT_PENDING} from './memoryDocumentTransaction';
import {readTesterCachedReport} from './testerOverview';
import {projectTesterReportMetadata} from './testerAgentHost';
import type {TesterReport} from './testerAgentContract';
import type {WorkroomActivityEntry} from './aiTerminalActivity';
import {safeProjectStateText,sourceFreshness} from './projectStateBundle';
import type {TargetBinding,ReadBudget,ReadSourceAdapter,SourceObservation,SectionId,ReadToolSourceAdapters,ReadToolSourceResult,ReadToolSourceAdapter} from './projectStateBundle';
import {READ_TOOL_OPERATIONS,parseReadToolInput,readToolSection,type ReadToolOperation,type ResolvedReadToolInput} from './readToolBundle';

const GIT_OUTPUT_BYTES=128*1024;
const SOURCE_BYTES=1024*1024;
const hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
class SourceReadError extends Error {
  constructor(readonly code:string){super(code);}
}
const check=(signal:AbortSignal,deadline:number)=>{signal.throwIfAborted();if(Date.now()>=deadline)throw new SourceReadError('SOURCE_TIMEOUT');};
const inside=(root:string,path:string)=>{const r=relative(root,path);return r!== '..'&&!r.startsWith(`..${sep}`)&&!isAbsolute(r);};
const timestamp=(value:unknown):number|undefined=>typeof value==='string'&&Number.isFinite(Date.parse(value))?Date.parse(value):undefined;

/** Values are source data, never instructions. Paths and credential-shaped strings are withheld. */
function safeText(value:unknown,max=700):string {
  return safeProjectStateText(String(value??'')).replace(/[\u0000-\u001f\u007f]/g,' ')
    .replace(/(?:https?:\/\/|ssh:\/\/|git@)[^\s<>]+/gi,'[withheld URL]')
    .slice(0,max);
}
function relativeFile(value:string):string|null {
  if(!value||value.includes('\ufffd')||isAbsolute(value)||/^[A-Za-z]:/.test(value)||value.includes('\\')||value.split('/').some(p=>!p||p==='.'||p==='..'))return null;
  return safeText(value,180);
}

const GIT_ARGS={
  location:['rev-parse','--path-format=absolute','--show-toplevel','--git-common-dir','--absolute-git-dir'],
  head:['rev-parse','--verify','HEAD'],
  branch:['symbolic-ref','--quiet','--short','HEAD'],
  status:['status','--porcelain=v1','-z','--untracked-files=all','--ignore-submodules=all'],
  diff:['diff','--no-ext-diff','--no-textconv','--binary','--ignore-submodules=all','HEAD'],
  untracked:['ls-files','--others','--exclude-standard','-z'],
  filters:['config','--includes','--name-only','--get-regexp','^[fF][iI][lL][tT][eE][rR]\\.'],
  worktrees:['-c','core.quotePath=false','worktree','list','--porcelain'],
} as const;
type GitRead=keyof typeof GIT_ARGS;
interface GitResult {ok:boolean;bytes:Buffer;truncated:boolean;exitCode:number|null;notRepository?:boolean}
interface IsolatedGitProbe {directory:string;objects:string;index:string}
/** Fixed read argv only. Cancellation/output/timeout kill the child; resolve waits for close. */
async function gitRead(root:string,operation:GitRead,signal:AbortSignal,deadline:number,probe?:IsolatedGitProbe):Promise<GitResult> {
  check(signal,deadline);
  if((operation==='status'||operation==='diff')&&!probe)throw new SourceReadError('GIT_ISOLATION_REQUIRED');
  return new Promise((done,reject)=>{
    const env:Record<string,string>={PATH:process.env.PATH??'/usr/bin:/bin',LC_ALL:'C',GIT_OPTIONAL_LOCKS:'0',GIT_TERMINAL_PROMPT:'0',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null'};
    if(process.env.SystemRoot)env.SystemRoot=process.env.SystemRoot;
    if(probe)Object.assign(env,{GIT_DIR:probe.directory,GIT_WORK_TREE:root,GIT_OBJECT_DIRECTORY:probe.objects,GIT_INDEX_FILE:probe.index,GIT_ATTR_NOSYSTEM:'1',GIT_NO_LAZY_FETCH:'1',GIT_NO_REPLACE_OBJECTS:'1'});
    let child:ReturnType<typeof spawn>;
    try{child=spawn('git',['--no-optional-locks','-c','core.fsmonitor=false','-c','core.untrackedCache=false',...GIT_ARGS[operation]],{cwd:root,env,stdio:['ignore','pipe','pipe']});}
    catch{reject(new SourceReadError('GIT_UNAVAILABLE'));return;}
    const chunks:Buffer[]=[],errors:Buffer[]=[];let total=0,truncated=false,aborted=false,timedOut=false,failed=false;
    const stop=()=>{try{child.kill('SIGKILL');}catch{}};
    const abort=()=>{aborted=true;stop();};signal.addEventListener('abort',abort,{once:true});
    if(signal.aborted)abort();
    const timer=setTimeout(()=>{timedOut=true;stop();},Math.max(1,Math.min(3000,deadline-Date.now())));
    const receive=(bytes:Buffer,stdout:boolean)=>{
      const remaining=Math.max(0,GIT_OUTPUT_BYTES-total);total+=bytes.length;
      if(stdout&&remaining)chunks.push(bytes.subarray(0,remaining));
      else if(!stdout&&remaining)errors.push(bytes.subarray(0,remaining));
      if(total>GIT_OUTPUT_BYTES){truncated=true;stop();}
    };
    child.stdout?.on('data',(v:Buffer)=>receive(v,true));child.stderr?.on('data',(v:Buffer)=>receive(v,false));
    child.once('error',()=>{failed=true;});
    child.once('close',code=>{
      clearTimeout(timer);signal.removeEventListener('abort',abort);
      if(aborted){reject(new SourceReadError('SOURCE_CANCELLED'));return;}
      if(timedOut){reject(new SourceReadError('SOURCE_TIMEOUT'));return;}
      if(failed){reject(new SourceReadError('GIT_UNAVAILABLE'));return;}
      done({ok:code===0&&!truncated,bytes:Buffer.concat(chunks),truncated,exitCode:code,
        ...(operation==='location'?{notRepository:/not a git repository/.test(Buffer.concat(errors).toString('utf8'))}: {})});
    });
  });
}

/** Async metadata/file reads preserve a slot until actual I/O settles. No Promise.race hides pending I/O. */
class BoundedFiles {
  used=0;
  constructor(readonly root:string,readonly budget:ReadBudget,readonly signal:AbortSignal){}
  async path(rel:string):Promise<string|null>{
    check(this.signal,this.budget.deadline);
    if(!rel||isAbsolute(rel)||rel.includes('\\')||rel.split('/').some(v=>!v||v==='.'||v==='..'))throw new SourceReadError('SOURCE_PATH_INVALID');
    let path=this.root;
    for(const part of rel.split('/')){
      path=join(path,part);
      try{const s=await lstat(path);check(this.signal,this.budget.deadline);if(s.isSymbolicLink())throw new SourceReadError('SOURCE_SYMLINK');}
      catch(error:any){if(error?.code==='ENOENT')return null;throw error;}
    }
    if(!inside(this.root,await realpath(path)))throw new SourceReadError('SOURCE_PATH_INVALID');
    return path;
  }
  async read(rel:string,max=this.budget.maxSourceBytes):Promise<{bytes:Buffer;mtime:number;identity:{dev:number;ino:number;size:number;mtimeMs:number;ctimeMs:number}}|null>{
    const path=await this.path(rel);if(!path)return null;
    const file=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0)|(constants.O_NONBLOCK??0));
    try{
      check(this.signal,this.budget.deadline);const before=await file.stat();
      if(!before.isFile())throw new SourceReadError('SOURCE_FILE_INVALID');
      if(before.nlink!==1)throw new SourceReadError('SOURCE_HARDLINK');
      if(before.size>max||before.size>this.budget.maxSourceBytes-this.used)throw new SourceReadError('SOURCE_BYTE_LIMIT');
      if(!this.budget.consume(before.size))throw new SourceReadError('SOURCE_BYTE_LIMIT');
      this.used+=before.size;
      const bytes=Buffer.alloc(before.size+1);let used=0;
      while(used<bytes.length){check(this.signal,this.budget.deadline);const r=await file.read(bytes,used,Math.min(64*1024,bytes.length-used),used);if(!r.bytesRead)break;used+=r.bytesRead;}
      check(this.signal,this.budget.deadline);const after=await file.stat(),current=await lstat(path);
      if(used!==before.size||current.isSymbolicLink()||await realpath(path)!==path||![after,current].every(s=>s.dev===before.dev&&s.ino===before.ino&&s.size===before.size&&s.mtimeMs===before.mtimeMs&&s.ctimeMs===before.ctimeMs))throw new SourceReadError('SOURCE_CHANGED');
      return {bytes:bytes.subarray(0,used),mtime:before.mtimeMs,identity:{dev:before.dev,ino:before.ino,size:before.size,mtimeMs:before.mtimeMs,ctimeMs:before.ctimeMs}};
    }finally{await file.close();}
  }
  async assertUnchanged(rel:string,identity:{dev:number;ino:number;size:number;mtimeMs:number;ctimeMs:number}):Promise<void>{
    const path=await this.path(rel);if(!path)throw new SourceReadError('SOURCE_CHANGED');
    const current=await lstat(path);check(this.signal,this.budget.deadline);
    if(!current.isFile()||current.nlink!==1||current.dev!==identity.dev||current.ino!==identity.ino||current.size!==identity.size||current.mtimeMs!==identity.mtimeMs||current.ctimeMs!==identity.ctimeMs)throw new SourceReadError('SOURCE_CHANGED');
  }
  async text(rel:string,max=this.budget.maxSourceBytes){const file=await this.read(rel,max);if(!file)return null;let text:string;try{text=new TextDecoder('utf-8',{fatal:true}).decode(file.bytes);}catch{throw new SourceReadError('SOURCE_FORMAT_INVALID');}return {...file,text};}
}

interface GitEvidence {
  root:string;common:string|null;primaryRoot:string|null;head:string|null;branch:string|null;
  status:Buffer;statusComplete:boolean;fingerprint?:string;sourceComplete:boolean;revision:string;gitWithheld:boolean;
}
const evidenceByBinding=new WeakMap<TargetBinding,GitEvidence>();
function localBudget(deadline:number,max=SOURCE_BYTES):ReadBudget {
  let used=0;return {deadline,maxSourceBytes:max,maxTotalBytes:max,consume(bytes){if(used+bytes>max)return false;used+=bytes;return true;}};
}

/** Only ordinary SHA-1 v2/v3 indexes are admitted. Split/sparse indexes and
 * gitlinks need another authority surface; do not traverse nested Git configs. */
function safeIndex(bytes:Buffer):boolean {
  if(bytes.length<32||bytes.toString('ascii',0,4)!=='DIRC'||![2,3].includes(bytes.readUInt32BE(4)))return false;
  if(!createHash('sha1').update(bytes.subarray(0,-20)).digest().equals(bytes.subarray(-20)))return false;
  const count=bytes.readUInt32BE(8);if(count>20000)return false;let offset=12;
  for(let i=0;i<count;i++){
    const start=offset;if(offset+62>bytes.length-20)return false;
    if((bytes.readUInt32BE(offset+24)&0o170000)===0o160000)return false;
    const flags=bytes.readUInt16BE(offset+60);offset+=62;
    if(flags&0x4000){if(bytes.readUInt32BE(4)!==3||offset+2>bytes.length-20)return false;offset+=2;}
    const nul=bytes.indexOf(0,offset);if(nul<0||nul>=bytes.length-20)return false;
    offset=start+Math.ceil((nul+1-start)/8)*8;
  }
  while(offset<bytes.length-20){
    if(offset+8>bytes.length-20)return false;const kind=bytes.toString('ascii',offset,offset+4),size=bytes.readUInt32BE(offset+4);
    if(kind==='link'||/^[a-z]/.test(kind))return false;offset+=8+size;if(offset>bytes.length-20)return false;
  }
  return offset===bytes.length-20;
}

/** Ephemeral metadata only: Git never reopens the repository's mutable config.
 * Read children settle before cleanup; the original index/config remain untouched. */
async function withIsolatedGitProbe<T>(input:{root:string;gitDir:string;common:string;head:string;signal:AbortSignal;deadline:number},read:(probe:IsolatedGitProbe)=>Promise<T>):Promise<T|undefined>{
  const files=new BoundedFiles(input.gitDir,localBudget(input.deadline),input.signal),index=await files.read('index',SOURCE_BYTES);
  if(!index||!safeIndex(index.bytes))return undefined;
  // Git compares the index file's mtime to cached entry times to decide when
  // it must rehash a racy entry. A freshly written copy would hide that race.
  // Round down rather than up: a coarser timestamp may cause extra rehashing,
  // but must never make the isolated index appear newer than the original.
  const indexSeconds=Math.floor(index.mtime/1000);if(!Number.isFinite(indexSeconds)||indexSeconds<1)return undefined;
  const objects=await realpath(join(input.common,'objects'));if(!(await lstat(objects)).isDirectory())return undefined;
  check(input.signal,input.deadline);const directory=await mkdtemp(join(tmpdir(),'agentstoz-state-git-'));
  try{
    await chmod(directory,0o700);await mkdir(join(directory,'objects'),{mode:0o700});await mkdir(join(directory,'refs'),{mode:0o700});
    await writeFile(join(directory,'config'),'[core]\n bare = false\n repositoryformatversion = 0\n attributesfile = '+(process.platform==='win32'?'NUL':'/dev/null')+'\n fsmonitor = false\n untrackedcache = false\n',{mode:0o600,flag:'wx'});
    await writeFile(join(directory,'HEAD'),input.head+'\n',{mode:0o600,flag:'wx'});const indexPath=join(directory,'index');await writeFile(indexPath,index.bytes,{mode:0o600,flag:'wx'});
    await utimes(indexPath,indexSeconds,indexSeconds);const copied=await lstat(indexPath);
    if(!Number.isFinite(copied.mtimeMs)||copied.mtimeMs>index.mtime||copied.mtimeMs<1000)return undefined;
    await files.assertUnchanged('index',index.identity);check(input.signal,input.deadline);
    const result=await read({directory,objects,index:indexPath});await files.assertUnchanged('index',index.identity);return result;
  }finally{await rm(directory,{recursive:true,force:true});}
}

/** Matches the existing maintainer source_identity bytes, under this feature's smaller budgets.
 * It hashes raw bytes internally; no diff, link destination or file content leaves this reader. */
async function gitSourceFingerprint(root:string,headBytes:Buffer,signal:AbortSignal,budget:ReadBudget,probe:IsolatedGitProbe):Promise<string|undefined>{
  const reads=await Promise.allSettled([gitRead(root,'diff',signal,budget.deadline,probe),gitRead(root,'untracked',signal,budget.deadline,probe)]);
  const failed=reads.find(v=>v.status==='rejected');if(failed?.status==='rejected')throw failed.reason;
  const [diff,untracked]=reads.map(v=>(v as PromiseFulfilledResult<GitResult>).value) as [GitResult,GitResult];
  if(!diff.ok||!untracked.ok)return undefined;
  if(!budget.consume(diff.bytes.length+untracked.bytes.length+headBytes.length))return undefined;
  const digest=createHash('sha256').update(headBytes).update(diff.bytes),files=new BoundedFiles(root,budget,signal);
  const names=untracked.bytes.toString('utf8').split('\0').filter(Boolean).sort((a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b)));
  if(names.length>4096)return undefined;
  for(const name of names){
    check(signal,budget.deadline);
    if(!relativeFile(name)||name.includes('\ufffd'))return undefined;
    const parent=relative(root,resolve(root,name,'..')).split(sep).join('/');
    if(parent&&parent!=='.')await files.path(parent);
    const path=join(root,name),stat=await lstat(path);
    if(stat.isSymbolicLink()){
      const value=await readlink(path);if(!budget.consume(Buffer.byteLength(name)+Buffer.byteLength(value)+16))return undefined;
      const after=await lstat(path);if(!after.isSymbolicLink()||after.dev!==stat.dev||after.ino!==stat.ino||after.mtimeMs!==stat.mtimeMs||after.ctimeMs!==stat.ctimeMs)return undefined;
      digest.update(Buffer.from(name)).update('\0symlink\0').update(Buffer.from(value));
    }else{
      const file=await files.read(name);if(!file)return undefined;digest.update(Buffer.from(name)).update('\0').update(file.bytes);
    }
  }
  return digest.digest('hex');
}

export interface ProjectStateCheckoutInput {targetId:string;projectId:string;owner:string;rootPath:string;authorityRevision:string}
/** Authority is resolved by the existing registered target inventory before this read-only proof. */
export async function resolveProjectStateCheckout(input:ProjectStateCheckoutInput,signal:AbortSignal,internal?:{beforeIsolatedRead?:(temporaryDirectory:string)=>Promise<void>|void}):Promise<TargetBinding>{
  const deadline=Date.now()+3000;check(signal,deadline);
  if(!isAbsolute(input.rootPath)||!input.authorityRevision)throw new SourceReadError('PROJECT_STATE_TARGET_INVALID');
  const initial=await lstat(input.rootPath);if(initial.isSymbolicLink()||!initial.isDirectory())throw new SourceReadError('PROJECT_STATE_TARGET_INVALID');
  const root=await realpath(input.rootPath),rootStat=await lstat(root);check(signal,deadline);
  const location=await gitRead(root,'location',signal,deadline);
  let common:string|null=null,primaryRoot:string|null=null,head:string|null=null,branch:string|null=null,status:Buffer=Buffer.alloc(0),statusComplete=false,fingerprint:string|undefined;
  let gitWithheld=false;
  let commonIdentity='none',headBytes:Buffer=Buffer.alloc(0);
  if(location.ok){
    const lines=location.bytes.toString('utf8').trimEnd().split('\n');
    if(lines.length!==3)throw new SourceReadError('PROJECT_STATE_CHECKOUT_UNVERIFIED');
    const top=await realpath(lines[0]!);if(!inside(top,root))throw new SourceReadError('PROJECT_STATE_CHECKOUT_UNVERIFIED');
    common=await realpath(resolve(root,lines[1]!));const st=await lstat(common);if(!st.isDirectory()||st.isSymbolicLink())throw new SourceReadError('PROJECT_STATE_CHECKOUT_UNVERIFIED');
    commonIdentity=`${common}\0${st.dev}\0${st.ino}`;
    const gitDir=await realpath(lines[2]!);
    // Git clean/process drivers can execute repository shell commands even with
    // --no-ext-diff/--no-textconv. Read effective included/worktree config first.
    // Subdirectory registrations must not expose sibling repository metadata.
    const filters=await gitRead(root,'filters',signal,deadline);
    gitWithheld=root!==top||filters.truncated||!(filters.exitCode===1&&!filters.bytes.length);
    const results=await Promise.allSettled([gitRead(root,'head',signal,deadline),gitRead(root,'branch',signal,deadline),gitRead(root,'worktrees',signal,deadline)]);
    const failure=results.find(v=>v.status==='rejected');if(failure?.status==='rejected')throw failure.reason;
    const [h,b,w]=results.map(v=>(v as PromiseFulfilledResult<GitResult>).value);
    if(b!.truncated||(!b!.ok&&b!.exitCode!==1))throw new SourceReadError('PROJECT_STATE_CHECKOUT_UNVERIFIED');
    if(h!.ok&&/^[a-f0-9]{40,64}\n?$/.test(h!.bytes.toString('utf8'))){headBytes=h!.bytes;head=headBytes.toString('utf8').trim();}
    if(b!.ok)branch=b!.bytes.toString('utf8').trim()||null;
    if(!w!.ok)throw new SourceReadError('PROJECT_STATE_CHECKOUT_UNVERIFIED');
    const worktrees=parseGitWorktreePorcelain(w!.bytes.toString('utf8'));
    const first=worktrees[0];if(!first||!worktrees.some(v=>resolve(v.path)===top))throw new SourceReadError('PROJECT_STATE_CHECKOUT_UNVERIFIED');
    primaryRoot=await realpath(join(first.path,relative(top,root)));
    if(head&&!gitWithheld){
      try{
        const result=await withIsolatedGitProbe({root,gitDir,common,head,signal,deadline},async probe=>{
          await internal?.beforeIsolatedRead?.(probe.directory);
          const values=await Promise.allSettled([gitRead(root,'status',signal,deadline,probe),gitSourceFingerprint(root,headBytes,signal,localBudget(deadline),probe)]);
          const failure=values.find(v=>v.status==='rejected');if(failure?.status==='rejected')throw failure.reason;
          return {status:(values[0] as PromiseFulfilledResult<GitResult>).value,fingerprint:(values[1] as PromiseFulfilledResult<string|undefined>).value};
        });
        if(result){status=result.status.bytes;statusComplete=result.status.ok;fingerprint=result.fingerprint;}
        else gitWithheld=true;
        const afterFilters=await gitRead(root,'filters',signal,deadline);
        if(afterFilters.truncated||afterFilters.exitCode!==1||afterFilters.bytes.length){gitWithheld=true;statusComplete=false;fingerprint=undefined;}
      }catch(error){if(signal.aborted)throw error;gitWithheld=true;statusComplete=false;fingerprint=undefined;}
    }
  }else if(location.truncated||!location.notRepository)throw new SourceReadError('PROJECT_STATE_CHECKOUT_UNVERIFIED');
  else {
    // Only an actually absent repository may become a non-Git project; an unreadable .git fails closed.
    try{await lstat(join(root,'.git'));throw new SourceReadError('PROJECT_STATE_CHECKOUT_UNVERIFIED');}
    catch(error:any){if(error?.code!=='ENOENT')throw error;}
    primaryRoot=root;
  }
  check(signal,deadline);
  const fresh=await lstat(root);if(fresh.dev!==rootStat.dev||fresh.ino!==rootStat.ino)throw new SourceReadError('PROJECT_STATE_CHECKOUT_UNVERIFIED');
  const sourceComplete=!!fingerprint&&statusComplete;
  const revision=hash(JSON.stringify({head,branch,status:hash(status),fingerprint:fingerprint??null,statusComplete,gitWithheld}));
  const binding:TargetBinding={targetId:input.targetId,projectId:input.projectId,owner:input.owner,role:'dev',rootPath:root,
    proof:hash([root,rootStat.dev,rootStat.ino,commonIdentity,head,branch,input.authorityRevision,revision].join('\0')),sourceProofComplete:sourceComplete};
  evidenceByBinding.set(binding,{root,common,primaryRoot,head,branch,status,statusComplete,fingerprint,sourceComplete,revision,gitWithheld});
  return binding;
}

function base(id:SectionId,values:Partial<SourceObservation>={}):SourceObservation{return {id,availability:'ready',freshness:'unknown',observedAt:Date.now(),summary:[],limits:[],...values};}
function failure(id:SectionId,error:unknown):SourceObservation {
  const allowed=['SOURCE_SYMLINK','SOURCE_FILE_INVALID','SOURCE_BYTE_LIMIT','SOURCE_INVENTORY_LIMIT','SOURCE_FORMAT_INVALID'];
  const code=error instanceof SourceReadError?error.code:error instanceof SyntaxError?'SOURCE_FORMAT_INVALID':
    error&&typeof error==='object'&&'code' in error&&allowed.includes(String(error.code))?String(error.code):'SOURCE_UNAVAILABLE';
  const partial=['SOURCE_BYTE_LIMIT','SOURCE_CHANGED','SOURCE_TIMEOUT','SOURCE_INVENTORY_LIMIT'].includes(code);
  return base(id,{availability:partial?'partial':'unavailable',errorCode:code,limits:[code]});
}
const guard=(id:SectionId,read:ReadSourceAdapter['read']):ReadSourceAdapter=>({async read(...args){try{check(args[3],args[2].deadline);return await read(...args);}catch(error){return failure(id,error);}}});

/** Same safe report projection backs P1 status and the two distinct P2 reads. */
function testerObservation(binding:TargetBinding,report:TesterReport,details=false):SourceObservation {
  const e=evidenceByBinding.get(binding),freshness=sourceFreshness(report.source,{commit:e?.head??undefined,fingerprint:e?.fingerprint});
  const counts=new Map<string,number>();for(const c of report.checks)counts.set(c.state,(counts.get(c.state)??0)+1);
  const metadata={runId:report.runId,state:report.state,profile:report.profile,startedAt:report.startedAt,finishedAt:report.finishedAt,source:report.source,counts:[...counts].sort()};
  const checks=report.checks.map(c=>({id:safeText(c.id,64),state:safeText(c.state,40)}));
  return base('tester',{freshness,sourceProducedAt:timestamp(report.finishedAt??report.startedAt),sourceRevision:hash(JSON.stringify(details?{...metadata,checks}:metadata)),
    summary:[`run: ${report.runId}; profile: ${safeText(report.profile,64)}`,`original result: ${report.state}`,`checks: ${[...counts].map(([state,count])=>`${safeText(state,40)} ${count}`).join(', ')||'none'}`,
      ...(details?checks.slice(0,12).map(c=>`check: ${c.id}; original result: ${c.state}`):[])],
    limits:['CACHED_RESULT_NO_TESTS_EXECUTED',...(freshness==='unknown'?['EXACT_COMMIT_AND_SOURCE_FINGERPRINT_NOT_BOTH_PROVEN']:[]),...(details&&checks.length>12?['TESTER_CHECKS_LIMIT_12']:[])]});
}
async function readTesterStatus(binding:TargetBinding,budget:ReadBudget,signal:AbortSignal):Promise<ReadToolSourceResult>{
  if(!binding.rootPath)throw new SourceReadError('SOURCE_TARGET_INVALID');const files=new BoundedFiles(binding.rootPath,budget,signal);
  const config=await files.text('.agentstoz/maintainer.json',512000);
  if(!config)return {observation:base('tester',{availability:'unconfigured',limits:['TESTER_NOT_CONFIGURED']})};
  const parsed=JSON.parse(config.text);if(parsed?.schemaVersion!==1||!Array.isArray(parsed.checks)||!parsed.profiles||typeof parsed.profiles!=='object')throw new SourceReadError('SOURCE_FORMAT_INVALID');
  const raw=await readTesterCachedReport(binding.rootPath,async(path,max)=>(await files.text(path,max))?.text??null,signal);
  if(!raw)return {observation:base('tester',{availability:'ready',sourceRevision:hash(config.bytes),summary:['Tester configured; no cached profile result.'],limits:['NO_TESTS_EXECUTED_BY_PREVIEW']})};
  const report=projectTesterReportMetadata(raw,binding.rootPath);if(!report)throw new SourceReadError('SOURCE_FORMAT_INVALID');
  return {observation:testerObservation(binding,report),latestRunId:report.runId};
}
async function readTesterReport(binding:TargetBinding,runId:string,budget:ReadBudget,signal:AbortSignal):Promise<ReadToolSourceResult>{
  if(!binding.rootPath)throw new SourceReadError('SOURCE_TARGET_INVALID');
  const file=await new BoundedFiles(binding.rootPath,budget,signal).text(`.agentstoz/maintainer/runs/${runId}/report.json`);
  if(!file)throw new SourceReadError('TESTER_REPORT_NOT_FOUND');
  const raw=JSON.parse(file.text);if(raw?.runId!==runId)throw new SourceReadError('TESTER_REPORT_ID_MISMATCH');
  const report=projectTesterReportMetadata(raw,binding.rootPath);if(!report)throw new SourceReadError('SOURCE_FORMAT_INVALID');
  return {observation:testerObservation(binding,report,true),reportRunId:report.runId};
}

export interface ProjectStateBundleSourcesOptions {
  /** Existing in-memory activity snapshot only. Exact target; no history/transcript probes. */
  workroom?:(binding:TargetBinding,signal:AbortSignal)=>Promise<readonly WorkroomActivityEntry[]>|readonly WorkroomActivityEntry[];
}
export function createProjectStateBundleSources(options:ProjectStateBundleSourcesOptions={}):Record<SectionId,ReadSourceAdapter>{
  return {
    git:guard('git',async(binding,_input,budget,signal)=>{
      const e=evidenceByBinding.get(binding);if(!e)return base('git',{availability:'unknown',errorCode:'CHECKOUT_EVIDENCE_MISSING'});
      if(!e.common)return base('git',{availability:'unconfigured',limits:['GIT_NOT_CONFIGURED']});
      if(!budget.consume(e.status.length))throw new SourceReadError('SOURCE_BYTE_LIMIT');check(signal,budget.deadline);
      let staged=0,unstaged=0,untracked=0,conflicts=0;const paths:string[]=[];
      const records=e.status.toString('utf8').split('\0');let complete=e.statusComplete;
      if(e.status.length&&e.status.at(-1)!==0){records.pop();complete=false;}
      for(let i=0;i<records.length;i++){
        const row=records[i]!;if(!row)continue;if(row.length<4||row[2]!==' '){complete=false;continue;}
        const xy=row.slice(0,2),path=relativeFile(row.slice(3));
        if(xy==='??')untracked++;else{if(xy[0]!==' ')staged++;if(xy[1]!==' ')unstaged++;if(xy.includes('U')||['AA','DD'].includes(xy))conflicts++;}
        if(path&&paths.length<20)paths.push(path);
        if(/[RC]/.test(xy)){i++;if(!records[i])complete=false;}
      }
      const summary=[`branch: ${e.branch?safeText(e.branch,120):'detached or unborn'}`,`commit: ${e.head??'unborn'}`,
        e.gitWithheld?'changes: unavailable under the read-only Git policy':`${complete?'changes':'observed changes (incomplete)'}: staged ${staged}, unstaged ${unstaged}, untracked ${untracked}, conflicts ${conflicts}`,...paths.map(v=>`file: ${v}`)];
      const limits:string[]=[];if(e.gitWithheld)limits.push('GIT_FILTER_OR_SUBDIRECTORY_SCOPE_UNSUPPORTED');else if(!complete)limits.push('GIT_STATUS_TRUNCATED_COUNTS_ARE_LOWER_BOUNDS');if(paths.length===20)limits.push('GIT_PATHS_LIMIT_20');if(!e.sourceComplete)limits.push('SOURCE_FINGERPRINT_UNAVAILABLE_SEND_BLOCKED');
      return base('git',{availability:complete&&e.sourceComplete?'ready':'partial',freshness:e.sourceComplete?'current':'unknown',sourceRevision:e.revision,summary,limits});
    }),
    workroom:guard('workroom',async(binding,input,budget,signal)=>{
      if(!options.workroom)return base('workroom',{availability:'unavailable',limits:['WORKROOM_METADATA_UNAVAILABLE']});
      const rows=(await options.workroom(binding,signal)).filter(v=>v.targetId===binding.targetId&&v.sessionId!==input.excludeWorkroomSessionId).sort((a,b)=>a.sessionId.localeCompare(b.sessionId));check(signal,budget.deadline);
      const selected=rows.slice(0,8).map(v=>({sessionId:safeText(v.sessionId,100),agent:['codex','claude','hermes','agy'].includes(v.agent)?v.agent:'unknown',state:['starting','working','needs-answer','turn-finished','idle','exited'].includes(v.state)?v.state:'unknown',since:Number.isFinite(v.since)?v.since:null,turn:Number.isSafeInteger(v.turn)?v.turn:null,exact:v.exact===true,lastOutputAt:typeof v.lastOutputAt==='number'&&Number.isFinite(v.lastOutputAt)?v.lastOutputAt:null}));
      const serialized=JSON.stringify(selected);if(!budget.consume(Buffer.byteLength(serialized)))throw new SourceReadError('SOURCE_BYTE_LIMIT');
      return base('workroom',{availability:rows.length>8?'partial':'ready',freshness:'current',sourceRevision:hash(serialized),sourceProducedAt:selected.reduce((n,v)=>Math.max(n,v.lastOutputAt??v.since??0),0)||undefined,
        summary:selected.length?selected.map(v=>`${v.agent}: ${v.state}; session ${v.sessionId}; activity ${v.exact?'confirmed':'inferred'}; last output ${v.lastOutputAt?new Date(v.lastOutputAt).toISOString():'unknown'}`):['No active Workroom session for this target.'],limits:rows.length>8?['WORKROOM_SESSIONS_LIMIT_8']:[]});
    }),
    tester:guard('tester',async(binding,_input,budget,signal)=>(await readTesterStatus(binding,budget,signal)).observation),
    memory:guard('memory',async(binding,input,budget,signal)=>{
      if(!input.query?.trim())return base('memory',{availability:'unconfigured',limits:['MEMORY_QUERY_NOT_SELECTED']});
      const e=evidenceByBinding.get(binding);if(!e?.primaryRoot)return base('memory',{availability:'unknown',limits:['CANONICAL_MEMORY_ROOT_UNVERIFIED']});
      const files=new BoundedFiles(e.primaryRoot,budget,signal),configFile=await files.text('.agent-memory/config.json',32000);
      if(!configFile)return base('memory',{availability:'unconfigured',limits:['MEMORY_NOT_CONFIGURED']});
      const config=JSON.parse(configFile.text);if(typeof config.memoryId!=='string'||!config.memoryId||typeof config.sourcePath!=='string'||!config.sourcePath)throw new SourceReadError('SOURCE_FORMAT_INVALID');
      if(await files.path(MEMORY_DOCUMENT_PENDING))throw new SourceReadError('MEMORY_RECOVERY_REQUIRED');
      const primary=await files.text(config.sourcePath);if(!primary)throw new SourceReadError('MEMORY_DOCUMENT_MISSING');
      let document=primary.text,producedAt=primary.mtime;
      const manifestFile=await files.text(`${MEMORY_NOTES_DIR_REL}/manifest.json`,64000);
      if(manifestFile){
        const manifest=JSON.parse(manifestFile.text) as MemoryNoteManifest;
        if(manifest.version!==1||!Array.isArray(manifest.parts)||manifest.parts.length<1||manifest.parts.length>128)throw new SourceReadError('SOURCE_FORMAT_INVALID');
        const parts:string[]=[],seen=new Set<string>();
        for(const part of manifest.parts){if(!part||typeof part.file!=='string'||!part.file.endsWith('.md')||part.file.includes('/')||part.file.includes('\\')||seen.has(part.file))throw new SourceReadError('SOURCE_FORMAT_INVALID');seen.add(part.file);const note=await files.text(`${MEMORY_NOTES_DIR_REL}/${part.file}`);if(!note)throw new SourceReadError('MEMORY_DOCUMENT_MISSING');parts.push(note.text);producedAt=Math.max(producedAt,note.mtime);}
        document=composeMemoryDocument(parts);
      }
      const feedback=await files.text('.agent-memory/feedback/events.jsonl');
      const result=recallCuratedProjectMemory({memoryId:config.memoryId,document,query:input.query,limit:3,ledger:parseProjectMemoryFeedbackText(feedback?.text??'',{rejectInvalid:true})});
      const summary=result.hits.slice(0,3).map(hit=>`entry ${hit.entryKey}; version ${hit.contentVersionHash}; ${safeText(hit.title,120)}${hit.caution?' [caution]':''}: ${safeText(hit.body,700)}`);
      if(result.corrections.length)summary.push(`${result.corrections.length} related corrected or contradicted claims withheld; review required.`);
      if(!summary.length)summary.push('No related curated entry found for the selected query.');
      return base('memory',{freshness:'current',sourceProducedAt:Math.max(producedAt,feedback?.mtime??0),sourceRevision:hash(JSON.stringify({memoryId:config.memoryId,document:hash(document),feedback:hash(feedback?.text??''),query:input.query})),summary,limits:['CURATED_ONLY_NO_JOURNAL_COMMON_MEMORY_INDEX_OR_PULL','MEMORY_HITS_LIMIT_3_EXCERPT_700']});
    }),
  };
}

/** Explicit output limits narrow already bounded P1 observations. They never
 * broaden source authority or trigger a second scanner/read to fill the limit. */
function narrowToolObservation(observation:SourceObservation,kind:'paths'|'sessions'|'hits',limit:number):SourceObservation {
  let kept=0,omitted=false;
  const summary=observation.summary.filter(line=>{
    const selected=kind==='paths'?line.startsWith('file: '):kind==='hits'?line.startsWith('entry '):!line.startsWith('No active Workroom session');
    if(!selected)return true;if(kept++<limit)return true;omitted=true;return false;
  });
  return {...observation,summary,sourceRevision:observation.sourceRevision?hash(JSON.stringify({source:observation.sourceRevision,kind,limit})):undefined,
    limits:[...observation.limits,...(omitted?[`REQUESTED_${kind.toUpperCase()}_LIMIT_${limit}`]:[])]};
}

/** The five installed P2 operations share P1's source ports and byte budgets.
 * Only validated tester metadata becomes a DAG reference; summaries are never parsed. */
export function createReadToolSourceAdapters(options:ProjectStateBundleSourcesOptions={}):ReadToolSourceAdapters {
  const sources=createProjectStateBundleSources(options);
  const adapter=(operation:ReadToolOperation):ReadToolSourceAdapter=>({async read(binding,input,budget,signal){
    const section=readToolSection(operation);
    try{
      check(signal,budget.deadline);
      if(binding.role!=='dev')throw new SourceReadError('SOURCE_TARGET_INVALID');
      let parsed:ResolvedReadToolInput;
      try{
        const checked=parseReadToolInput(input);
        if(checked.operation!==operation||(checked.operation==='tester.report.read'&&typeof checked.runId!=='string'))throw new Error('Unresolved input');
        parsed=checked as ResolvedReadToolInput;
      }catch{throw new SourceReadError('READ_TOOL_INPUT_INVALID');}
      switch(parsed.operation){
        case 'project.git.read':return {observation:narrowToolObservation(await sources.git.read(binding,{id:'git'},budget,signal),'paths',parsed.pathsLimit??20)};
        case 'workroom.status.read':return {observation:narrowToolObservation(await sources.workroom.read(binding,{id:'workroom'},budget,signal),'sessions',parsed.sessionsLimit??8)};
        case 'memory.reference.read':return {observation:narrowToolObservation(await sources.memory.read(binding,{id:'memory',query:parsed.query},budget,signal),'hits',parsed.limit??3)};
        case 'tester.status.read':return await readTesterStatus(binding,budget,signal);
        case 'tester.report.read':return await readTesterReport(binding,parsed.runId,budget,signal);
      }
    }catch(error){return {observation:failure(section,error)};}
  }});
  return Object.fromEntries(READ_TOOL_OPERATIONS.map(operation=>[operation,adapter(operation)]));
}
