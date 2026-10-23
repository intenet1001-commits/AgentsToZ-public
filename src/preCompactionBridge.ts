import {isAbsolute} from 'node:path';
import {saveToken} from './memorySaveContract';
import type {RecoveryAgent} from './preCompactionRecovery';
export interface PreCompactionHookRequest {agent:RecoveryAgent;sessionId:string;cwd:string;event:'pre-compaction'|'periodic';workspacePaths?:string[]}
/** Hooks send metadata only. Neither source paths nor raw conversation bodies
 * are accepted. This local-only route never returns plaintext or enables saving. */
export async function readPreCompactionHookRequest(req:Request):Promise<PreCompactionHookRequest>{
  if(req.method!=='POST'||req.headers.has('origin')||req.headers.has('sec-fetch-site'))throw Error('로컬 제공자 훅만 사용할 수 있습니다.');
  const reader=req.body?.getReader();if(!reader)throw Error('훅 메타데이터가 없습니다.');
  const parts:Uint8Array[]=[];let size=0;
  try{while(true){const r=await reader.read();if(r.done)break;size+=r.value.length;if(size>16_384){await reader.cancel();throw Error('훅 메타데이터 한도를 초과했습니다.');}parts.push(r.value);}}
  finally{reader.releaseLock();}
  const b=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(parts))) as PreCompactionHookRequest;
  if(!b||typeof b!=='object'||Array.isArray(b)||Object.keys(b).some(k=>!['agent','sessionId','cwd','event','workspacePaths'].includes(k))
    ||!['codex','claude','hermes','agy'].includes(b.agent)||!saveToken(b.sessionId)||typeof b.cwd!=='string'||b.cwd.length>4096||!isAbsolute(b.cwd)||/[\0\r\n]/.test(b.cwd)
    ||!['pre-compaction','periodic'].includes(b.event))throw Error('훅 메타데이터가 올바르지 않습니다.');
  if(b.agent==='agy'){
    if(b.event!=='periodic'||!Array.isArray(b.workspacePaths)||b.workspacePaths.length!==1||b.workspacePaths[0]!==b.cwd)throw Error('Antigravity의 정확한 단일 작업 폴더가 필요합니다.');
  }else if(b.workspacePaths!==undefined)throw Error('예상하지 않은 작업 폴더 필드입니다.');
  return b;
}
