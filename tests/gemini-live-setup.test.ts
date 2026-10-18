import {expect,test} from 'bun:test';
import golden from './fixtures/gemini-live-ops-tools-golden.json';
import type {AiTerminalService} from '../src/aiTerminalService';
import {bindVoiceRuntime} from '../src/voiceRuntimeBinding';
import {GEMINI_SCHEMA_KEYS,connectGeminiLive,geminiFunctionDeclarations,geminiLiveSetup} from '../src/geminiLiveProvider';
import type {VoiceProviderInput} from '../src/voiceRealtimeProvider';

/**
 * Source (checked 2026-09-29): https://ai.google.dev/api/generate-content — FunctionDeclaration has
 * `parameters` (Schema, an OpenAPI 3.0 subset) and `parametersJsonSchema` (mutually exclusive). The
 * Schema fields are exactly GEMINI_SCHEMA_KEYS; `additionalProperties` is not one of them.
 * https://ai.google.dev/api/live — BidiGenerateContentSetup.tools is that same Tool[], and the server
 * may send toolCallCancellation{ids} and goAway{timeLeft}.
 */
async function realOpsTools(){
  const binding=await bindVoiceRuntime({terminal:{} as AiTerminalService,targets:async()=>[],target:async()=>({label:'unused',fingerprint:'unused'}),
    ops:()=>({fingerprint:'ops',projectId:'ops_project_fixture'}),recall:()=>({}),projectRecall:async()=>({}),propose:async()=>({})},{kind:'ops'},{owner:'local',active:()=>true});
  return binding.tools;
}
function schemaNodes(value:unknown,path:string,out:{path:string;node:Record<string,unknown>}[]=[]){
  if(!value||typeof value!=='object')return out;
  const node=value as Record<string,unknown>;out.push({path,node});
  for(const [name,child] of Object.entries((node.properties??{}) as Record<string,unknown>))schemaNodes(child,`${path}.properties.${name}`,out);
  if(node.items)schemaNodes(node.items,path+'.items',out);
  for(const [index,child] of ((node.anyOf??[]) as unknown[]).entries())schemaNodes(child,`${path}.anyOf[${index}]`,out);
  return out;
}

test('the Gemini setup built from the real OPS tools uses only documented Schema keys',async()=>{
  const tools=await realOpsTools();
  const setup=geminiLiveSetup({model:'gemini-live-fixture',instructions:'fixture',mode:'conversation',tools}) as any;
  expect(Object.keys(setup)).toEqual(['setup']);
  expect(Object.keys(setup.setup).sort()).toEqual(['contextWindowCompression','generationConfig','inputAudioTranscription','model','outputAudioTranscription','systemInstruction','tools'].sort());
  const declarations=setup.setup.tools[0].functionDeclarations as any[];
  expect(declarations.map(d=>d.name)).toEqual(tools.map(t=>t.name));
  for(const [index,declaration] of declarations.entries()){
    expect(Object.keys(declaration).every(key=>['name','description','parameters'].includes(key))).toBe(true);
    expect(declaration.description).toBe(tools[index]!.description);
    for(const {path,node} of schemaNodes(declaration.parameters,declaration.name)){
      const unknown=Object.keys(node).filter(key=>!(GEMINI_SCHEMA_KEYS as readonly string[]).includes(key));
      expect(unknown,`${path} carries keys the Gemini Schema does not define`).toEqual([]);
      expect(['STRING','NUMBER','INTEGER','BOOLEAN','ARRAY','OBJECT']).toContain(node.type as string);
      if(node.enum)expect(node).toMatchObject({type:'STRING',format:'enum'});
    }
    // An OBJECT with no properties is rejected; a parameterless tool declares no parameters at all.
    if(declaration.parameters)expect(Object.keys(declaration.parameters.properties).length).toBeGreaterThan(0);
  }
  expect(JSON.stringify(setup)).not.toContain('additionalProperties');
  expect(declarations.map(({name,parameters})=>({name,...(parameters?{parameters}:{})}))).toEqual(golden.declarations);
});

test('dictation or a tool-less target sends no tools at all',async()=>{
  expect((geminiLiveSetup({model:'m',instructions:'i',mode:'dictation',tools:await realOpsTools()}) as any).setup.tools).toBeUndefined();
  expect((geminiLiveSetup({model:'m',instructions:'i',mode:'conversation',tools:[]}) as any).setup.tools).toBeUndefined();
  // The host's own review tool is sanitized the same way.
  expect(geminiFunctionDeclarations([{name:'prepare_instruction',description:'d',parameters:{type:'object',properties:{text:{type:'string'}},required:['text'],additionalProperties:false}}]))
    .toEqual([{name:'prepare_instruction',description:'d',parameters:{type:'OBJECT',properties:{text:{type:'STRING'}},required:['text']}}]);
});

class FakeSocket {
  static OPEN=1;readyState=1;sent:any[]=[];onopen:any;onmessage:any;onerror:any;onclose:any;closed=0;
  constructor(){queueMicrotask(()=>this.onopen?.({}));}
  send(data:string){this.sent.push(JSON.parse(data));}
  close(){this.closed++;}
  emit(message:unknown){return this.onmessage?.({data:JSON.stringify(message)});}
}

test('the Live socket carries the sanitized setup, drops cancelled tool calls and ends normally after goAway',async()=>{
  const original=globalThis.WebSocket;(globalThis as any).WebSocket=FakeSocket;
  try{
    let socket!:FakeSocket;const events:Record<string,any>[]=[];let disconnects=0;const abort=new AbortController();
    const input:VoiceProviderInput={key:'fixture-key',model:'gemini-live-fixture',voice:'',sdp:'',mode:'conversation',instructions:'fixture',tools:await realOpsTools(),signal:abort.signal,onEvent:e=>events.push(e),onDisconnect:()=>{disconnects++;}};
    const pending=connectGeminiLive(input,()=>{socket=new FakeSocket();return socket as unknown as WebSocket;});
    await Bun.sleep(5);
    expect(JSON.stringify(socket.sent[0])).not.toContain('additionalProperties');
    expect(socket.sent[0].setup.tools[0].functionDeclarations.length).toBe(input.tools.length);
    await socket.emit({setupComplete:{}});const connection=await pending;
    await socket.emit({toolCall:{functionCalls:[{id:'call_keep',name:'list_projects',args:{}},{id:'call_cancel',name:'list_projects',args:{query:'vibe'}}]}});
    expect(events.filter(e=>e.type==='response.function_call_arguments.done').map(e=>e.call_id)).toEqual(['call_keep','call_cancel']);
    await socket.emit({toolCallCancellation:{ids:['call_cancel']}});
    connection.send({type:'conversation.item.create',item:{type:'function_call_output',call_id:'call_cancel',output:'{}'}});
    connection.send({type:'conversation.item.create',item:{type:'function_call_output',call_id:'call_keep',output:'{"total":0}'}});
    const responses=socket.sent.filter(m=>m.toolResponse).map(m=>m.toolResponse.functionResponses[0].id);
    expect(responses).toEqual(['call_keep']);
    // goAway announces the server's own session end: that close is not a dropped connection.
    await socket.emit({goAway:{timeLeft:'5s'}});socket.onclose?.({});
    expect(disconnects).toBe(0);
    expect(events.at(-1)).toEqual({type:'session.provider_ending'});
    await connection.close();
  }finally{(globalThis as any).WebSocket=original;}
});

test('an unexpected Live close is still a dropped connection',async()=>{
  const original=globalThis.WebSocket;(globalThis as any).WebSocket=FakeSocket;
  try{
    let socket!:FakeSocket;let disconnects=0;const abort=new AbortController();
    const pending=connectGeminiLive({key:'k',model:'m',voice:'',sdp:'',mode:'conversation',instructions:'i',tools:[],signal:abort.signal,onEvent:()=>{},onDisconnect:()=>{disconnects++;}},()=>{socket=new FakeSocket();return socket as unknown as WebSocket;});
    await Bun.sleep(5);await socket.emit({setupComplete:{}});const connection=await pending;
    socket.onclose?.({});expect(disconnects).toBe(1);await connection.close();
  }finally{(globalThis as any).WebSocket=original;}
});
