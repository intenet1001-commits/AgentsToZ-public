import {spawn, type ChildProcessWithoutNullStreams} from 'node:child_process';
import type {ComputerWorker} from './computerUseHost';
/**
 * Lab and test transport only: one request at a time, one bounded answer, no inherited credentials or logs.
 *
 * A child of the AgentsToZ sidecar inherits the app's macOS privacy responsibility (TCC): whatever Accessibility
 * the worker needs here, every agent shell under the same app gets too. Production control therefore runs in the
 * separately signed sibling app with its own LaunchAgent (docs/design/computer-use-2026-10-26/HELPER-DESIGN.md), never
 * through this spawn. This factory needs an explicit `lab: true` and refuses to start inside the bundled app sidecar.
 */
export function createLabComputerWorkerFactory(options: {executable: string; verify: () => Promise<boolean>; lab: true}) {
  return async (): Promise<ComputerWorker> => {
    if (options.lab !== true || process.env.PORTMGR_BUNDLED_SIDECAR === '1')
      throw Error('이 실행 방식은 실험과 시험 전용입니다. 앱에서는 서명된 컴퓨터 유즈 도우미가 필요합니다.');
    if (process.platform !== 'darwin' || !await options.verify()) throw Error('서명된 컴퓨터 유즈 실행기가 필요합니다.');
    const env:NodeJS.ProcessEnv={PATH:'/usr/bin:/bin:/usr/sbin:/sbin'};
    // SDK discovery must not inherit API credentials, custom handlers or global Peekaboo settings.
    const child:ChildProcessWithoutNullStreams=spawn(options.executable,[],{env,stdio:['pipe','pipe','pipe']});
    let closed=false, pending:{resolve:(v:Record<string,any>)=>void;reject:()=>void;timer:ReturnType<typeof setTimeout>}|undefined;
    let buffer=Buffer.alloc(0);
    const close=()=>{if(closed)return;closed=true;child.stdin.destroy();child.stdout.destroy();child.stderr.destroy();child.kill('SIGKILL');
      if(pending){clearTimeout(pending.timer);pending.reject();pending=undefined;}buffer=Buffer.alloc(0);};
    child.on('error',close);child.on('exit',close);
    child.stderr.resume(); // Never log raw AX observations or native framework diagnostics.
    child.stdout.on('data',(chunk:Buffer)=>{
      buffer=Buffer.concat([buffer,chunk]);
      if(buffer.length>512_000){close();return;}
      const end=buffer.indexOf(10);if(end<0)return;
      if(!pending||end!==buffer.length-1){close();return;}
      try {
        const value=JSON.parse(buffer.subarray(0,end).toString('utf8'));
        if(!value||typeof value!=='object'||Array.isArray(value))throw Error();
        const request=pending;pending=undefined;clearTimeout(request.timer);buffer=Buffer.alloc(0);request.resolve(value);
      } catch {close();}
    });
    // No screen-image consent or capture binding exists on this transport: the host refuses capture/click up front.
    return {lab:true,supports:()=>false,close,request(body) {
      if(closed||pending) return Promise.reject(Error('컴퓨터 제어 연결을 확인하지 못했습니다.'));
      const wire=JSON.stringify(body)+'\n';
      if(Buffer.byteLength(wire)>32_000)return Promise.reject(Error('컴퓨터 제어 요청이 너무 큽니다.'));
      return new Promise((resolve,reject)=>{
        const timer=setTimeout(close,8_000);timer.unref?.();
        pending={resolve,reject:()=>reject(Error('작업 결과가 미확인입니다. 새 ID로 자동 재시도하지 마세요.')),timer};
        child.stdin.write(wire,error=>{if(error)close();});
      });
    }};
  };
}
