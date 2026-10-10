import {splitTerminalInput} from './aiTerminalInput';

/** Keep user keystrokes in PTY order even when a local bridge delays one request. */
export function createSharedShellInputQueue(
  send: (part:string,shellId:string)=>Promise<unknown>,
  onError: (error:unknown)=>void,
){
  let tail:Promise<void>=Promise.resolve();
  let generation=0;
  return {
    enqueue(data:string,shellId:string){
      const current=generation;
      for(const part of splitTerminalInput(data)){
        tail=tail.then(async()=>{
          if(current!==generation)return;
          try{await send(part,shellId)}catch(error){if(current===generation)onError(error)}
        });
      }
    },
    /** Pending chunks from a closed or changed shell must never reach its replacement. */
    invalidate(){generation++},
    drain(){return tail},
  };
}
