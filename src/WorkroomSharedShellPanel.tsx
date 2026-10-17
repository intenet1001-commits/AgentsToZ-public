import React,{useCallback,useEffect,useLayoutEffect,useMemo,useRef,useState} from 'react';
import {Terminal} from '@xterm/xterm';
import {FitAddon} from '@xterm/addon-fit';
import type {AiTerminalSummary} from './aiTerminalProtocol';
import {AI_TERMINAL_PREFIX} from './aiTerminalProtocol';
import {terminalLocalRequest} from './aiTerminalClient';
import {createSharedShellInputQueue} from './workroomSharedShellInputQueue';

type ShellSummary={id:string;workroomSessionId:string;targetId:string;createdAt:string;state:'running'|'exited';exitCode:number|null;cols:number;rows:number;aiAllowed:boolean};
type ShellReply={shell:ShellSummary|null;chunks?:{seq:number;text:string}[];nextCursor?:number;hasMore?:boolean;truncated?:boolean};

export function sharedShellShouldKeepPolling(state:ShellSummary['state'],hasMore:boolean):boolean{
 return state==='running'||hasMore;
}

/** Local Mac Workroom only. The CLI above and the user's shell below have separate PTYs. */
export function WorkroomSharedShellPanel({session,visible}:{session:AiTerminalSummary;visible:boolean}){
 const storageKey='agentstoz-shared-shell-open:'+session.id;
 const [open,setOpen]=useState(()=>{try{return sessionStorage.getItem(storageKey)==='true'}catch{return false}});
 const [shell,setShell]=useState<ShellSummary|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const [pageVisible,setPageVisible]=useState(()=>typeof document==='undefined'||!document.hidden);
 const host=useRef<HTMLDivElement>(null),terminal=useRef<Terminal|null>(null),fit=useRef<FitAddon|null>(null),cursor=useRef(0);
 const shellRef=useRef(shell);shellRef.current=shell;
 const closingInput=useRef(false);
 const request=useCallback((operation:string,fields:Record<string,unknown>={})=>terminalLocalRequest(AI_TERMINAL_PREFIX,{operation,sessionId:session.id,targetId:session.targetId,...fields}) as Promise<ShellReply>,[session.id,session.targetId]);
 const inputQueue=useMemo(()=>createSharedShellInputQueue(
   (data,shellId)=>request('shell.input',{requestId:crypto.randomUUID(),shellId,data}),
   error=>setError(error instanceof Error?error.message:String(error)),
 ),[request]);
 useLayoutEffect(()=>{inputQueue.invalidate();return()=>inputQueue.invalidate()},[inputQueue,shell?.id]);
 useEffect(()=>{try{sessionStorage.setItem(storageKey,String(open))}catch{/* Optional preference. */}},[open,storageKey]);
 useEffect(()=>{const update=()=>setPageVisible(!document.hidden);document.addEventListener('visibilitychange',update);return()=>document.removeEventListener('visibilitychange',update)},[]);
 useEffect(()=>{if(!visible||!pageVisible||!open)return;let alive=true;void request('shell.status').then(result=>{if(alive){setShell(result.shell);setError('')}}).catch(e=>{if(alive)setError(e instanceof Error?e.message:String(e))});return()=>{alive=false}},[request,visible,pageVisible,open]);
 useEffect(()=>{
  if(!visible||!open||!host.current)return;
  const screen=new Terminal({cols:80,rows:20,scrollback:3000,fontSize:12,fontFamily:'ui-monospace, SFMono-Regular, Menlo, monospace',theme:{background:'#0c0b0a',foreground:'#e9e5df',cursor:'#f5935f'}});
  const addon=new FitAddon();screen.loadAddon(addon);screen.open(host.current);terminal.current=screen;fit.current=addon;addon.fit();cursor.current=0;
  const onInput=screen.onData(data=>{const current=shellRef.current;if(closingInput.current||current?.state!=='running')return;inputQueue.enqueue(data,current.id)});
  const observer=new ResizeObserver(()=>{if(!host.current?.clientWidth)return;addon.fit();if(shellRef.current?.state==='running')void request('shell.resize',{cols:Math.max(20,Math.min(300,screen.cols)),rows:Math.max(5,Math.min(150,screen.rows))}).catch(()=>{});});observer.observe(host.current);
  return()=>{onInput.dispose();observer.disconnect();screen.dispose();terminal.current=null;fit.current=null;};
 // A change in state, such as AI consent, must not destroy the user's PTY view.
 // eslint-disable-next-line react-hooks/exhaustive-deps
 },[visible,open,session.id,request,inputQueue,!!shell]);
 useEffect(()=>{
  if(!visible||!pageVisible||!open||!shell)return;let stopped=false,reading=false;
  let timer:ReturnType<typeof setInterval>|null=null;
  const read=async()=>{if(reading||stopped)return;reading=true;try{
    let hasMore=false;
    for(let page=0;page<8&&!stopped;page++){
      const result=await request('shell.read',{after:cursor.current});
      if(stopped)return;
      if(result.truncated)terminal.current?.writeln('\r\n[이전 터미널 출력 일부가 생략되었습니다.]');
      for(const chunk of result.chunks??[])terminal.current?.write(chunk.text);
      cursor.current=result.nextCursor??cursor.current;
      if(result.shell&&result.shell.state!==shell.state)setShell(result.shell);
      hasMore=!!result.hasMore;
      if(!hasMore)break;
    }
    if(!stopped){
      setError('');
      if(!sharedShellShouldKeepPolling(shell.state,hasMore)&&timer!==null){clearInterval(timer);timer=null;}
    }
   }catch(e){if(!stopped){
     setError(e instanceof Error?e.message:String(e));
     if(!sharedShellShouldKeepPolling(shell.state,false)&&timer!==null){clearInterval(timer);timer=null;}
   }}finally{reading=false}};
  void read();timer=setInterval(()=>void read(),400);
  return()=>{stopped=true;if(timer!==null)clearInterval(timer)};
 },[visible,pageVisible,open,!!shell,session.id,request,shell?.state]);
 const start=async()=>{if(busy)return;setBusy(true);setError('');inputQueue.invalidate();try{const result=await request('shell.start',{cols:Math.max(20,Math.min(300,terminal.current?.cols??80)),rows:Math.max(5,Math.min(150,terminal.current?.rows??20))});setShell(result.shell);requestAnimationFrame(()=>terminal.current?.focus());}catch(e){setError(e instanceof Error?e.message:String(e))}finally{setBusy(false)}};
 const allowAi=async(enabled:boolean)=>{if(busy)return;setBusy(true);setError('');try{const result=await request('shell.allow-ai',{enabled});setShell(result.shell);}catch(e){setError(e instanceof Error?e.message:String(e))}finally{setBusy(false)}};
 const close=async()=>{if(busy)return;closingInput.current=true;inputQueue.invalidate();setBusy(true);setError('');try{await inputQueue.drain();const result=await request('shell.close');setShell(result.shell);cursor.current=0;terminal.current?.reset();}catch(e){setError(e instanceof Error?e.message:String(e))}finally{closingInput.current=false;setBusy(false)}};
 return <section className="workroom-shared-shell" data-testid="workroom-shared-shell" aria-label="공용 터미널">
  <div className="workroom-shared-shell-head"><button type="button" className="ai-terminal-btn" aria-expanded={open} onClick={()=>setOpen(value=>!value)}>{open?'하단 터미널 접기':'하단 터미널 펼치기'}</button><span>이 프로젝트의 공용 셸 · 내 입력과 허용한 AI 입력을 같은 세션에서 확인</span>{shell?.state==='running'&&<span className="workroom-shared-shell-state">실행 중</span>}</div>
  {open&&<div className="workroom-shared-shell-content">
   <div className="workroom-shared-shell-toolbar">
    {!shell&&<button type="button" className="ai-terminal-btn" disabled={busy||session.state!=='running'} onClick={()=>void start()}>터미널 시작</button>}
    {shell?.state==='running'&&<><button type="button" className="ai-terminal-btn" onClick={()=>terminal.current?.focus()}>여기에 입력</button><label><input type="checkbox" checked={shell.aiAllowed} disabled={busy||session.state!=='running'} onChange={e=>void allowAi(e.target.checked)}/>이 워크룸 AI도 사용 허용</label><button type="button" className="ai-terminal-btn ai-terminal-btn--danger" disabled={busy} onClick={()=>void close()}>셸 종료</button></>}
    {shell?.state==='exited'&&<><span>셸 종료 · 코드 {shell.exitCode??'확인 중'}</span><button type="button" className="ai-terminal-btn" disabled={busy} onClick={()=>void close()}>닫고 다시 시작</button></>}
   </div>
   <div ref={host} className="workroom-shared-shell-screen" aria-label="공용 셸 화면"/>
   {error&&<p role="alert" className="ai-terminal-error">{error}</p>}
   <p className="ai-terminal-hint">AI는 위 워크룸에서 이 터미널을 쓰라고 지시하고 허용한 경우에만 입력합니다. 접어도 셸은 계속 실행됩니다.</p>
  </div>}
 </section>;
}
