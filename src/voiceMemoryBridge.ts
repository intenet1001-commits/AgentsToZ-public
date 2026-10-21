import {createHash} from 'node:crypto';
import type {VoiceHistoryStore} from './voiceHistoryStore';
import type {VoiceHistoryIdentity} from './voiceHistoryProtocol';
import type {MemorySaveSource} from './memorySaveContract';
import {saveDigest} from './memorySaveContract';
import type {MemoryInputSource} from './memorySaveInputMaterializer';
import type {AutomaticMemoryTarget} from './memorySaveAutomaticHost';
import type {MemorySaveStore} from './memorySaveStore';
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
/** A genuine encrypted voice adapter; no synthetic Claude/Codex transcript files. */
export class VoiceMemoryBridge {
 private cursors=new Map<string,number>();
 constructor(private d:{store:VoiceHistoryStore;identity:(targetId:string)=>Promise<VoiceHistoryIdentity>;saves:MemorySaveStore}){}
 async observe(target:AutomaticMemoryTarget,instanceId:string){
  const identity=await this.d.identity(target.id);if(identity.memoryScope==='ops')return;if(identity.memoryId!==target.memoryId)throw Error('음성 기억 대상이 변경되었습니다.');
  const page=await this.d.store.evidencePage(identity,this.cursors.get(target.id)??0);
  if(!await target.validate())throw Error('음성 기억 대상이 변경되었습니다.');
  this.d.saves.observeBatch(page.items.map(item=>({agent:'voice',instanceId,memoryId:target.memoryId,policyEpoch:1,sessionId:item.sessionId,
   turnId:'voice_'+item.sequence,startByte:0,endByte:Buffer.byteLength(item.text),sourceDigest:hash(item.text),completedAt:item.completedAt,coverageKind:'complete-turn'})));
  this.cursors.delete(target.id);this.cursors.set(target.id,page.next??0);while(this.cursors.size>128)this.cursors.delete(this.cursors.keys().next().value!);
 }
 source(target:AutomaticMemoryTarget,instanceId:string,source:MemorySaveSource):MemoryInputSource{
  if(source.agent!=='voice'||source.instanceId!==instanceId||source.memoryId!==target.memoryId||!/^voice_\d+$/.test(source.turnId))throw Error('음성 기억 원본을 확인하세요.');
  return {source,path:target.cwd,transcriptRoot:target.cwd,binding:{agent:'voice',instanceId,sessionId:source.sessionId,cwd:target.cwd,memoryId:source.memoryId,policyEpoch:source.policyEpoch},readVoice:async()=>{
   if(!await target.validate())throw Error('음성 기억 대상이 변경되었습니다.');
   const identity=await this.d.identity(target.id);
   const item=await this.d.store.evidenceSequence(identity,source.sessionId,Number(source.turnId.slice(6)));
   if(identity.memoryScope==='ops'||identity.memoryId!==source.memoryId||item.completedAt!==source.completedAt||!await target.validate())throw Error('음성 기억 대상이 변경되었습니다.');
   return Buffer.from(item.text);
  }};
 }
 async legacy(identity:VoiceHistoryIdentity){
  if(identity.memoryScope==='ops')return {text:'',acknowledge:async()=>{},digest:saveDigest([])};
  const page=await this.d.store.evidencePage(identity,0,true),items:typeof page.items=[];let bytes=0;
  for(const item of page.items){const n=Buffer.byteLength(item.text)+1;if(bytes+n>16000){if(!items.length)throw Error('긴 음성 발언을 먼저 내가 한 말에서 검토하세요. 원본은 유지됩니다.');break;}items.push(item);bytes+=n;}
  return {text:items.length?'VOICE SESSION EVIDENCE (speech recognition; not execution receipts):\n'+items.map(v=>v.text).join('\n'):'',
   acknowledge:()=>this.d.store.acknowledge(identity,items),digest:saveDigest(items.map(i=>[i.sessionId,i.itemId,i.role,hash(i.text)]))};
 }
}
