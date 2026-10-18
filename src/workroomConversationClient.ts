import {terminalLocalRequest} from './aiTerminalClient';
import {WORKROOM_HISTORY_PATH,normalizeWorkroomHistoryRequest,normalizeWorkroomHistoryResult,type WorkroomHistoryRequest} from './workroomConversationProtocol';

export const requestWorkroomHistory=async(request:WorkroomHistoryRequest)=>normalizeWorkroomHistoryResult(await terminalLocalRequest(WORKROOM_HISTORY_PATH,normalizeWorkroomHistoryRequest(request)));
export interface PendingWorkroomResume {storeInstanceId:string;conversationId:string;requestId:string}
const STORAGE_KEY='agentstoz.workroom.pending-resumes.v1';
const valid=(v:unknown):v is PendingWorkroomResume=>!!v&&typeof v==='object'&&!Array.isArray(v)
  &&Object.keys(v).length===3&&['storeInstanceId','conversationId','requestId'].every(k=>typeof (v as any)[k]==='string'&&/^[A-Za-z0-9_-]{8,160}$/.test((v as any)[k]));
/** Only receipt identities survive a page reload; prompts, paths and account secrets never enter this cache. */
export function pendingWorkroomResumes(storage:Pick<Storage,'getItem'>):PendingWorkroomResume[]{
  try{const raw=storage.getItem(STORAGE_KEY);if(!raw)return[];if(raw.length>20000)throw new Error();const rows=JSON.parse(raw);if(!Array.isArray(rows)||rows.length>32||!rows.every(valid))throw new Error();return rows;}
  catch{throw new Error('보관한 재개 요청을 확인하지 못했습니다. 현재 터미널과 대화 기록을 먼저 확인하세요.');}
}
export function savePendingWorkroomResume(storage:Pick<Storage,'getItem'|'setItem'>,receipt:PendingWorkroomResume){
  if(!valid(receipt))throw new Error('대화 재개 요청을 확인하세요.');
  const rows=pendingWorkroomResumes(storage).filter(r=>r.storeInstanceId!==receipt.storeInstanceId||r.conversationId!==receipt.conversationId);
  if(rows.length>=32)throw new Error('결과 확인이 필요한 재개 요청을 먼저 확인하세요.');
  storage.setItem(STORAGE_KEY,JSON.stringify([...rows,receipt]));
}
export function clearPendingWorkroomResume(storage:Pick<Storage,'getItem'|'setItem'>,receipt:PendingWorkroomResume){
  storage.setItem(STORAGE_KEY,JSON.stringify(pendingWorkroomResumes(storage).filter(r=>r.requestId!==receipt.requestId||r.storeInstanceId!==receipt.storeInstanceId)));
}
