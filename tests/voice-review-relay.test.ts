import {afterEach,expect,test} from 'bun:test';
import {VIBE2,authority,request,voiceWorld,output,until,call} from './fixtures/voice-world';
const cleanup:(()=>Promise<void>|void)[]=[];
afterEach(async()=>{for(const step of cleanup.splice(0).reverse())await step();});
test('a critical reread disagreement stays a draft in the original workroom until a person confirms it',async()=>{
 const w=await voiceWorld(cleanup);const sessionId=(await w.host.perform(request('prepare',{target:{kind:'ops'},mode:'conversation',consent:true,language:'ja'}),authority)).session!.id;
 await w.host.perform(request('connect',{sessionId,sdp:'v=0'}),authority);expect(w.provider.input?.language).toBe('ja');expect(w.provider.input?.instructions).toContain('Respond in 日本語');
 const connected=await call(w.provider,'connect_project_delegate',{targetId:VIBE2,agent:'claude'});const room=connected.activeTarget.sessionId;
 await until(async()=>(await output(w.terminal,room)).includes('READY:claude'),'test Claude ready');
 w.provider.event({type:'input_audio_buffer.committed',item_id:'review_number'});
 w.provider.event({type:'conversation.item.input_audio_transcription.completed',item_id:'review_number',transcript:'버전 1105 배포',recognition:{itemId:'review_number',text:'버전 1105 배포',source:'needs-confirmation'},primaryTranscript:'버전 1104 배포'});
 await until(async()=>!!(await w.host.perform(request('state',{sessionId}),authority)).session!.draft,'review draft');
 const s=(await w.host.perform(request('state',{sessionId}),authority)).session!;expect(s.draft?.text).toBe('버전 1105 배포');expect(await output(w.terminal,room)).not.toContain('GOT:');
 await w.host.perform(request('submit',{sessionId,draftId:s.draft!.id,text:'버전 1104 배포',inputReady:true}),authority);
 await until(async()=>(await output(w.terminal,room)).includes('GOT:claude:버전 1104 배포'),'explicitly corrected command');
 expect(await output(w.terminal,room)).not.toContain('GOT:claude:버전 1105 배포');
});
