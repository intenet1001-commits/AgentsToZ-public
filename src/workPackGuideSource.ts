import {createHash} from 'node:crypto';
import type {PromptGuideEntry,PromptGuideSnapshot} from './promptGuideStore';
import {readToolIdentifier} from './readToolBundle';
import type {WorkPackGuideSource,WorkPackSourceReference} from './workPack';
import type {WorkPackSourceReader} from './workPackStore';

/** This device's local command library. Shared/synced libraries are not pack sources yet. */
export const LOCAL_WORK_PACK_LIBRARY='local-guides';
export const LOCAL_WORK_PACK_ACCOUNT='this-device';
const sha256=(value:string)=>createHash('sha256').update(value,'utf8').digest('hex');
const identifier=(value:string)=>{try{readToolIdentifier(value);return true;}catch{return false;}};

/** Incarnation decision (2026-10-24): the guide store keeps no delete/reimport history, so a
 * pack binds to the command ID and its exact body. A changed body makes the pack stale and a
 * missing ID makes it an orphan; an identical body under the same ID is the same command.
 * Packs only run the five read-only operations, so that equivalence cannot widen authority. */
export function commandSourceRevision(entry:Pick<PromptGuideEntry,'id'|'body'>):string {
 return 'cmd-'+sha256(`${entry.id}\0${sha256(entry.body)}`).slice(0,40);
}
export function localCommandSource(snapshot:PromptGuideSnapshot,entry:PromptGuideEntry):WorkPackGuideSource {
 const supported=identifier(entry.id)&&identifier(snapshot.revision);
 return {sourceLibraryId:LOCAL_WORK_PACK_LIBRARY,accountId:LOCAL_WORK_PACK_ACCOUNT,libraryRevision:supported?snapshot.revision:'unsupported',
  guideId:supported?entry.id:'unsupported',commandBodyHash:sha256(entry.body),sourceRevision:commandSourceRevision(entry),
  kind:entry.kind==='command'?'command':'simple',presence:'present',virtual:false,provenance:supported?'verified':'unknown',supported};
}
/** Reads the current local guide snapshot for each check; it never writes the guide store. */
export function createLocalWorkPackSourceReader(guides:{read():Promise<PromptGuideSnapshot>}):WorkPackSourceReader {
 return async(binding:WorkPackSourceReference)=>{
  const snapshot=await guides.read(),entry=snapshot.entries.find(item=>item.id===binding.guideId);
  if(entry&&binding.sourceLibraryId===LOCAL_WORK_PACK_LIBRARY&&binding.accountId===LOCAL_WORK_PACK_ACCOUNT)return localCommandSource(snapshot,entry);
  // A deleted command keeps the binding's identity so the definition reads as an orphan.
  return {...binding,libraryRevision:identifier(snapshot.revision)?snapshot.revision:binding.libraryRevision,kind:null,presence:'deleted',virtual:false,provenance:'verified',supported:true};
 };
}
