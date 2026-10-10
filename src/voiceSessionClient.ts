import {terminalLocalRequest} from './aiTerminalClient';
import {VOICE_ENDPOINT,normalizeVoiceResponse,type VoiceRequest,type VoiceResponse} from './voiceSessionProtocol';
import type {WorkroomTransport} from './WorkroomSessionFooter';
export type VoiceTransport=(request:VoiceRequest)=>Promise<VoiceResponse>;
export const localVoiceTransport:VoiceTransport=async request=>normalizeVoiceResponse(await terminalLocalRequest(VOICE_ENDPOINT,request));
export function remoteVoiceTransport(transport:WorkroomTransport,targetId:string):VoiceTransport {
  const send:VoiceTransport=async voice=>normalizeVoiceResponse((await transport({operation:'workspace',requestId:voice.requestId,targetId,workspace:{action:'voice',voice}})).voice);
  return async voice=>{
    if(voice.action!=='connect')return send(voice);
    const sdp=voice.sdp!,parts=Math.ceil(sdp.length/4000);
    for(let part=0;part<parts;part++)await send({action:'signal.append',requestId:voice.requestId+'_'+part,sessionId:voice.sessionId,part,parts,chunk:sdp.slice(part*4000,(part+1)*4000)});
    const first=await send({action:'signal.connect',requestId:voice.requestId,sessionId:voice.sessionId});
    let answer=first.chunk??'';if(!first.parts)throw new Error('음성 연결 응답을 확인하지 못했습니다.');
    for(let part=1;part<first.parts;part++){
      const next=await send({action:'signal.read',requestId:voice.requestId+'_read_'+part,sessionId:voice.sessionId,part});
      if(next.part!==part||next.parts!==first.parts)throw new Error('음성 연결 조각이 변경되었습니다.');
      answer+=next.chunk;
    }
    return normalizeVoiceResponse({sdp:answer});
  };
}
