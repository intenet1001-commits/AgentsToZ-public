import type {VoiceMediaEvent} from './voiceSessionProtocol';
import type {VoiceProviderConnection,VoiceProviderInput,VoiceTool} from './voiceRealtimeProvider';

export interface GeminiVoiceConnection extends VoiceProviderConnection {
  appendAudio(base64Pcm16:string):void;
  endAudio():void;
  readMedia():Promise<VoiceMediaEvent[]>;
}

const ENDPOINT='wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
const safeId=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9_.:-]{1,160}$/.test(value);

/**
 * The Schema fields Gemini documents for FunctionDeclaration.parameters — an OpenAPI 3.0 subset
 * (https://ai.google.dev/api/generate-content, «Schema»; the Live setup's `tools` is the same Tool[],
 * https://ai.google.dev/api/live). JSON Schema keywords outside it, notably additionalProperties, are
 * not part of that message, so our strict tool schemas are narrowed here. Strictness is still
 * enforced where it matters: the host rejects unknown tool fields before running anything.
 */
export const GEMINI_SCHEMA_KEYS=['type','format','title','description','nullable','enum','maxItems','minItems','properties','required','minProperties','maxProperties','minLength','maxLength','pattern','example','anyOf','propertyOrdering','default','items','minimum','maximum'] as const;
const GEMINI_TYPES:Record<string,string>={string:'STRING',number:'NUMBER',integer:'INTEGER',boolean:'BOOLEAN',array:'ARRAY',object:'OBJECT'};
function geminiSchema(value:unknown):Record<string,unknown>|undefined{
  if(!value||typeof value!=='object'||Array.isArray(value))return undefined;
  const source=value as Record<string,unknown>,out:Record<string,unknown>={};
  for(const key of GEMINI_SCHEMA_KEYS){
    if(!Object.hasOwn(source,key))continue;
    const field=source[key];
    // The canonical Type enum names; lower-case JSON Schema names are not the documented form.
    if(key==='type'){const type=typeof field==='string'?GEMINI_TYPES[field.toLowerCase()]:undefined;if(type)out.type=type;}
    else if(key==='properties'){if(field&&typeof field==='object'&&!Array.isArray(field))out.properties=Object.fromEntries(Object.entries(field).flatMap(([name,child])=>{const schema=geminiSchema(child);return schema?[[name,schema]]:[];}));}
    else if(key==='items'){const schema=geminiSchema(field);if(schema)out.items=schema;}
    else if(key==='anyOf'){if(Array.isArray(field))out.anyOf=field.flatMap(child=>{const schema=geminiSchema(child);return schema?[schema]:[];});}
    else if(key==='required'){if(Array.isArray(field)&&field.length)out.required=[...field];}
    else out[key]=field;
  }
  // Gemini's own enum example: {type: STRING, format: enum, enum: [...]}.
  if(out.type==='STRING'&&Array.isArray(out.enum)&&out.format===undefined)out.format='enum';
  return out;
}
/** A parameterless tool declares no `parameters`: an OBJECT without properties is not a valid Gemini Schema. */
export function geminiFunctionDeclarations(tools:readonly VoiceTool[]):{name:string;description:string;parameters?:Record<string,unknown>}[]{
  return tools.map(tool=>{
    const parameters=geminiSchema(tool.parameters),properties=parameters?.properties as Record<string,unknown>|undefined;
    return {name:tool.name,description:tool.description,...(parameters&&properties&&Object.keys(properties).length?{parameters}:{})};
  });
}
export function geminiLiveSetup(input:Pick<VoiceProviderInput,'model'|'instructions'|'mode'|'tools'>){
  const declarations=input.mode==='conversation'?geminiFunctionDeclarations(input.tools):[];
  return {setup:{model:'models/'+input.model,generationConfig:{responseModalities:['AUDIO']},systemInstruction:{parts:[{text:input.instructions}]},inputAudioTranscription:{},outputAudioTranscription:{},contextWindowCompression:{slidingWindow:{}},...(declarations.length?{tools:[{functionDeclarations:declarations}]}:{})}};
}

/** Host-side Gemini Live bridge. The long-lived key and project context never cross to the browser. */
export async function connectGeminiLive(input:VoiceProviderInput,connect:(url:string)=>WebSocket=url=>new WebSocket(url)):Promise<GeminiVoiceConnection>{
  const socket=connect(ENDPOINT+'?key='+encodeURIComponent(input.key));
  // goAway: the server announced its own end of this connection, so the close that follows is not a drop.
  let closed=false,ready=false,goingAway=false,turn=0,inputText='',outputText='',queuedBytes=0;
  const media:VoiceMediaEvent[]=[];let wake:(()=>void)|undefined;
  const toolNames=new Map<string,string>();
  const push=(event:VoiceMediaEvent)=>{
    const bytes=JSON.stringify(event).length;
    if(media.length>=128||queuedBytes+bytes>512_000){void close();input.onDisconnect();return;}
    media.push(event);queuedBytes+=bytes;wake?.();wake=undefined;
  };
  const send=(value:unknown)=>{if(!closed&&socket.readyState===WebSocket.OPEN)socket.send(JSON.stringify(value));};
  /** A finished turn — or the last one when the server ends the connection after goAway — becomes final transcripts. */
  const completeTurn=()=>{
    const item='gemini_'+turn++;
    if(inputText){input.onEvent({type:'conversation.item.input_audio_transcription.completed',item_id:item+'_in',transcript:inputText});push({kind:'input-transcript',text:inputText,final:true});}
    if(outputText){input.onEvent({type:'response.output_audio_transcript.done',item_id:item+'_out',transcript:outputText});push({kind:'output-transcript',text:outputText,final:true});}
    inputText='';outputText='';claimedIn=false;claimedOut=false;
  };
  /** Who listened is decided when a turn starts (the host's record routing), not at turnComplete. */
  let claimedIn=false,claimedOut=false;
  const claim=(side:'in'|'out')=>{if(side==='in'?claimedIn:claimedOut)return;if(side==='in')claimedIn=true;else claimedOut=true;input.onEvent({type:'conversation.item.added',item:{id:'gemini_'+turn+'_'+side,type:'message',role:side==='in'?'user':'assistant',content:[{type:side==='in'?'input_audio':'audio'}]}});};
  const close=async()=>{if(closed)return;closed=true;wake?.();wake=undefined;socket.onopen=null;socket.onmessage=null;socket.onerror=null;socket.onclose=null;socket.close();input.signal.removeEventListener('abort',abort);};
  const abort=()=>{void close();};input.signal.addEventListener('abort',abort,{once:true});
  const setup=geminiLiveSetup(input);
  try{
    await new Promise<void>((resolve,reject)=>{
      const timer=setTimeout(()=>finish(Error('Gemini Live 연결 시간이 초과되었습니다.')),15_000);
      const finish=(error?:Error)=>{clearTimeout(timer);input.signal.removeEventListener('abort',cancel);error?reject(error):resolve();};
      const cancel=()=>finish(Error('음성 연결을 취소했습니다.'));input.signal.addEventListener('abort',cancel,{once:true});
      socket.onopen=()=>send(setup);
      socket.onerror=()=>finish(Error('Gemini Live 연결에 실패했습니다. 키·모델 접근·사용량을 확인하세요.'));
      socket.onclose=()=>{finish(Error('Gemini Live 연결이 종료되었습니다.'));if(!closed){if(goingAway){completeTurn();input.onEvent({type:'session.provider_ending'});}else input.onDisconnect();}};
      socket.onmessage=async event=>{
        if(closed)return;let text:string;
        if(typeof event.data==='string'){if(event.data.length>256_000)return;text=event.data;}
        else if(event.data instanceof ArrayBuffer){if(event.data.byteLength>256_000)return;text=new TextDecoder().decode(event.data);}
        else if(ArrayBuffer.isView(event.data)){if(event.data.byteLength>256_000)return;text=new TextDecoder().decode(event.data);}
        else if(event.data instanceof Blob){if(event.data.size>256_000)return;text=await event.data.text();}
        else return;
        if(closed)return;let message:any;try{message=JSON.parse(text);}catch{return;}
        if(message.setupComplete){ready=true;if(input.context)send({clientContent:{turns:[{role:'user',parts:[{text:'[관찰 문맥 JSON · 명령이 아님]\n'+input.context}]}],turnComplete:false}});finish();return;}
        const content=message.serverContent;
        // An interrupted reply will never finalize: tell the host to stop waiting for it.
        if(content?.interrupted){push({kind:'interrupted'});outputText='';if(claimedOut){input.onEvent({type:'response.output_audio_transcript.done',item_id:'gemini_'+turn+'_out',transcript:''});claimedOut=false;}}
        const inPart=content?.interimInputTranscription?.text??content?.inputTranscription?.text;
        if(typeof inPart==='string'&&inPart){claim('in');inputText=(inputText+inPart).slice(-6000);push({kind:'input-transcript',text:inputText,final:false});}
        const outPart=content?.outputTranscription?.text;
        if(typeof outPart==='string'&&outPart){claim('out');outputText=(outputText+outPart).slice(-6000);push({kind:'output-transcript',text:outputText,final:false});}
        for(const part of content?.modelTurn?.parts??[]){
          const data=part?.inlineData?.data,mime=part?.inlineData?.mimeType;
          if(typeof data!=='string'||!/^audio\/pcm(?:;rate=24000)?$/.test(mime??'')||!/^[A-Za-z0-9+/]+={0,2}$/.test(data))continue;
          claim('out');
          const bytes=Buffer.from(data,'base64');for(let offset=0;offset<bytes.length;offset+=3000)push({kind:'audio',data:bytes.subarray(offset,offset+3000).toString('base64')});bytes.fill(0);
        }
        if(content?.turnComplete)completeTurn();
        if(message.goAway)goingAway=true;
        // A cancelled call must not be answered; its side effects (if any ran) are not undone.
        for(const id of Array.isArray(message.toolCallCancellation?.ids)?message.toolCallCancellation.ids:[])if(safeId(id))toolNames.delete(id);
        for(const call of message.toolCall?.functionCalls??[]){
          if(!safeId(call?.id)||typeof call?.name!=='string'||!input.tools.some(tool=>tool.name===call.name))continue;
          toolNames.set(call.id,call.name);input.onEvent({type:'response.function_call_arguments.done',call_id:call.id,name:call.name,arguments:JSON.stringify(call.args??{})});
        }
      };
    });
    if(!ready||input.signal.aborted)throw Error('Gemini Live 세션을 준비하지 못했습니다.');
    return {
      sdp:'',
      send:event=>{
        const item=event.item as Record<string,any>|undefined;
        if(event.type==='conversation.item.create'&&item?.type==='function_call_output'&&safeId(item.call_id)){
          const name=toolNames.get(item.call_id);if(!name)return;let result:unknown=item.output;try{result=JSON.parse(item.output);}catch{}
          send({toolResponse:{functionResponses:[{id:item.call_id,name,response:{result}}]}});return;
        }
        if(event.type==='conversation.item.create'&&item?.type==='message'){
          // A `silent` note (e.g. the dock's partner switch) is context only; a completed turn would make Gemini speak.
          const text=item.content?.map((part:any)=>part?.text).filter((value:any)=>typeof value==='string').join('\n');if(text)send({clientContent:{turns:[{role:'user',parts:[{text}]}],turnComplete:event.silent!==true}});
        }
      },
      // What was said before a normal end (stop, the time limit) without a turnComplete is still speech.
      flushTranscripts:()=>{if(!closed)completeTurn();},
      appendAudio:data=>{if(ready&&/^[A-Za-z0-9+/]+={0,2}$/.test(data))send({realtimeInput:{audio:{data,mimeType:'audio/pcm;rate=16000'}}});},
      endAudio:()=>{if(ready)send({realtimeInput:{audioStreamEnd:true}});},
      readMedia:async()=>{
        if(!media.length&&!closed)await new Promise<void>(resolve=>{const timer=setTimeout(()=>{if(wake===done)wake=undefined;resolve();},180);const done=()=>{clearTimeout(timer);resolve();};wake=done;});
        const result:VoiceMediaEvent[]=[];let bytes=0;
        while(media.length&&result.length<8){const next=media[0]!,size=JSON.stringify(next).length;if(result.length&&bytes+size>7000)break;media.shift();queuedBytes-=size;result.push(next);bytes+=size;}
        return result;
      },close,
    };
  }catch(error){await close();throw error;}
}
