import {afterEach,expect,test} from 'bun:test';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MacSetupHost,type MacSetupEffects} from '../src/macSetupHost';
import {MAC_SETUP_TOOLS,macSetupPrerequisites,macSetupHandoff,type MacSetupToolId,type MacSetupState} from '../src/macSetupCatalog';
import {handleMacSetup} from '../src/macSetupHttp';
import {macSetupCommand,createMacSetupEffects} from '../src/macSetupEffects';
const dirs:string[]=[];afterEach(()=>dirs.splice(0).forEach(d=>rmSync(d,{recursive:true,force:true})));
const id=()=>crypto.randomUUID();
function fixture(seed:Partial<Record<MacSetupToolId,MacSetupState>>={}){
  const dir=mkdtempSync(join(tmpdir(),'atz-mac-setup-'));dirs.push(dir);const states=new Map<MacSetupToolId,MacSetupState>(Object.entries(seed) as [MacSetupToolId,MacSetupState][]),calls:string[]=[];
  const effects:MacSetupEffects={probe:async tool=>({id:tool,state:states.get(tool)??'missing',message:'synthetic'}),install:async tool=>{calls.push('install:'+tool);states.set(tool,'installed');},launch:async tool=>{calls.push('launch:'+tool);states.set(tool,'running');}};
  const host=new MacSetupHost(dir,effects,true);return {dir,host,states,effects,calls};
}
async function settle(host:MacSetupHost){for(let n=0;n<200;n++){if(!host.status().view.active)return host.status().view;await Bun.sleep(2);}throw Error('Fixture did not settle');}
async function act(f:ReturnType<typeof fixture>,operation:string,selected?:MacSetupToolId[],requestId=id()){return f.host.act({operation,requestId,expectedRevision:f.host.status().view.revision,...(selected?{selected}:{})});}
test('a Mac with no CLI can start inside the app, installs each selected tool once and proves app execution separately',async()=>{
  const f=fixture();await act(f,'start',MAC_SETUP_TOOLS.map(t=>t.id));const view=await settle(f.host);
  expect(view.rows.filter(r=>r.id.endsWith('-app')).every(r=>r.state==='running')).toBe(true);
  expect(view.rows.filter(r=>!r.id.endsWith('-app')).every(r=>r.state==='installed')).toBe(true);
  expect(new Set(f.calls.filter(c=>c.startsWith('install'))).size).toBe(14);
  f.calls.length=0;await act(f,'start',MAC_SETUP_TOOLS.map(t=>t.id));await settle(f.host);expect(f.calls).toEqual([]);
  const raw=readFileSync(join(f.dir,'mac-setup/progress.json'),'utf8');expect(raw).not.toContain('token');expect(raw).not.toContain('command');
});
test('partially installed tools and an unrecognized existing executable are preserved',async()=>{
  const f=fixture({codex:'installed',github:'installed',node:'installed'});await act(f,'start',['codex','github']);const view=await settle(f.host);
  expect(f.calls).toEqual([]);expect(view.rows.find(r=>r.id==='github')?.state).toBe('installed');
});
test('an OS installation screen or a failed app launch never counts as installation or execution success',async()=>{
  const f=fixture();f.effects.install=async()=>{};await act(f,'start',['node','vercel']);let view=await settle(f.host);
  expect(view.rows.find(r=>r.id==='node')?.state).toBe('needs-action');expect(view.rows.find(r=>r.id==='vercel')?.state).toBe('unknown');
  f.states.set('codex-app','installed');f.effects.launch=async()=>{};await act(f,'start',['codex-app']);view=await settle(f.host);expect(view.rows.find(r=>r.id==='codex-app')?.state).toBe('needs-action');
});
test('lost admission replies and concurrent presses do not duplicate an installer; cancellation is followed by readback',async()=>{
  const f=fixture(),requestId=id();let release!:()=>void;
  f.effects.install=(_tool,signal)=>new Promise((resolve,reject)=>{release=resolve;signal.addEventListener('abort',()=>reject(Error('cancelled')),{once:true});});
  await act(f,'start',['github'],requestId);await Bun.sleep(5);await act(f,'start',['github'],requestId);
  await expect(act(f,'start',['github'])).rejects.toThrow();
  await f.host.act({operation:'cancel',expectedRevision:f.host.status().view.revision});release();const view=await settle(f.host);expect(view.rows.find(r=>r.id==='github')?.state).toBe('cancelled');
  f.effects.install=async tool=>{f.calls.push('install:'+tool);f.states.set(tool,'installed');};await act(f,'inspect');await settle(f.host);await act(f,'start',['github']);await settle(f.host);expect(f.calls).toEqual(['install:github']);
});
test('restart discloses interruption and performs no mutation until an explicit action',async()=>{
  const f=fixture();await act(f,'inspect');await settle(f.host);const file=join(f.dir,'mac-setup/progress.json'),d=JSON.parse(readFileSync(file,'utf8'));d.active=true;d.ownerPid=2147483000;d.rows[0].state='installing';writeFileSync(file,JSON.stringify(d),{mode:0o600});
  const resumed=new MacSetupHost(f.dir,f.effects,true);expect(resumed.status().view.active).toBe(false);expect(resumed.status().view.rows[0]?.state).toBe('needs-action');expect(f.calls).toEqual([]);
  await resumed.act({operation:'inspect',requestId:id(),expectedRevision:d.revision});const view=await settle(resumed);expect(view.rows[0]?.state).toBe('missing');expect(f.calls).toEqual([]);
});
test('an orphaned metadata admission is recovered, while a live owner is never unlocked',async()=>{
  const f=fixture();mkdirSync(join(f.dir,'mac-setup'));const lock=join(f.dir,'mac-setup/progress.json.lock');
  writeFileSync(lock,'v3:2147483000:'+'a'.repeat(32)+':guarded',{mode:0o600});await act(f,'inspect');await settle(f.host);expect(f.calls).toEqual([]);
  writeFileSync(lock,`v3:${process.pid}:`+'b'.repeat(32)+':guarded',{mode:0o600});await expect(act(f,'start',['github'])).rejects.toThrow();expect(readFileSync(lock,'utf8')).toContain(String(process.pid));
});
test('network failure remains separate from a successful remaining tool and the handoff contains only bounded status',async()=>{
  const f=fixture();f.effects.install=async tool=>{if(tool==='github')throw Error('secret provider details');f.states.set(tool,'installed');};await act(f,'start',['github','supabase']);const view=await settle(f.host);
  expect(view.rows.find(r=>r.id==='github')?.state).toBe('failed');expect(view.rows.find(r=>r.id==='supabase')?.state).toBe('installed');const text=macSetupHandoff(view);expect(text).not.toContain('secret provider details');expect(text).toContain('revision');expect(text).toContain('프로젝트 권한');
});
test('the catalog has precisely four AI CLIs, four service CLIs and adds only required runtimes',()=>{
  expect(MAC_SETUP_TOOLS.filter(t=>t.group==='AI CLI').map(t=>t.id)).toEqual(['codex','claude','hermes','agy']);
  expect(MAC_SETUP_TOOLS.filter(t=>t.group==='서비스 CLI').map(t=>t.id)).toEqual(['github','vercel','supabase','google-workspace']);
  expect(macSetupPrerequisites(['vercel'])).toEqual(['node','vercel']);expect(macSetupPrerequisites(['hermes'])).toEqual(['git','hermes']);
});
test('a verified AI app can receive the handoff while the remaining installation stays in its original queue',async()=>{
  const f=fixture({'codex-app':'running'});let release!:()=>void;
  await act(f,'inspect');await settle(f.host);
  f.effects.install=tool=>new Promise(resolve=>{release=()=>{f.states.set(tool,'installed');resolve();};});
  await act(f,'start',['github']);await Bun.sleep(5);const requestId=f.host.status().view.requestId;
  await act(f,'focus',['codex-app']);expect(f.host.status().view.active).toBe(true);expect(f.host.status().view.requestId).toBe(requestId);expect(f.calls).toEqual(['launch:codex-app']);release();await settle(f.host);
});
test('subprocess argv stay literal, output is bounded and cancellation ends the owned process group',async()=>{
  const literal='$(touch /tmp/atz-must-not-exist)';expect(await macSetupCommand('/usr/bin/printf',['%s',literal],process.env)).toBe(literal);
  const signal=new AbortController();const pending=macSetupCommand(process.execPath,['-e','setInterval(()=>{},1000)'],process.env,signal.signal);signal.abort();await expect(pending).rejects.toThrow();
  await expect(macSetupCommand(process.execPath,['-e','process.stdout.write("x".repeat(600000))'],process.env)).rejects.toThrow();
});
test('only the authenticated native onboarding capability admits fixed operations and tool ids',async()=>{
  const f=fixture(),cap='a'.repeat(64),make=(body:unknown,headers:Record<string,string>={})=>new Request('http://127.0.0.1/api/onboarding/mac-setup',{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
  expect((await handleMacSetup(make({operation:'status'}),cap,()=>f.host)).status).toBe(403);
  expect((await handleMacSetup(make({operation:'status'},{'X-AgentsToZ-Onboarding-Capability':cap,origin:'tauri://localhost'}),cap,()=>f.host)).status).toBe(403);
  expect((await handleMacSetup(make({operation:'start',expectedRevision:0,requestId:id(),selected:['shell'],command:'rm'},{'X-AgentsToZ-Onboarding-Capability':cap}),cap,()=>f.host)).status).toBe(409);
  expect((await handleMacSetup(make({operation:'status'},{'X-AgentsToZ-Onboarding-Capability':cap}),cap,()=>f.host)).status).toBe(200);
});

test('native probes retain a v-prefixed version and isolate distinct empty npm configurations',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'atz-mac-probe-'));dirs.push(dir);const bin=join(dir,'bin');mkdirSync(bin);
  writeFileSync(join(bin,'hermes'),"#!/bin/sh\nprintf 'Hermes v0.22.2+1239.g7b959c9\\n'\n",{mode:0o755});
  writeFileSync(join(bin,'node'),"#!/bin/sh\nprintf 'v24.1.0\\n'\n",{mode:0o755});
  writeFileSync(join(bin,'npm'),'#!/bin/sh\n[ "$NPM_CONFIG_USERCONFIG" != "$NPM_CONFIG_GLOBALCONFIG" ] && [ -f "$NPM_CONFIG_USERCONFIG" ] && [ -f "$NPM_CONFIG_GLOBALCONFIG" ] && [ ! -s "$NPM_CONFIG_USERCONFIG" ] && [ ! -s "$NPM_CONFIG_GLOBALCONFIG" ] || exit 1\nprintf "11.19.0\\n"\n',{mode:0o755});
  const effects=createMacSetupEffects(dir,dir,{searchPaths:[bin]});
  expect((await effects.probe('hermes')).message).toContain('0.22.2+1239.g7b959c9');
  expect((await effects.probe('node')).state).toBe('installed');
});
