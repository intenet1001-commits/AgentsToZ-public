import {homedir} from 'node:os';
import {resolveAgentRuntimeGuardCommand} from './agentRuntimeGuardLauncher';
import {isCodexLoginUrl} from './onboardingCodexLogin';
import type {CodexLoginEffects} from './onboardingCodexLoginHost';
import {customCodexLoginContext,resolveCodexLoginExecutable,codexLoginOutputSink,probeCodexLogin,codexLoginEnv,codexLoginDigest,codexLoginCommand} from './onboardingCodexLoginRuntime';
export function createCodexLoginEffects(appData:string):CodexLoginEffects{
 const home=homedir();
 return {
  supported:process.platform==='darwin',
  probe:async()=>{
   if(customCodexLoginContext())return 'unknown';
   try{const executable=resolveCodexLoginExecutable();return executable?await probeCodexLogin(executable,home,codexLoginOutputSink(appData)):'unknown';}catch{return 'unknown';}
  },
  open:async url=>{if(!isCodexLoginUrl(url)||!(await codexLoginCommand('/usr/bin/open',[url],codexLoginEnv(home))).ok)throw new Error('브라우저 열기 실패');},
  login:(receipt,onUrl)=>{
   if(customCodexLoginContext())throw new Error('기존 프로필 확인 필요');
   const executable=resolveCodexLoginExecutable(),guard=resolveAgentRuntimeGuardCommand();
   if(!executable||!guard)throw new Error('로그인 도우미 확인 필요');
   let cancelled=false,child:ReturnType<typeof Bun.spawn>|undefined;
   const cancel=()=>{cancelled=true;try{(child?.stdin as any)?.end();}catch{}};
   const done=(async()=>{
    const identity=await codexLoginDigest(executable);if(cancelled)throw new Error('cancelled');
    child=Bun.spawn([...guard,'agentstoz-onboarding-codex-auth-v1',executable,identity,appData,receipt.id,receipt.revision],{
     cwd:'/',env:codexLoginEnv(home),stdin:'pipe',stdout:'pipe',stderr:'ignore',detached:true,
    });
    const stream=child.stdout as ReadableStream<Uint8Array>,reader=stream.getReader();let total=0,buffer='',ok=false;
    try{for(;;){const {done,value}=await reader.read();if(done)break;total+=value.length;if(total>8192)throw new Error('guard output');buffer+=new TextDecoder().decode(value);
     let i:number;while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i);buffer=buffer.slice(i+1);
      if(line.startsWith('URL ')&&isCodexLoginUrl(line.slice(4))&&!cancelled)onUrl(line.slice(4));
      else if(line==='RESULT OK')ok=true;
     }
    }
    await child.exited;if(!ok||cancelled)throw new Error('login incomplete');
    }finally{buffer='';reader.releaseLock();cancel();await child.exited;}
   })();return {done,cancel};
  },
 };
}
