import {closeSync,constants,fstatSync,lstatSync,openSync,readSync} from 'node:fs';

type DatalessPolicy = {getiopolicy_np:(type:number,scope:number)=>number;setiopolicy_np:(type:number,scope:number,policy:number)=>number};
// sys/resource.h; keep the dlopen owner for the lifetime of its function stubs.
const MATERIALIZE_DATALESS_FILES=3,THREAD_SCOPE=1,MATERIALIZATION_OFF=1;
let nativeLibrary:{symbols:DatalessPolicy}|undefined;
/** Apple TN3150: background discovery must not download an iCloud placeholder.
 * The setting is thread-local and restored before returning; no async callback
 * may run inside this scope. Failure is handled as unknown metadata by callers.
 */
export function withoutDatalessMaterialization<T>(operation:()=>T):T {
  if(process.platform!=='darwin')return operation();
  if(!nativeLibrary){
    const {dlopen,FFIType}=require('bun:ffi') as typeof import('bun:ffi');
    nativeLibrary=dlopen('/usr/lib/libSystem.B.dylib',{
      getiopolicy_np:{args:[FFIType.i32,FFIType.i32],returns:FFIType.i32},
      setiopolicy_np:{args:[FFIType.i32,FFIType.i32,FFIType.i32],returns:FFIType.i32},
    });
  }
  const policy=nativeLibrary.symbols;
  const previous=policy.getiopolicy_np(MATERIALIZE_DATALESS_FILES,THREAD_SCOPE);
  if(previous<0||policy.setiopolicy_np(MATERIALIZE_DATALESS_FILES,THREAD_SCOPE,MATERIALIZATION_OFF)!==0)throw new Error('Local metadata policy unavailable');
  try{return operation();}finally{
    if(policy.setiopolicy_np(MATERIALIZE_DATALESS_FILES,THREAD_SCOPE,previous)!==0)throw new Error('Local metadata policy restore failed');
  }
}

/** Small, regular, already-local files only. Pin the checked inode and bound
 * the actual read too, so replacement/growth cannot turn discovery into a
 * blocking device read or an unbounded allocation. */
export function readLocalMetadataFile(path:string,maxBytes=8192):string|null {
  if(!Number.isInteger(maxBytes)||maxBytes<1||maxBytes>65536)return null;
  try{return withoutDatalessMaterialization(()=>{
    const before=lstatSync(path);
    if(before.isSymbolicLink()||!before.isFile()||before.size>maxBytes)return null;
    const fd=openSync(path,constants.O_RDONLY|constants.O_NONBLOCK|(process.platform==='win32'?0:constants.O_NOFOLLOW));
    try{
      const info=fstatSync(fd);
      if(!info.isFile()||info.dev!==before.dev||info.ino!==before.ino||info.size>maxBytes)return null;
      const buffer=Buffer.alloc(maxBytes+1);let size=0;
      while(size<buffer.length){const count=readSync(fd,buffer,size,buffer.length-size,size);if(!count)break;size+=count;}
      return size>maxBytes?null:buffer.subarray(0,size).toString('utf8');
    }finally{closeSync(fd);}
  });}catch{return null;}
}
