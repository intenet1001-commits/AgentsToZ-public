import {afterEach,expect,test} from 'bun:test';
import {existsSync,mkdirSync,mkdtempSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {initializeProjectMemory} from '../project-memory-server';
import {resolveAppDataDir} from '../src/appDataDir';
import {CORRECTION_OUTCOME_PIPELINE_ENABLED,correctionOutcomePipelineActive} from '../src/projectMemoryCorrectionOutcome';
import {startTestApiServer} from './startTestApiServer';

/**
 * Served-path checks for the correction-outcome pipeline. The real API runs on a disposable HOME; nothing here touches
 * the real app data, calls a model or opens a provider.
 */
const roots:string[]=[],children:Bun.Subprocess[]=[];
const CAPABILITY='c'.repeat(64),TAURI_ORIGIN='http://tauri.localhost';
afterEach(async()=>{
 for(const child of children.splice(0)){try{child.kill();}catch{}await child.exited.catch(()=>undefined);}
 for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});
});
async function servedFixture(extraEnv:Record<string,string>={}){
 const home=realpathSync(mkdtempSync(join(tmpdir(),'agentstoz-outcome-served-')));roots.push(home);
 const project=join(home,'projects','demo');mkdirSync(project,{recursive:true});
 Bun.spawnSync(['git','init','-q'],{cwd:project});
 initializeProjectMemory({folderPath:project,projectName:'Outcome Served',autoBackup:false});
 const env:Record<string,string|undefined>={...process.env,HOME:home,APPDATA:join(home,'AppData','Roaming'),XDG_CONFIG_HOME:join(home,'.config'),
  NODE_ENV:'test',PORTMGR_ALLOWED_ORIGINS:'',PORTMGR_BUNDLED_SIDECAR:'1',PORTMGR_PARENT_PID:String(process.pid),
  PORTMGR_WHAT_I_SAID_CAPABILITY:'a'.repeat(64),PORTMGR_REMOTE_CONTROL_CAPABILITY:'b'.repeat(64),PORTMGR_AGENT_RUNTIME_CAPABILITY:CAPABILITY,
  AGENTSTOZ_SKIP_HERMES_SYNC:'1',AGENTSTOZ_SKIP_MCP_CONNECTION_SYNC:'1',...extraEnv};
 env.APP_DATA_DIR=resolveAppDataDir(process.platform,env as NodeJS.ProcessEnv,home);
 mkdirSync(env.APP_DATA_DIR!,{recursive:true,mode:0o700});
 writeFileSync(join(env.APP_DATA_DIR!,'ports.json'),JSON.stringify([{id:'project_demo_12345678',name:'Demo',folderPath:project}]));
 const {baseUrl,child}=await startTestApiServer({cwd:join(import.meta.dir,'..'),env});children.push(child);
 const request=async(path:string,body:unknown,headers:Record<string,string>={Origin:TAURI_ORIGIN,'X-AgentsToZ-Agent-Runtime-Capability':CAPABILITY})=>{
  const response=await fetch(baseUrl+path,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
  const text=await response.text();return {status:response.status,body:text?JSON.parse(text):{}};
 };
 return {home,project,appData:env.APP_DATA_DIR!,baseUrl,request,storeDir:join(env.APP_DATA_DIR!,'correction-outcomes-v1')};
}

test('the process switch can only turn the pipeline off',()=>{
 expect(correctionOutcomePipelineActive({},true)).toBe(true);
 expect(correctionOutcomePipelineActive({AGENTSTOZ_CORRECTION_OUTCOMES:'off'},true)).toBe(false);
 // Nothing in the environment turns a pipeline on that the build has off.
 for(const value of ['on','1','true','yes'])expect(correctionOutcomePipelineActive({AGENTSTOZ_CORRECTION_OUTCOMES:value},false)).toBe(false);
 expect(correctionOutcomePipelineActive({},false)).toBe(false);
 expect(correctionOutcomePipelineActive({})).toBe(CORRECTION_OUTCOME_PIPELINE_ENABLED);
});

test('switched off, the served quality path never creates or opens the outcome store',async()=>{
 const f=await servedFixture({AGENTSTOZ_CORRECTION_OUTCOMES:'off'});
 const quality=await f.request('/api/project-memory/quality',{folderPath:f.project});
 expect(quality.status).toBe(200);
 expect(quality.body.correctionOutcomes).toBeNull();
 expect(existsSync(f.storeDir)).toBe(false);
},30_000);

test('only the local management route reaches attestation; a plain local POST is refused before the store opens',async()=>{
 const f=await servedFixture();
 const path='/api/agent-runtime/correction-outcomes',list={operation:'list',folderPath:f.project,requestId:crypto.randomUUID()};
 const attest={operation:'attest',unitId:'a'.repeat(64),verdict:'avoided',requestId:crypto.randomUUID()};
 // No capability, another surface's capability, a foreign origin, a query string or GET: refused at the gate.
 for(const headers of [{},{Origin:TAURI_ORIGIN},{Origin:TAURI_ORIGIN,'X-AgentsToZ-Agent-Runtime-Capability':'b'.repeat(64)},
  {Origin:'https://example.invalid','X-AgentsToZ-Agent-Runtime-Capability':CAPABILITY}] as Record<string,string>[]){
  expect((await f.request(path,attest,headers)).status).toBe(403);
 }
 expect((await f.request(path+'?operation=attest',attest)).status).toBe(403);
 expect((await fetch(f.baseUrl+path,{headers:{Origin:TAURI_ORIGIN,'X-AgentsToZ-Agent-Runtime-Capability':CAPABILITY}})).status).toBe(403);
 expect(existsSync(f.storeDir)).toBe(false);
 // A body over the bound is refused without being parsed.
 const big=await f.request(path,{...list,folderPath:'/'+'x'.repeat(9000)});
 expect(big.status).toBe(413);
 const listed=await f.request(path,list);
 if(CORRECTION_OUTCOME_PIPELINE_ENABLED){
  expect(listed.status).toBe(200);expect(listed.body).toMatchObject({ok:true,operation:'list',units:[],truncated:false});
  const unknown=await f.request(path,attest);
  expect(unknown.status).toBe(404);expect(unknown.body.code).toBe('CORRECTION_OUTCOME_UNIT_NOT_FOUND');
 }else{
  expect(listed.status).toBe(409);expect(listed.body.code).toBe('CORRECTION_OUTCOMES_DISABLED');
  expect(existsSync(f.storeDir)).toBe(false);
 }
},30_000);

test('switched off, the management route refuses and still never creates the store',async()=>{
 const f=await servedFixture({AGENTSTOZ_CORRECTION_OUTCOMES:'off'});
 const path='/api/agent-runtime/correction-outcomes';
 for(const body of [{operation:'list',folderPath:f.project,requestId:crypto.randomUUID()},{operation:'attest',unitId:'a'.repeat(64),verdict:'repeated',requestId:crypto.randomUUID()}]){
  const result=await f.request(path,body);
  expect(result.status).toBe(409);expect(result.body.code).toBe('CORRECTION_OUTCOMES_DISABLED');
 }
 expect(existsSync(f.storeDir)).toBe(false);
},30_000);

test('starting the API opens no outcome store; it is created only when the pipeline is on and first asked',async()=>{
 const f=await servedFixture();
 await Bun.sleep(1500);
 expect(existsSync(f.storeDir)).toBe(false);
 const quality=await f.request('/api/project-memory/quality',{folderPath:f.project});
 expect(quality.status).toBe(200);
 expect(existsSync(f.storeDir)).toBe(CORRECTION_OUTCOME_PIPELINE_ENABLED);
 if(CORRECTION_OUTCOME_PIPELINE_ENABLED)expect(quality.body.correctionOutcomes).toMatchObject({exposuresObserved:0,efficacyVerified:false});
 else expect(quality.body.correctionOutcomes).toBeNull();
},30_000);
