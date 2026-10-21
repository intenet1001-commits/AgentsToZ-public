import {createHash} from 'node:crypto';
import {existsSync,lstatSync,readFileSync,readdirSync,realpathSync,mkdirSync,writeFileSync,renameSync} from 'node:fs';
import {join,resolve,relative,dirname,sep} from 'node:path';

export type SdkModule={id:string;path:string;description:string;goals:string[];prepare:'build-and-test'|'inspect-only';entry?:string};
export type SdkCatalog={schemaVersion:1;kind:'sdk-project';memoryId:string;repository:string;autoPrepare:boolean;modules:SdkModule[]};
export type SdkProjectStatus={managed:boolean;catalog?:SdkCatalog;fingerprint?:string;current?:boolean;receipt?:any;skipped?:boolean;state?:string;error?:string};
function identity(url:string):string|null{const m=url.trim().match(/^(?:https:\/\/github\.com\/|git@github\.com:)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);return m?`${m[1]}/${m[2]}`.toLowerCase():null;}
const digest=(data:string|Buffer)=>createHash('sha256').update(data).digest('hex');
function safePath(root:string,path:string):string{
  if(!path||path.includes('\\')||path.split('/').some(p=>!p||p==='.'||p==='..')||path.startsWith('/')||path.includes(':'))throw Error('SDK_RELATIVE_PATH_REQUIRED');
  const full=resolve(root,path);if(!full.startsWith(root+sep))throw Error('SDK_PATH_OUTSIDE_PROJECT');
  let at=root;for(const part of path.split('/')){at=join(at,part);if(existsSync(at)&&lstatSync(at).isSymbolicLink())throw Error('SDK_SYMLINK_REJECTED');}return full;
}
function jsonFile(root:string,path:string){const full=safePath(root,path);if(lstatSync(full).size>100_000)throw Error('SDK_METADATA_TOO_LARGE');return JSON.parse(readFileSync(full,'utf8'));}
export function readSdkCatalog(root:string):SdkCatalog|null{
  root=realpathSync(root);if(!existsSync(join(root,'.agentstoz/sdk-project.json')))return null;
  const c=jsonFile(root,'.agentstoz/sdk-project.json');
  if(c.schemaVersion!==1||c.kind!=='sdk-project'||!identity(c.repository)||typeof c.autoPrepare!=='boolean'||!Array.isArray(c.modules)||c.modules.length>32||new Set(c.modules.map((m:any)=>m.id)).size!==c.modules.length)throw Error('SDK_CATALOG_UNSUPPORTED');
  const config=jsonFile(root,'.agent-memory/config.json');if(config.memoryId!==c.memoryId)throw Error('SDK_MEMORY_ID_CHANGED');
  for(const m of c.modules){if(!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(m.id)||typeof m.description!=='string'||m.description.length>1000||!Array.isArray(m.goals)||m.goals.length>16||m.goals.some((s:any)=>typeof s!=='string'||s.length>200)||!['build-and-test','inspect-only'].includes(m.prepare))throw Error('SDK_MODULE_INVALID');safePath(root,m.path);if(m.prepare==='build-and-test'){if(typeof m.entry!=='string'||!/^(?:[A-Za-z0-9_][A-Za-z0-9_-]*\/)*[A-Za-z0-9_][A-Za-z0-9_.-]*\.tsx?$/.test(m.entry))throw Error('SDK_ENTRY_INVALID');safePath(safePath(root,m.path),m.entry);}}
  return c;
}
export function sdkFingerprint(root:string,catalog:SdkCatalog):string{
  root=realpathSync(root);const hashes:string[]=[JSON.stringify(catalog)];let count=0,bytes=0;
  const scan=(directory:string)=>{for(const name of readdirSync(directory).sort()){if(['.git','node_modules','dist','build','coverage','.agent-memory','.agentstoz'].includes(name)||name.startsWith('.env'))continue;const full=join(directory,name),st=lstatSync(full);if(st.isSymbolicLink())throw Error('SDK_SYMLINK_REJECTED');if(st.isDirectory())scan(full);else if(st.isFile()){if(++count>1000||(bytes+=st.size)>8_000_000)throw Error('SDK_SCAN_BUDGET_EXCEEDED');hashes.push(relative(root,full),digest(readFileSync(full)));}}};
  for(const m of catalog.modules.filter(m=>m.prepare==='build-and-test'))scan(safePath(root,m.path));return digest(hashes.join('\n'));
}
export function recommendSdkModules(catalog:SdkCatalog,goal:string){const terms=goal.toLowerCase().split(/[\s,.;:/]+/).filter(s=>s.length>1).slice(0,32);return catalog.modules.map(m=>({...m,score:m.goals.reduce((n,s)=>n+terms.filter(t=>s.toLowerCase().includes(t)||t.includes(s.toLowerCase())).length,0)})).filter(m=>m.score>0).sort((a,b)=>b.score-a.score).slice(0,8);}
export function sdkProjectStatus(root:string):SdkProjectStatus{root=realpathSync(root);const catalog=readSdkCatalog(root);if(!catalog)return {managed:false};const file=join(root,'.agentstoz/sdk-management-status.json');let receipt:any=null;if(existsSync(file)){receipt=jsonFile(root,'.agentstoz/sdk-management-status.json');if(receipt.schemaVersion!==1)throw Error('SDK_RECEIPT_UNSUPPORTED');}const fingerprint=sdkFingerprint(root,catalog);return {managed:true,catalog,fingerprint,current:receipt?.fingerprint===fingerprint,receipt};}
type Run=(argv:string[],cwd:string)=>Promise<{exitCode:number;output:string}>;
export async function prepareSdkProject(root:string,options:{bunPath?:string;force?:boolean;run?:Run;signal?:AbortSignal}={}):Promise<SdkProjectStatus>{
  root=realpathSync(root);const status=sdkProjectStatus(root);if(!status.managed)return status;
  const catalog=status.catalog!,bun=options.bunPath??Bun.which('bun');
  const origin=Bun.spawnSync(['git','remote','get-url','origin'],{cwd:root,stdout:'pipe',stderr:'pipe'});if(origin.exitCode!==0||identity(origin.stdout.toString())!==identity(catalog.repository))throw Error('SDK_REPOSITORY_ID_CHANGED');
  const outputsPresent=catalog.modules.filter(m=>m.prepare==='build-and-test').every(m=>{const path=safePath(root,`${m.path}/dist/${m.entry!.split('/').at(-1)!.replace(/\.tsx?$/,'.js')}`);return existsSync(path)&&!lstatSync(path).isSymbolicLink();});
  if(!options.force&&status.current&&(status.receipt?.state!=='ready'||outputsPresent))return {...status,skipped:true};
  if(!bun)return {...status,state:'tool-missing',error:'Bun을 설치한 뒤 SDK 준비를 다시 실행하세요.'};
  const run:Run=options.run??(async(argv,cwd)=>{
    options.signal?.throwIfAborted();
    const env:Record<string,string>={};for(const key of ['PATH','HOME','USER','USERNAME','USERPROFILE','SystemRoot','SYSTEMROOT','TMPDIR','TMP','TEMP','SHELL'])if(process.env[key])env[key]=process.env[key]!;
    const proc=Bun.spawn(argv,{cwd,env,stdout:'pipe',stderr:'pipe',detached:process.platform!=='win32'});const read=async(stream:ReadableStream<Uint8Array>)=>{const reader=stream.getReader();let out='',total=0;while(true){const {done,value}=await reader.read();if(done)break;total+=value.byteLength;if(total<=32_000)out+=new TextDecoder().decode(value);}return out;};
    const kill=()=>{try{if(process.platform!=='win32')process.kill(-proc.pid,'SIGKILL');else proc.kill('SIGKILL');}catch{}};
    const streams=Promise.all([read(proc.stdout),read(proc.stderr)]);const timeout=setTimeout(kill,60_000);options.signal?.addEventListener('abort',kill,{once:true});try{const code=await proc.exited;kill();const output=(await streams).join('\n').slice(0,8000);options.signal?.throwIfAborted();return {exitCode:code,output};}finally{clearTimeout(timeout);options.signal?.removeEventListener('abort',kill);kill();}
  });
  const results:Array<{id:string;state:string;output?:string}>=[];
  for(const m of catalog.modules){if(m.prepare==='inspect-only'){results.push({id:m.id,state:'manual-module'});continue;}const cwd=safePath(root,m.path);let check={exitCode:0,output:''};
    // A newly cloned SDK has no node_modules. Install only its locked dependencies,
    // with lifecycle scripts disabled and the same bounded, credential-free runner.
    if(existsSync(join(cwd,'package.json'))){const pkg=jsonFile(root,`${m.path}/package.json`);if(Object.keys({...pkg.dependencies,...pkg.devDependencies}).length){
      const lock=join(cwd,'bun.lock');if(!existsSync(lock)||lstatSync(lock).isSymbolicLink()||!lstatSync(lock).isFile())throw Error('SDK_DEPENDENCY_LOCK_REQUIRED');
      check=await run([bun,'install','--frozen-lockfile','--ignore-scripts','--no-progress'],cwd);
    }}
    if(check.exitCode===0)check=await run([bun,'build',m.entry!,'--target=browser','--outdir=dist'],cwd);if(check.exitCode===0)check=await run([bun,'test','./tests'],cwd);results.push({id:m.id,state:check.exitCode===0?'ready':'failed',output:check.output});if(check.exitCode!==0)break;}
  if(sdkFingerprint(root,catalog)!==status.fingerprint)throw Error('SDK_SOURCE_CHANGED_DURING_PREPARE');
  const receipt={schemaVersion:1,scope:'configured-automatic-modules',fingerprint:status.fingerprint,state:results.some(r=>r.state==='failed')?'failed':'ready',preparedAt:new Date().toISOString(),results};
  const file=safePath(root,'.agentstoz/sdk-management-status.json');mkdirSync(dirname(file),{recursive:true});const tmp=`file-${crypto.randomUUID()}.tmp`;const staging=join(dirname(file),tmp);writeFileSync(staging,JSON.stringify(receipt,null,2)+'\n',{mode:0o600,flag:'wx'});renameSync(staging,file);return {...status,receipt,current:true};
}
