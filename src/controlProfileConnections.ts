import {existsSync,readFileSync,lstatSync,mkdirSync,renameSync,unlinkSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {withOwnedPortalFileLock} from './portalFileLock';
import {appendDurableProjectMemoryFile,fsyncProjectMemoryDirectory} from './projectMemoryDurability';
import {ControlProfileError} from './controlProfileContract';
import {configuredHermesInvocationHomes,installAgentsToZInvocation} from './agentstozInvocationInstaller';
import {agentsToZUseCodexMcpAddArgv,classifyAgentsToZUseCodexMcpEntry} from './agentstozUseCodexMcpEntry';
import {agentsToZUseMcpCommandNeedsUpgrade} from './agentsToZUseMcpLauncher';
export type ControlProfileAgent='codex'|'claude'|'hermes'|'agy';
export type ControlProfileConnection={agent:ControlProfileAgent;state:'configured'|'not-configured'|'unavailable'|'needs-attention';profiles:number;message:string;
 /**
  * 지금도 **동작하는** 우리 항목이지만 옛 모양(앱 번들 경로)이다. 앱을 교체할 때마다 끊기므로 고정
  * 런처로 다시 등록할 수 있다. ⚠️ 「설치 안 됨」으로 보고하지 말 것 — 그건 거짓이다.
  */
 upgradable?:boolean};
type Runner=(argv:string[],cwd:string,timeout:number)=>Promise<{stdout:string;exitCode:number}>;
export type ControlProfileConnectionOptions={home:string;appDataDir:string;
 /** 설정에 적는 명령. 앱 교체를 견디도록 홈 아래 고정 런처를 넘긴다(src/agentsToZUseMcpLauncher.ts). */
 executable:string|null;
 /** 지금 설치된 앱 안의 실행 파일. **옛 모양을 알아보기 위해서만** 쓴다(설정에는 적지 않는다). */
 bundledExecutable?:string|null;
 agents:Partial<Record<ControlProfileAgent,string|null>>;activeHermesHome?:string;run:Runner};
const server='agentstoz_use';
function read(path:string):string|null{
 if(!existsSync(path))return null;const st=lstatSync(path);
 if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.size>2*1024*1024)throw new ControlProfileError('CONTROL_CONNECTION_CONFIG_INVALID','AI 연결 설정 파일을 확인하세요.');
 return readFileSync(path,'utf8');
}
function jsonSettingsPath(home:string,agent:'claude'|'agy'){return agent==='claude'?join(home,'.claude.json'):join(home,'.gemini','config','mcp_config.json');}
function parseConfig(raw:string|null,yaml:boolean):Record<string,any>{
 if(raw===null||!raw.trim())return {};
 const value=yaml?Bun.YAML.parse(raw):JSON.parse(raw);
 if(!value||typeof value!=='object'||Array.isArray(value))throw new ControlProfileError('CONTROL_CONNECTION_CONFIG_INVALID','AI 연결 설정 형식을 확인하세요.');return value as Record<string,any>;
}
function configEntry(path:string,yaml:boolean){return parseConfig(read(path),yaml)[yaml?'mcp_servers':'mcpServers']?.[server];}
function compatible(entry:any,executable:string){return entry?.command===executable&&(!entry.args||Array.isArray(entry.args)&&entry.args.length===0)&&entry.disabled!==true;}
/**
 * 이 항목이 **우리가 예전에 적은 것**인가. 그러면 사용자에게 충돌이라고 묻지 않고 조용히 올린다 —
 * 앱 번들 안을 가리키던 옛 모양은 앱을 교체할 때마다 깨지므로 그대로 둘 이유가 없다(2026-10-06).
 * 사용자가 직접 만든 다른 연결은 여전히 손대지 않고 충돌로 보고한다.
 */
function upgradable(entry:any,executable:string,bundled:string|null){
 return !!entry&&entry.disabled!==true&&(!entry.args||Array.isArray(entry.args)&&entry.args.length===0)
  &&agentsToZUseMcpCommandNeedsUpgrade(entry.command,executable,bundled);
}
async function updateConfig(path:string,yaml:boolean,executable:string,bundled:string|null){
 mkdirSync(dirname(path),{recursive:true});
 return withOwnedPortalFileLock(`${path}.agentstoz.lock`,async()=>{
  const before=read(path),data=parseConfig(before,yaml),key=yaml?'mcp_servers':'mcpServers';
  if(data[key]!==undefined&&(!data[key]||typeof data[key]!=='object'||Array.isArray(data[key])))throw new ControlProfileError('CONTROL_CONNECTION_CONFIG_INVALID','기존 MCP 설정을 확인하세요.');
  const existing=data[key]?.[server];if(compatible(existing,executable))return false;
  if(existing&&!upgradable(existing,executable,bundled))throw new ControlProfileError('CONTROL_CONNECTION_CONFLICT','기존 agentstoz_use 연결이 다른 실행 파일 또는 설정을 사용합니다. 기존 연결을 확인하세요.');
  data[key]={...(data[key]??{}),[server]:{command:executable,args:[]}};
  const after=yaml?Bun.YAML.stringify(data):JSON.stringify(data,null,2)+'\n';
  if(read(path)!==before)throw new ControlProfileError('CONTROL_CONNECTION_CHANGED','저장 직전에 AI 설정이 바뀌었습니다. 다시 확인하세요.');
  const temp=`${path}.${randomUUID()}.tmp`;
  try{appendDurableProjectMemoryFile(temp,after);renameSync(temp,path);fsyncProjectMemoryDirectory(dirname(path));}finally{try{unlinkSync(temp);}catch{}}
  return true;
 },{attempts:1});
}
export function createControlProfileConnections(options:ControlProfileConnectionOptions){
 const homes=()=>configuredHermesInvocationHomes(options.home,options.activeHermesHome);
 const inspect=async(agent:ControlProfileAgent):Promise<ControlProfileConnection>=>{
  const unavailable={agent,state:'unavailable' as const,profiles:0,message:'CLI와 설치된 AgentsToZ 제어 도구가 필요합니다.'};
  if(!options.executable||!options.agents[agent])return unavailable;
  try{
   const configured={agent,state:'configured' as const,message:'설정 연결됨 · 실행 중인 AI에서 도구 새로고침 후 실제 호출을 확인하세요.'};
   let entries:any[]=[];
   if(agent==='codex'){
    // Same judgement as the Buzz bootstrap installer: an env controller pin is optional.
    const result=await options.run([options.agents.codex!,'mcp','get',server,'--json'],options.home,5000);
    const verdict=classifyAgentsToZUseCodexMcpEntry(result.exitCode===0?JSON.parse(result.stdout):null,
     {executable:options.executable,bundledExecutable:options.bundledExecutable??null});
    if(verdict==='ready')return {...configured,profiles:1};
    // `outdated` 는 **우리가 적은 옛 모양**이다 — 지금도 동작하므로 「설치 안 됨」이 아니라 「설정됨 ·
    // 올릴 수 있음」이고, 사용자에게 충돌이라고 묻지 않고 다시 적는다.
    if(verdict==='outdated')return {...configured,profiles:1,upgradable:true,
     message:'연결돼 있습니다. 앱 업데이트에도 끊기지 않도록 고정 경로로 다시 등록할 수 있습니다.'};
    return verdict==='missing'
     ?{agent,state:'not-configured',profiles:0,message:'AgentsToZ MCP 연결을 준비하세요.'}
     :{agent,state:'needs-attention',profiles:1,message:'AgentsToZ MCP 연결을 준비하세요.'};
   }else if(agent==='hermes'){entries=homes().map(home=>configEntry(join(home,'config.yaml'),true));if(entries.length===0)return unavailable;}
   else entries=[configEntry(jsonSettingsPath(options.home,agent),false)];
   const ready=entries.length>0&&entries.every(entry=>compatible(entry,options.executable!));
   if(ready)return {...configured,profiles:entries.length};
   // 우리가 적은 옛 모양은 충돌이 아니다 — 다시 적어 올린다(아래 updateConfig 가 같은 판정을 쓴다).
   const foreign=entries.some(entry=>entry&&!compatible(entry,options.executable!)
    &&!upgradable(entry,options.executable!,options.bundledExecutable??null));
   const outdated=!foreign&&entries.length>0&&entries.every(entry=>compatible(entry,options.executable!)
    ||upgradable(entry,options.executable!,options.bundledExecutable??null));
   if(outdated)return {...configured,profiles:entries.length,upgradable:true,
    message:'연결돼 있습니다. 앱 업데이트에도 끊기지 않도록 고정 경로로 다시 등록할 수 있습니다.'};
   return {agent,state:foreign?'needs-attention':'not-configured',profiles:entries.length,message:'AgentsToZ MCP 연결을 준비하세요.'};
  }catch{return {agent,state:'needs-attention',profiles:0,message:'기존 AI 설정을 읽지 못했습니다. 설정을 덮어쓰지 않았습니다.'};}
 };
 return {
  list:()=>Promise.all((['codex','claude','hermes','agy'] as const).map(inspect)),
  install:async(agent:ControlProfileAgent)=>{
   if(!['codex','claude','hermes','agy'].includes(agent))throw new ControlProfileError('CONTROL_CONNECTION_AGENT_INVALID','지원하는 AI를 선택하세요.',400);
   if(!options.executable||!options.agents[agent])throw new ControlProfileError('CONTROL_CONNECTION_UNAVAILABLE','AI CLI 또는 AgentsToZ 제어 도구가 없습니다. 설치 후 다시 확인하세요.');
   const current=await inspect(agent);
   if(current.state==='needs-attention')throw new ControlProfileError('CONTROL_CONNECTION_CONFLICT',current.message);
   let changed=false;
   // 옛 모양은 「설정됨」이지만 다시 적어 고정 경로로 올린다.
   if(current.state!=='configured'||current.upgradable){
    if(agent==='codex'){
     const result=await options.run(agentsToZUseCodexMcpAddArgv(options.agents.codex!,options.executable),options.home,10_000);
     if(result.exitCode!==0)throw new ControlProfileError('CONTROL_CONNECTION_INSTALL_FAILED','Codex MCP 연결을 저장하지 못했습니다.');changed=true;
    }else if(agent==='hermes'){
     const configured=homes();if(configured.length===0)throw new ControlProfileError('CONTROL_CONNECTION_UNAVAILABLE','설정된 Hermes 프로필을 찾지 못했습니다.');
     for(const home of configured)changed=await updateConfig(join(home,'config.yaml'),true,options.executable,options.bundledExecutable??null)||changed;
    }else if(agent==='agy'){
     const result=await options.run([options.agents.agy!,'mcp','add',server,options.executable],options.home,10_000);
     if(result.exitCode!==0)throw new ControlProfileError('CONTROL_CONNECTION_INSTALL_FAILED','agy CLI MCP 연결을 저장하지 못했습니다.');changed=true;
    }else changed=await updateConfig(jsonSettingsPath(options.home,agent),false,options.executable,options.bundledExecutable??null);
   }
   installAgentsToZInvocation({home:options.home,hermesHomes:agent==='hermes'?homes():[]});
   const connection=await inspect(agent);
   if(connection.state!=='configured')throw new ControlProfileError('CONTROL_CONNECTION_VERIFY_FAILED','저장 후 AI 연결 설정을 확인하지 못했습니다.');
   return {connection,changed,executionVerified:false};
  },
 };
}
