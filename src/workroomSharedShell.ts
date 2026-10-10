import {randomUUID} from 'node:crypto';
import {terminalOutputPage} from './aiTerminalOutput';
import type {AiTerminalResolvedTarget} from './aiTerminalService';
import type {AiTerminalSummary} from './aiTerminalProtocol';

type Pty={write(data:string):number;resize(cols:number,rows:number):void;close():void};
type Child={pid:number;terminal:Pty;exited:Promise<number>;kill(signal?:number|string):void};
type ShellView={id:string;workroomSessionId:string;targetId:string;createdAt:string;state:'running'|'exited';exitCode:number|null;cols:number;rows:number;aiAllowed:boolean};
type Shell={id:string;workroomSessionId:string;targetId:string;cwd:string;createdAt:string;state:'running'|'exited';exitCode:number|null;cols:number;rows:number;aiAllowed:boolean;userDraft:string;child:Child;revalidate?:AiTerminalResolvedTarget['revalidate'];chunks:{seq:number;text:string}[];next:number;buffered:number;decoder:TextDecoder;requests:Map<string,{text:string;promise:Promise<{shell:ShellView}>}>;queue:Promise<unknown>;closing:boolean};
type Request={operation:'shell.status'|'shell.start'|'shell.read'|'shell.input'|'shell.resize'|'shell.close'|'shell.allow-ai';sessionId:string;targetId:string;requestId?:string;shellId?:string;after?:number;data?:string;cols?:number;rows?:number;enabled?:boolean};
const id=(value:unknown)=>typeof value==='string'&&/^[A-Za-z0-9_-]{8,160}$/.test(value);
const bounded=(value:unknown,min:number,max:number)=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=min&&value<=max;
export function parseSharedShellRequest(value:unknown):Request {
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('공용 터미널 요청을 확인하세요.');
  const row=value as Record<string,unknown>,operation=row.operation;
  const fields:Record<string,string[]>={
    'shell.status':[],'shell.start':['cols','rows'],'shell.read':['after'],'shell.input':['requestId','shellId','data'],
    'shell.resize':['cols','rows'],'shell.close':[],'shell.allow-ai':['enabled'],
  };
  if(typeof operation!=='string'||!fields[operation]||!id(row.sessionId)||!id(row.targetId)||Object.keys(row).some(key=>!['operation','sessionId','targetId',...fields[operation]!].includes(key)))throw Error('공용 터미널 요청을 확인하세요.');
  if(operation==='shell.start'||operation==='shell.resize')if(!bounded(row.cols,20,300)||!bounded(row.rows,5,150))throw Error('터미널 크기를 확인하세요.');
  if(operation==='shell.read'&&row.after!==undefined&&!bounded(row.after,0,Number.MAX_SAFE_INTEGER))throw Error('출력 읽기 위치를 확인하세요.');
  if(operation==='shell.input'&&(!id(row.requestId)||!id(row.shellId)||typeof row.data!=='string'||!row.data||new TextEncoder().encode(row.data).length>4096))throw Error('터미널 입력을 확인하세요.');
  if(operation==='shell.allow-ai'&&typeof row.enabled!=='boolean')throw Error('AI 입력 허용값을 확인하세요.');
  return row as Request;
}

/** One local PTY per Workroom AI session. No wire path, remote grant or implicit AI input. */
export class WorkroomSharedShell {
  private shells=new Map<string,Shell>();
  private starts=new Map<string,Promise<Shell>>();
  private stopped=false;
  constructor(private dependencies:{resolveTarget(id:string):Promise<AiTerminalResolvedTarget>;runningSession(id:string):AiTerminalSummary|null;spawn?:(args:string[],options:Record<string,unknown>)=>Child;signalGroup?:(pid:number,signal:NodeJS.Signals)=>void;env?:Record<string,string|undefined>}){}
  private summary(shell:Shell):ShellView{return {id:shell.id,workroomSessionId:shell.workroomSessionId,targetId:shell.targetId,createdAt:shell.createdAt,state:shell.state,exitCode:shell.exitCode,cols:shell.cols,rows:shell.rows,aiAllowed:shell.aiAllowed&&!!this.dependencies.runningSession(shell.workroomSessionId)};}
  private get(sessionId:string,targetId:string){const shell=this.shells.get(sessionId);if(!shell||shell.targetId!==targetId)throw Error('이 워크룸의 공용 터미널을 찾지 못했습니다.');return shell;}
  private signal(shell:Shell,signal:NodeJS.Signals){try{if(this.dependencies.signalGroup)this.dependencies.signalGroup(shell.child.pid,signal);else process.kill(-shell.child.pid,signal);}catch{/* Already exited. */}}
  private async start(request:Request):Promise<Shell>{
    const prior=this.shells.get(request.sessionId);if(prior){if(prior.targetId!==request.targetId)throw Error('터미널 프로젝트가 변경되었습니다.');return prior;}
    const pending=this.starts.get(request.sessionId);if(pending)return pending;
    const run=(async()=>{
      if(this.stopped)throw Error('터미널 서버가 종료 중입니다.');
      const parent=this.dependencies.runningSession(request.sessionId);
      if(!parent||parent.targetId!==request.targetId)throw Error('실행 중인 워크룸 AI 세션을 선택하세요.');
      if([...this.shells.values()].filter(shell=>shell.state==='running').length>=4)throw Error('공용 터미널은 최대 4개까지 열 수 있습니다.');
      const target=await this.dependencies.resolveTarget(request.targetId);
      await target.revalidate?.();
      if(this.stopped||this.dependencies.runningSession(request.sessionId)?.targetId!==request.targetId)throw Error('워크룸 세션이 종료되었습니다.');
      // Another session may have started while target resolution was awaiting disk work.
      if([...this.shells.values()].filter(shell=>shell.state==='running').length>=4)throw Error('공용 터미널은 최대 4개까지 열 수 있습니다.');
      const env:Record<string,string|undefined>={...(this.dependencies.env??process.env),TERM:'xterm-256color',COLORTERM:'truecolor'};
      if(!env.LANG&&!env.LC_ALL&&!env.LC_CTYPE)env.LANG='en_US.UTF-8';
      for(const name of Object.keys(env))if(/^(PORTMGR_|AGENTSTOZ_).*CAPABILITY|^(AGENTSTOZ_VOICE_API_KEY|SUPABASE_SERVICE_ROLE_KEY|VITE_SUPABASE_SERVICE_ROLE_KEY)$/.test(name))delete env[name];
      const shell:Shell={id:randomUUID(),workroomSessionId:request.sessionId,targetId:request.targetId,cwd:target.cwd,createdAt:new Date().toISOString(),state:'running',exitCode:null,cols:request.cols!,rows:request.rows!,aiAllowed:false,userDraft:'',child:null as unknown as Child,revalidate:target.revalidate,chunks:[],next:0,buffered:0,decoder:new TextDecoder(),requests:new Map(),queue:Promise.resolve(),closing:false};
      const append=(text:string)=>{for(let start=0;start<text.length;){let end=Math.min(start+1024,text.length);if(end<text.length&&/[\uD800-\uDBFF]/.test(text[end-1]!))end--;const chunk={seq:++shell.next,text:text.slice(start,end)};shell.chunks.push(chunk);shell.buffered+=chunk.text.length;start=end;}while(shell.buffered>250_000&&shell.chunks.length>1)shell.buffered-=shell.chunks.shift()!.text.length;};
      const spawn=this.dependencies.spawn??((args,options)=>(Bun.spawn as any)(args,options));
      let eof!:()=>void;const streamEnded=new Promise<void>(resolve=>{eof=resolve});
      shell.child=spawn(['/bin/zsh','-l'],{cwd:target.cwd,env,detached:true,terminal:{cols:shell.cols,rows:shell.rows,exit:()=>eof(),data:(_pty:Pty,data:Uint8Array)=>append(shell.decoder.decode(data,{stream:true}))}});
      this.shells.set(request.sessionId,shell);
      void shell.child.exited.then(async code=>{
        let timer:ReturnType<typeof setTimeout>|undefined;
        await Promise.race([streamEnded,new Promise(resolve=>{timer=setTimeout(resolve,1000)})]);clearTimeout(timer);
        append(shell.decoder.decode());shell.state='exited';shell.exitCode=code;shell.aiAllowed=false;shell.child.terminal.close();
      },()=>{shell.state='exited';shell.exitCode=-1;shell.aiAllowed=false;shell.child.terminal.close();});
      return shell;
    })();
    this.starts.set(request.sessionId,run);try{return await run;}finally{if(this.starts.get(request.sessionId)===run)this.starts.delete(request.sessionId);}
  }
  private async write(shell:Shell,requestId:string,text:string,ai=false){
    const prior=shell.requests.get(requestId);if(prior){if(prior.text!==text)throw Error('같은 요청 ID에 다른 입력을 보낼 수 없습니다.');return prior.promise;}
    if(shell.requests.size>=100_000)throw Error('입력 기록이 가득 찼습니다. 공용 터미널을 닫고 다시 여세요.');
    const task=shell.queue.catch(()=>{}).then(async()=>{
      if(this.stopped||shell.closing||shell.state!=='running')throw Error('공용 터미널이 종료되었습니다.');
      await shell.revalidate?.();
      if(this.stopped||shell.closing||shell.state!=='running')throw Error('공용 터미널이 종료되었습니다.');
      if(ai&&(!shell.aiAllowed||!this.dependencies.runningSession(shell.workroomSessionId)))throw Error('AI의 공용 터미널 권한이 해제되었습니다.');
      if(ai&&shell.userDraft)throw Error('사용자가 공용 터미널에 입력 중입니다. 입력을 마친 뒤 다시 시도하세요.');
      shell.child.terminal.write(text);
      if(!ai)for(const char of text){
        if(char==='\r'||char==='\n'||char==='\x03'||char==='\x15')shell.userDraft='';
        else if(char==='\x7f'||char==='\b')shell.userDraft=shell.userDraft.slice(0,-1);
        else if(!/[\x00-\x1f\x7f]/.test(char))shell.userDraft=(shell.userDraft+char).slice(-4096);
      }
      return {shell:this.summary(shell)};
    });
    shell.queue=task;shell.requests.set(requestId,{text,promise:task});return task;
  }
  async aiCommand(input:{sessionId:string;targetId:string;requestId:string;command:string}){
    if(!id(input.requestId)||typeof input.command!=='string'||!input.command.trim()||/[\x00-\x1f\x7f]/.test(input.command)||new TextEncoder().encode(input.command).length>4000)throw Error('AI가 입력할 한 줄 명령을 확인하세요.');
    const shell=this.get(input.sessionId,input.targetId);
    const parent=this.dependencies.runningSession(input.sessionId);
    if(!shell.aiAllowed||!parent||parent.targetId!==input.targetId)throw Error('이 워크룸 AI에게 공용 터미널 입력이 허용되지 않았습니다.');
    return this.write(shell,input.requestId,input.command+'\r',true);
  }
  aiRead(input:{sessionId:string;targetId:string;after:number}){
    const shell=this.get(input.sessionId,input.targetId);
    const parent=this.dependencies.runningSession(input.sessionId);
    if(!shell.aiAllowed||!parent||parent.targetId!==input.targetId)throw Error('이 워크룸 AI에게 공용 터미널 읽기가 허용되지 않았습니다.');
    return {shell:this.summary(shell),...terminalOutputPage(shell.chunks,input.after)};
  }
  async perform(value:unknown){
    const request=parseSharedShellRequest(value);
    if(this.stopped)throw Error('터미널 서버가 종료 중입니다.');
    if(request.operation==='shell.status')return {shell:this.shells.get(request.sessionId)?.targetId===request.targetId?this.summary(this.shells.get(request.sessionId)!):null};
    if(request.operation==='shell.start')return {shell:this.summary(await this.start(request))};
    const shell=this.get(request.sessionId,request.targetId);
    if(request.operation==='shell.read')return {shell:this.summary(shell),...terminalOutputPage(shell.chunks,request.after??0)};
    if(request.operation==='shell.input'){
      if(request.shellId!==shell.id)throw Error('셸이 바뀌었습니다. 이전 셸 입력은 보내지 않았습니다.');
      return this.write(shell,request.requestId!,request.data!);
    }
    if(request.operation==='shell.allow-ai'){
      if(request.enabled&&(shell.state!=='running'||!this.dependencies.runningSession(request.sessionId)))throw Error('실행 중인 워크룸 AI 세션에서만 입력을 허용할 수 있습니다.');
      shell.aiAllowed=request.enabled!;return {shell:this.summary(shell)};
    }
    if(request.operation==='shell.resize'){
      if(shell.state==='running'){await shell.revalidate?.();shell.child.terminal.resize(request.cols!,request.rows!);shell.cols=request.cols!;shell.rows=request.rows!;}
      return {shell:this.summary(shell)};
    }
    shell.aiAllowed=false;shell.closing=true;
    if(shell.state==='running'){
      this.signal(shell,'SIGTERM');
      await Promise.race([shell.child.exited,new Promise(resolve=>setTimeout(resolve,500))]);
      if(shell.state==='running')this.signal(shell,'SIGKILL');
      const exited=await Promise.race([shell.child.exited.then(()=>true),new Promise<false>(resolve=>setTimeout(()=>resolve(false),2000))]);
      if(!exited)throw Error('셸 종료를 확인하지 못했습니다. 상태를 다시 확인하세요.');
    }
    this.shells.delete(request.sessionId);
    return {shell:null};
  }
  async shutdown(){this.stopped=true;for(const shell of this.shells.values()){shell.aiAllowed=false;shell.closing=true;if(shell.state==='running')this.signal(shell,'SIGTERM');}await new Promise(resolve=>setTimeout(resolve,200));for(const shell of this.shells.values())if(shell.state==='running'){this.signal(shell,'SIGKILL');shell.child.terminal.close();}}
}
