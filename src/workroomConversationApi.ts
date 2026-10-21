import type { WorkroomConversationService } from './workroomConversationService';
import { WORKROOM_HISTORY_PATH, workroomHistoryErrorMessage } from './workroomConversationProtocol';

/** The caller supplies the existing Agent Runtime management authentication and origin gate. */
export async function handleWorkroomConversationRequest(req: Request, service: Pick<WorkroomConversationService,'perform'>, headers: Record<string,string> = {}) {
  const url = new URL(req.url);
  const responseHeaders = {...headers,'Cache-Control':'no-store'};
  if (url.pathname !== WORKROOM_HISTORY_PATH || url.search !== '' || req.method !== 'POST') {
    return Response.json({error:'허용되지 않은 대화 기록 요청입니다.'},{status:405,headers:responseHeaders});
  }
  try {
    const chunks:Uint8Array[]=[];let bytes=0;const reader=req.body?.getReader();
    if(reader)try{while(true){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;
      if(bytes>8192){await reader.cancel();throw new Error('대화 기록 요청 크기를 확인하세요.');}chunks.push(part.value);
    }}finally{reader.releaseLock();}
    const text=Buffer.concat(chunks).toString('utf8');
    return Response.json(await service.perform(JSON.parse(text)),{headers:responseHeaders});
  } catch (error: any) {
    // Never echo filesystem paths, SQL diagnostics, JSON fragments or provider output.
    const message = workroomHistoryErrorMessage(error);
    return Response.json({error:message},{status:400,headers:responseHeaders});
  }
}
