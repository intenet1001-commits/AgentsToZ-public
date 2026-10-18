import {test,expect} from 'bun:test';
import {pendingWorkroomResumes,savePendingWorkroomResume,clearPendingWorkroomResume} from '../src/workroomConversationClient';
import {normalizeWorkroomHistoryResult,WORKROOM_HISTORY_VERSION} from '../src/workroomConversationProtocol';

test('only bounded receipt identities are retained through reload; unknown cache is never silently discarded',()=>{
  const values=new Map<string,string>(),storage={getItem:(k:string)=>values.get(k)??null,setItem:(k:string,v:string)=>{values.set(k,v);}};
  const a={storeInstanceId:'original-store-id',conversationId:'original-conversation-id',requestId:'original-request-id'};
  savePendingWorkroomResume(storage,a);expect(pendingWorkroomResumes(storage)).toEqual([a]);
  const b={...a,requestId:'different-request-id'};savePendingWorkroomResume(storage,b);expect(pendingWorkroomResumes(storage)).toEqual([b]);
  clearPendingWorkroomResume(storage,a);expect(pendingWorkroomResumes(storage)).toEqual([b]);
  clearPendingWorkroomResume(storage,b);expect(pendingWorkroomResumes(storage)).toEqual([]);
  for(const key of values.keys())values.set(key,'[{"prompt":"private"}]');
  expect(()=>pendingWorkroomResumes(storage)).toThrow();expect(()=>savePendingWorkroomResume(storage,a)).toThrow();
});
test('history results cannot introduce paths or unvalidated terminal summaries',()=>{
  const base={protocolVersion:WORKROOM_HISTORY_VERSION,storeInstanceId:'original-store-id'};
  expect(()=>normalizeWorkroomHistoryResult({...base,path:'/private'})).toThrow();
  expect(()=>normalizeWorkroomHistoryResult({...base,resume:{state:'completed',session:{id:'incomplete'}}})).toThrow();
  expect(()=>normalizeWorkroomHistoryResult({...base,resume:{state:'unknown',cwd:'/private'}})).toThrow();
  expect(normalizeWorkroomHistoryResult({...base,resume:{state:'unknown'}}).resume?.state).toBe('unknown');
});
