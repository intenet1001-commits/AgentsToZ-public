import {existsSync,readFileSync,lstatSync,mkdirSync,renameSync,unlinkSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {withOwnedPortalFileLock} from './portalFileLock';
import {appendDurableProjectMemoryFile,fsyncProjectMemoryDirectory} from './projectMemoryDurability';
import {ControlProfileError} from './controlProfileContract';
import {configuredHermesInvocationHomes,installAgentsToZInvocation} from './agentstozInvocationInstaller';
export type ControlProfileAgent='codex'|'claude'|'hermes'|'agy';
export type ControlProfileConnection={agent:ControlProfileAgent;state:'configured'|'not-configured'|'unavailable'|'needs-attention';profiles:number;message:string};
type Runner=(argv:string[],cwd:string,timeout:number)=>Promise<{stdout:string;exitCode:number}>;
export type ControlProfileConnectionOptions={home:string;appDataDir:string;executable:string|null;agents:Partial<Record<ControlProfileAgent,string|null>>;activeHermesHome?:string;run:Runner};
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
async function updateConfig(path:string,yaml:boolean,executable:string){
 mkdirSync(dirname(path),{recursive:true});
 return withOwnedPortalFileLock(`${path}.agentstoz.lock`,async()=>{
  const before=read(path),data=parseConfig(before,yaml),key=yaml?'mcp_servers':'mcpServers';
  if(data[key]!==undefined&&(!data[key]||typeof data[key]!=='object'||Array.isArray(data[key])))throw new ControlProfileError('CONTROL_CONNECTION_CONFIG_INVALID','기존 MCP 설정을 확인하세요.');
  const existing=data[key]?.[server];if(compatible(existing,executable))return false;
  if(existing)throw new ControlProfileError('CONTROL_CONNECTION_CONFLICT','기존 agentstoz_use 연결이 다른 실행 파일 또는 설정을 사용합니다. 기존 연결을 확인하세요.');
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
   let entries:any[]=[];
   if(agent==='codex'){
    const result=await options.run([options.agents.codex!,'mcp','get',server,'--json'],options.home,5000);
    if(result.exitCode===0){const config=JSON.parse(result.stdout);entries=[config.enabled===false?{disabled:true}:config.transport];}
   }else if(agent==='hermes'){entries=homes().map(home=>configEntry(join(home,'config.yaml'),true));if(entries.length===0)return unavailable;}
   else entries=[configEntry(jsonSettingsPath(options.home,agent),false)];
   const ready=entries.length>0&&entries.every(entry=>compatible(entry,options.executable!));
   return {agent,state:ready?'configured':entries.some(entry=>entry&&!compatible(entry,options.executable!))?'needs-attention':'not-configured',profiles:entries.length,message:ready?'설정 연결됨 · 실행 중인 AI에서 도구 새로고침 후 실제 호출을 확인하세요.':'AgentsToZ MCP 연결을 준비하세요.'};
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
   if(current.state!=='configured'){
    if(agent==='codex'){
     const result=await options.run([options.agents.codex!,'mcp','add',server,'--',options.executable],options.home,10_000);
     if(result.exitCode!==0)throw new ControlProfileError('CONTROL_CONNECTION_INSTALL_FAILED','Codex MCP 연결을 저장하지 못했습니다.');changed=true;
    }else if(agent==='hermes'){
     const configured=homes();if(configured.length===0)throw new ControlProfileError('CONTROL_CONNECTION_UNAVAILABLE','설정된 Hermes 프로필을 찾지 못했습니다.');
     for(const home of configured)changed=await updateConfig(join(home,'config.yaml'),true,options.executable)||changed;
    }else if(agent==='agy'){
     const result=await options.run([options.agents.agy!,'mcp','add',server,options.executable],options.home,10_000);
     if(result.exitCode!==0)throw new ControlProfileError('CONTROL_CONNECTION_INSTALL_FAILED','agy CLI MCP 연결을 저장하지 못했습니다.');changed=true;
    }else changed=await updateConfig(jsonSettingsPath(options.home,agent),false,options.executable);
   }
   installAgentsToZInvocation({home:options.home,hermesHomes:agent==='hermes'?homes():[]});
   const connection=await inspect(agent);
   if(connection.state!=='configured')throw new ControlProfileError('CONTROL_CONNECTION_VERIFY_FAILED','저장 후 AI 연결 설정을 확인하지 못했습니다.');
   return {connection,changed,executionVerified:false};
  },
 };
}
