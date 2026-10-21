#!/usr/bin/env bun
import {constants,openSync,fstatSync,lstatSync,readSync,closeSync} from 'node:fs';
import {BENCHMARK_MAX_BYTES,evaluateBenchmark,type BenchmarkVerdict} from './src/voiceRemoteBenchmark';

/** Bounded regular-file reader; never follows a symlink or waits on a FIFO. */
export function readBenchmarkFile(path:string):string {
  let fd:number|undefined;
  try{
    const expected=lstatSync(path);
    if(!expected.isFile()||expected.isSymbolicLink()||expected.size>BENCHMARK_MAX_BYTES)throw Error();
    fd=openSync(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0)|(constants.O_NONBLOCK??0));
    const opened=fstatSync(fd);
    if(!opened.isFile()||opened.dev!==expected.dev||opened.ino!==expected.ino||opened.size>BENCHMARK_MAX_BYTES)throw Error();
    const parts:Buffer[]=[];let count=0;
    for(;;){
      const chunk=Buffer.alloc(Math.min(65536,BENCHMARK_MAX_BYTES-count+1)),n=readSync(fd,chunk,0,chunk.length,null);
      if(!n)break;count+=n;if(count>BENCHMARK_MAX_BYTES)throw Error();parts.push(chunk.subarray(0,n));
    }
    const current=fstatSync(fd);
    if(current.size!==opened.size||current.mtimeMs!==opened.mtimeMs||current.ctimeMs!==opened.ctimeMs)throw Error();
    return new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(parts));
  }catch{throw Error('INVALID_BENCHMARK_INPUT');}
  finally{if(fd!==undefined)closeSync(fd);}
}
export const benchmarkExitCode=(status:BenchmarkVerdict):number=>({PASS:0,FAIL:1,BLOCKED:2,NOT_RUN:3})[status];
if(import.meta.main){
  if(process.argv.length!==3){console.error('usage: bun benchmark-voice-remote.ts <reported-evidence.json>');process.exit(64);}
  try{
    const report=evaluateBenchmark(readBenchmarkFile(process.argv[2]!));
    process.stdout.write(JSON.stringify(report)+'\n');
    process.exitCode=benchmarkExitCode(report.status);
  }catch{console.error('INVALID_BENCHMARK_INPUT');process.exitCode=65;}
}
