import {Database,constants} from 'bun:sqlite';
import {lstatSync,realpathSync} from 'node:fs';
import {basename,dirname,join} from 'node:path';
import {saveToken} from './memorySaveContract';

export interface MemoryObservationStatus {
  version:1;
  targetId:string;
  state:'available'|'inactive'|'uninitialized'|'unavailable';
  completedTurns:number;
  hasMore:boolean;
  conversationMemory:'not-connected';
}
/** Read-only, bounded diagnostic projection. Opening the UI must not create an
 * observation database before the installation identity has been established. */
export function readMemoryObservationSummary(path:string,memoryId:string):{completedTurns:number;hasMore:boolean} {
  if(!saveToken(memoryId))throw new Error('Invalid observation scope');
  try{if(!lstatSync(path).isFile())throw new Error('Invalid observation store');}
  catch(error:any){if(error?.code==='ENOENT')return {completedTurns:0,hasMore:false};throw error;}
  let db:Database|undefined;
  try{
    const canonicalPath=join(realpathSync(dirname(path)),basename(path));
    db=new Database(canonicalPath,constants.SQLITE_OPEN_READONLY|constants.SQLITE_OPEN_NOFOLLOW);
    db.run('PRAGMA busy_timeout=100');db.run('PRAGMA cache_size=-256');
    if(![2,3,4,5,6,7].includes((db.query('PRAGMA user_version').get() as {user_version:number}).user_version))throw new Error('Unsupported observation store');
    // sources_pending covers the scope/order. Read at most 129 rows, even if a
    // legacy fragment backlog exists; never scan all historical payloads/counts.
    const rows=db.query(`SELECT coverageKind FROM save_sources WHERE memoryId=? AND policyEpoch=1
      AND saveId IS NULL ORDER BY sequence LIMIT 129`).all(memoryId) as {coverageKind:string}[];
    return {completedTurns:rows.slice(0,128).filter(row=>row.coverageKind==='complete-turn').length,hasMore:rows.length>128};
  }finally{db?.close();}
}

export async function getMemoryObservationStatus(targetId:string,deps:{
  enabled:()=>boolean;
  resolve:()=>Promise<{memoryId:string;validateRegistration:()=>Promise<boolean>}|null>;
  read:(memoryId:string)=>{completedTurns:number;hasMore:boolean};
}):Promise<MemoryObservationStatus> {
  if(!saveToken(targetId))throw new Error('Invalid observation target');
  const base={version:1 as const,targetId,completedTurns:0,hasMore:false,conversationMemory:'not-connected' as const};
  try{
    const project=await deps.resolve();
    if(!project)return {...base,state:'uninitialized'};
    if(!deps.enabled())return {...base,state:'inactive'};
    const summary=deps.read(project.memoryId);
    if(!await project.validateRegistration())return {...base,state:'unavailable'};
    if(!deps.enabled())return {...base,state:'inactive'};
    return {...base,...summary,state:'available'};
  }catch{return {...base,state:'unavailable'};}
}
