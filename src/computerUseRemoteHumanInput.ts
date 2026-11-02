/**
 * A person controlling this Mac from another device through AgentsToZ Screen goes first (DESIGN mac-to-mac SR-34, 6.7).
 * Screen writes `remote-input.json` at most every 2 s while it injects a phone's or controller's input
 * (`{format:1, lastInputAt, session}`, 0600, temp file → rename) and removes it when that session ends. Before
 * computer use sends any input to Control — the whole-Mac scope (computerUseScopeHost.ts) and the one-window tool
 * (computerUseHost.ts) alike — a record within the last 12 s while Screen runs refuses the AI action
 * before dispatch, in the shape of the Control bar's 「직접 하기」 (person-has-control: not dispatched, not halted, no
 * recovery row). Observe and capture are not affected, so watching an AI from the phone keeps working. The sidecar
 * (api-server.ts) passes the real reader; a runtime built without one reads nothing (tests stay off this Mac's file).
 *
 * The file is a hint any process of this user can write: forging it only refuses the AI (the safe side) and removing it
 * is today's state. A missing, unreadable, oversized or malformed file, an old time, or Screen not running all let the
 * action through — the person's own Control bar and Control's guards still apply.
 */
import {execFile} from 'node:child_process';
import {readFile,stat} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';

/** Minimum time after a remote person's last input the AI keeps its hands off (S-C1 may tune it). */
export const REMOTE_HUMAN_INPUT_WINDOW_MS=10_000;
/** Screen coalesces writes for this long; the latest input may be this much newer than the file. */
export const REMOTE_HUMAN_INPUT_WRITE_INTERVAL_MS=2_000;
/** Screen writes a few dozen bytes; anything larger is not its file. */
const FILE_LIMIT=4096;
/** The Screen helper's process name as `pgrep -x` sees it (src-tauri/src/screen_helper.rs EXECUTABLE). */
const SCREEN_EXECUTABLE='AgentsToZScreen';
/**
 * What an AI reads when its input was held. status never shows this hold (it is read only before input), so the AI is
 * told to try again after the 10 s window with a new observation, not to poll status. `remoteCaller`: the AI is on
 * another Mac, so the held Mac is 「그 Mac」. `window`: the v1 one-window tool, which has no request-access.
 */
export function remoteHumanInputGuidance(options:{remoteCaller?:boolean;window?:boolean}={}){
  const mac=options.remoteCaller?'그 Mac':'이 Mac';
  const keep=options.window?'허용은 그대로이니 같은 요청 ID를 다시 보내지 마세요.':'허용은 그대로이니 request-access를 다시 하지 말고 같은 요청 ID도 다시 보내지 마세요.';
  return `다른 기기에서 사람이 AgentsToZ Screen으로 ${mac}을 조작하고 있어 이 동작은 보내지 않았습니다(person-has-control). ${keep} 사람의 입력이 10초 동안 없어야 다시 됩니다. 기록 간격 때문에 최대 약 12초 기다릴 수 있습니다. status에는 이 상태가 나오지 않으니, 약 12초 뒤 새로 observe한 뒤 새 요청 ID로 보내세요.`;
}
export const REMOTE_HUMAN_INPUT_GUIDANCE=remoteHumanInputGuidance();

export interface RemoteHumanInput {session:string;lastInputAt:number}
/** null: no remote person input to respect right now (or nothing could be read, which is the same as today). */
export type RemoteHumanInputReader=()=>Promise<RemoteHumanInput|null>;
export const noRemoteHumanInput:RemoteHumanInputReader=async()=>null;

/** The file's content: format 1, a positive integer time, a short lowercase session word. Extra keys are a newer Screen's. */
export function parseRemoteHumanInput(text:string):RemoteHumanInput|null{
  let value:unknown;try{value=JSON.parse(text);}catch{return null;}
  if(!value||typeof value!=='object'||Array.isArray(value))return null;
  const o=value as Record<string,unknown>;
  if(o.format!==1||!Number.isSafeInteger(o.lastInputAt)||(o.lastInputAt as number)<=0||typeof o.session!=='string'||!/^[a-z][a-z-]{0,31}$/.test(o.session))return null;
  return {session:o.session,lastInputAt:o.lastInputAt as number};
}
/**
 * A stored time can trail the latest input by just under Screen's write interval. Include that interval on the past
 * side so every input is held for at least the window, at the cost of up to two seconds of additional waiting. A time
 * further ahead than the window is ignored, so a clock set back cannot hold the AI off indefinitely.
 */
export function remoteHumanInputRecent(input:RemoteHumanInput,now:number,windowMs=REMOTE_HUMAN_INPUT_WINDOW_MS){
  const age=now-input.lastInputAt;return age<windowMs+REMOTE_HUMAN_INPUT_WRITE_INTERVAL_MS&&age>-windowMs;
}

type Run=(file:string,args:readonly string[])=>Promise<{code:number}>;
const runFile:Run=(file,args)=>new Promise((resolve,reject)=>{
  execFile(file,[...args],{timeout:2_000,maxBuffer:64*1024,env:{PATH:'/usr/bin:/bin:/usr/sbin:/sbin',LANG:'C'}},(error)=>{
    if(!error)return resolve({code:0});
    // A timeout kills the child (signal, no numeric code): not a clean answer.
    const code=(error as {code?:unknown}).code;
    typeof code==='number'?resolve({code}):reject(error);
  });
});
/**
 * `pgrep -x AgentsToZScreen`: exit 1 is "none running". Anything else that is not a clean answer (a timeout, a missing
 * tool) counts as running — it only matters inside the 10 s window, where refusing is the person-first side.
 */
export function screenHelperRunning(run:Run=runFile):()=>Promise<boolean>{
  return async()=>{
    try{const answer=await run('/usr/bin/pgrep',['-x',SCREEN_EXECUTABLE]);
      return answer.code!==1;}
    catch{return true;}
  };
}
export function remoteHumanInputPath(home=homedir()){return join(home,'Library','Application Support','AgentsToZ Screen','remote-input.json');}

/**
 * The production reader (macOS only). The file is read first; Screen's process is asked about only when the file shows
 * input inside the window, so an ordinary action costs one stat.
 */
export function createRemoteHumanInputReader(deps:{platform?:NodeJS.Platform;path?:string;now?:()=>number;readText?:(path:string)=>Promise<string|null>;screenRunning?:()=>Promise<boolean>}={}):RemoteHumanInputReader{
  const platform=deps.platform??process.platform,now=deps.now??Date.now,path=deps.path??remoteHumanInputPath();
  const readText=deps.readText??(async(file:string)=>{
    let info;try{info=await stat(file);}catch{return null;}
    if(!info.isFile()||info.size>FILE_LIMIT)return null;
    try{return await readFile(file,'utf8');}catch{return null;}
  });
  const running=deps.screenRunning??screenHelperRunning();
  return async()=>{
    if(platform!=='darwin')return null;
    let text:string|null;try{text=await readText(path);}catch{return null;}
    if(text===null||text.length>FILE_LIMIT)return null;
    const input=parseRemoteHumanInput(text);
    if(!input||!remoteHumanInputRecent(input,now()))return null;
    return await running()?input:null;
  };
}
