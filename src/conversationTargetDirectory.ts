import {resolveProjectRoles,type ProjectRoleView} from './projectRole';
import {matchesSearchText} from './searchText';
import {
  ConversationTargetAliasError,resolveConversationTargetAlias,
  type ConversationTargetCandidate,type ConversationTargetResolution,
} from './conversationTargetAlias';

/**
 * One target directory for every conversation surface.
 *
 * Text (MCP resolve-target) and voice (resolve_target_alias, list_projects) used to build their
 * inventories separately. Voice named each project by its runtime label, which is aiName-first,
 * and read only the stored role (138/139 rows have none), so 「헤르메스 담당자」 and
 * 「아젠투지개발」 resolved in chat but not by voice (2026-09-28). Identity — name, aliases, role
 * and scope — now always comes from the registered row. The runtime inventory only decides which
 * targets exist right now and contributes Git worktrees that were never registered.
 */

/** One execution target of the Git-confirmed runtime inventory. Its label is aiName-first. */
export type ConversationDirectoryRuntimeTarget = {
  targetId:string;projectTargetId:string;label:string;scope:'main'|'worktree';branch:string|null;
};
export type ConversationDirectoryEntry = {
  id:string;
  /** The registered name — what the sidebar and the desktop card title show. */
  name:string;
  /** aiName and the runtime label when they differ from the name. Matched only when no name matches. */
  aliases?:string[];
  role:ProjectRoleView;
  scope:'main'|'worktree';
};

const clean=(value:unknown,limit:number)=>typeof value==='string'
  ? value.replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim().slice(0,limit)
  : '';
const trimmed=(value:unknown)=>typeof value==='string'?value.trim():'';
/** Same comparison the alias resolver uses: NFKC, no whitespace, lower case. */
const key=(value:string)=>value.normalize('NFKC').replace(/\s+/g,'').toLocaleLowerCase('ko-KR');

function aliasesFor(name:string,values:readonly string[]):string[]|undefined{
  const seen=new Set([key(name)]),aliases:string[]=[];
  for(const value of values){
    const normalized=value?key(value):'';
    if(!normalized||seen.has(normalized))continue;
    seen.add(normalized);aliases.push(value);
  }
  return aliases.length?aliases:undefined;
}

export function conversationTargetDirectory(input:{
  ports:readonly unknown[];
  /** Voice: the Git-confirmed runtime inventory. A registered row without a target does not exist now. */
  runtimeTargets?:readonly ConversationDirectoryRuntimeTarget[];
  /** Text: registered ids whose folder the project list confirmed. */
  available?:ReadonlySet<string>;
  /** The Control profile binding's project: OPS even when the row stores no role. */
  opsProjectId?:string|null;
  devProjectId?:string|null;
}):ConversationDirectoryEntry[]{
  const rows=(Array.isArray(input.ports)?input.ports:[])
    .filter((row):row is Record<string,unknown>=>!!row&&typeof row==='object'&&!Array.isArray(row))
    .map(row=>({
      id:trimmed(row.id),name:clean(row.name,120),aiName:clean(row.aiName,200),
      role:row.role===null?undefined:row.role,
      folderPath:trimmed(row.folderPath),worktreePath:trimmed(row.worktreePath),worktreeParentId:trimmed(row.worktreeParentId),
      // The role also reads the repository URL (a clone of AgentsToZ_byCS under another folder name is DEV);
      // without it the sidebar called such a clone DEV and chat/voice called it 관리 프로젝트.
      githubUrl:trimmed(row.githubUrl),
      githubUrls:Array.isArray(row.githubUrls)?row.githubUrls.filter((url):url is string=>typeof url==='string'):[],
    }));
  const counts=new Map<string,number>();
  for(const row of rows)if(row.id)counts.set(row.id,(counts.get(row.id)??0)+1);
  // A duplicated id is a corrupt registration. Neither surface may pick one of the copies
  // (the runtime inventory already drops every copy).
  const unique=rows.filter(row=>row.id&&counts.get(row.id)===1);
  const roles=resolveProjectRoles(unique.map(row=>({
    id:row.id,role:row.role,name:row.name||undefined,aiName:row.aiName||undefined,folderPath:row.folderPath||undefined,
    worktreePath:row.worktreePath||undefined,worktreeParentId:row.worktreeParentId||undefined,
    githubUrl:row.githubUrl||undefined,githubUrls:row.githubUrls,
  })),{opsProjectId:input.opsProjectId??null,devProjectId:input.devProjectId??null});
  const byId=new Map(unique.map(row=>[row.id,row]));
  const nameOf=(row:typeof unique[number])=>row.name||row.aiName||'등록 프로젝트';
  const runtime=input.runtimeTargets?new Map(input.runtimeTargets.map(target=>[target.targetId,target])):null;
  const entries:ConversationDirectoryEntry[]=[];
  for(const row of unique){
    if(input.available&&!input.available.has(row.id))continue;
    const target=runtime?.get(row.id);
    if(runtime&&!target)continue;
    const name=nameOf(row),aliases=aliasesFor(name,[row.aiName,clean(target?.label,200)]);
    entries.push({id:row.id,name,...(aliases?{aliases}:{}),role:roles.get(row.id)??'unknown',
      scope:row.worktreeParentId||row.worktreePath?'worktree':'main'});
  }
  for(const target of input.runtimeTargets??[]){
    // Registered rows are above. What remains is a linked worktree Git reported but nobody registered.
    if(byId.has(target.targetId)||target.scope!=='worktree')continue;
    const parent=byId.get(target.projectTargetId);
    if(!parent||input.available&&!input.available.has(parent.id))continue;
    const name=`${nameOf(parent)} · ${clean(target.branch,80)||'분리된 워크트리'}`.slice(0,120);
    const aliases=aliasesFor(name,[clean(target.label,200)]);
    entries.push({id:target.targetId,name,...(aliases?{aliases}:{}),role:roles.get(parent.id)??'unknown',scope:'worktree'});
  }
  return entries.sort((left,right)=>left.name.localeCompare(right.name,'ko')
    ||(left.scope===right.scope?0:left.scope==='main'?-1:1)
    ||(left.id<right.id?-1:left.id>right.id?1:0));
}

/** MCP resolve-target: registered rows whose folder `list-projects` confirmed. */
export function textConversationTargets(ports:readonly unknown[],options:{available:ReadonlySet<string>;opsProjectId?:string|null}):ConversationDirectoryEntry[]{
  return conversationTargetDirectory({ports,available:options.available,opsProjectId:options.opsProjectId});
}

/** Voice resolve_target_alias and list_projects: the Git-confirmed runtime inventory. */
export function voiceConversationTargets(ports:readonly unknown[],runtimeTargets:readonly ConversationDirectoryRuntimeTarget[],options:{opsProjectId?:string|null}):ConversationDirectoryEntry[]{
  return conversationTargetDirectory({ports,runtimeTargets,opsProjectId:options.opsProjectId});
}

export type ConversationTargetMiss = {
  resolved:false;code:ConversationTargetAliasError['code'];message:string;
  /** Candidates before any cut; `truncated` says `candidates` holds fewer (most likely first). */
  total:number;truncated:boolean;
  candidates:ConversationTargetCandidate[];
};
export type ConversationTargetOutcome = ({resolved:true}&ConversationTargetResolution) | ConversationTargetMiss;

/** The one resolution both surfaces report. The resolver never guesses; a miss carries candidates. */
export function resolveConversationTarget(alias:string,entries:readonly ConversationDirectoryEntry[]):ConversationTargetOutcome{
  try{return {resolved:true,...resolveConversationTargetAlias(alias,entries)};}
  catch(error){
    if(!(error instanceof ConversationTargetAliasError))throw error;
    const candidates=error.candidates.map(candidate=>({...candidate,...(candidate.aliases?{aliases:[...candidate.aliases]}:{})}));
    return {resolved:false,code:error.code,message:error.message,total:error.total,truncated:candidates.length<error.total,candidates};
  }
}

export const CONVERSATION_TARGET_PAGE_SIZE=40;
/** Well under the 16,000-byte voice tool result limit, with room for the envelope. */
export const CONVERSATION_TARGET_PAGE_BYTES=12_000;

/** One bounded page of the directory. A query matches the name or an alias, ignoring case and spaces. */
export function pageConversationTargets<T=ConversationDirectoryEntry>(entries:readonly ConversationDirectoryEntry[],options:{
  query?:string;offset?:number;limit?:number;present?:(entry:ConversationDirectoryEntry)=>T;
}):{total:number;offset:number;nextOffset:number|null;projects:T[]}{
  const wanted=options.query?key(options.query):'';
  const matching=wanted?entries.filter(entry=>[entry.name,...(entry.aliases??[])].some(value=>key(value).includes(wanted)||matchesSearchText(value,options.query!))):entries;
  const offset=Math.max(0,Math.floor(options.offset??0)),present=options.present??(entry=>entry as unknown as T);
  const limit=options.limit===undefined?CONVERSATION_TARGET_PAGE_SIZE:Math.max(1,Math.min(CONVERSATION_TARGET_PAGE_SIZE,Math.floor(options.limit)));
  const projects:T[]=[];let bytes=0,index=offset;
  for(;index<matching.length&&projects.length<limit;index++){
    const value=present(matching[index]!),size=Buffer.byteLength(JSON.stringify(value))+1;
    if(projects.length&&bytes+size>CONVERSATION_TARGET_PAGE_BYTES)break;
    projects.push(value);bytes+=size;
  }
  return {total:matching.length,offset,nextOffset:index<matching.length?index:null,projects};
}
