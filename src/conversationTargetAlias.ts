import {rankBySpokenName} from './spokenNameRank';

export type ConversationTargetProject = {
  id:string;
  name:string;
  role?:'ops'|'dev'|'managed'|'unknown';
  scope?:'main'|'worktree';
  /** Display aliases (별명, aiName). Matched exactly, only when no registered name matches. */
  aliases?:readonly string[];
};

export type ConversationTargetResolution =
  | {kind:'ops';label:'AgentsToZ OPS'}
  | {kind:'project';projectId:string;projectName:string;role:'ops'|'dev'|'managed'|'unknown'};

export type ConversationTargetCandidate = {id:string;name:string;aliases?:string[]};

/** Most registered names a miss returns; enough for every project on a busy Mac. */
export const CONVERSATION_TARGET_MAX_CANDIDATES = 200;

export class ConversationTargetAliasError extends Error {
  constructor(
    message:string,
    readonly code:'TARGET_ALIAS_PROJECT_REQUIRED'|'TARGET_ALIAS_NOT_FOUND'|'TARGET_ALIAS_AMBIGUOUS',
    /**
     * The exact registered names the caller may choose from. Voice transcribes English names
     * phonetically (「바이브2」 for vibe2), so an exact resolver misses them; the calling AI maps
     * the spoken form onto one of these and calls again with that exact name — the resolver itself
     * never guesses. A miss lists the names that sound most like what was said first.
     */
    readonly candidates:readonly ConversationTargetCandidate[]=[],
    /** How many candidates there were before the list was cut to CONVERSATION_TARGET_MAX_CANDIDATES. */
    readonly total:number=candidates.length,
  ){
    super(message);this.name='ConversationTargetAliasError';
  }
}

export const AGENTSTOZ_TARGET_ALIAS_GUIDANCE =
  '음성과 채팅은 같은 대상 호칭을 사용합니다. 아젠투지·아젠투지총괄·아젠투지오피에스·아젠투지 운영은 현재 OPS 운영 프로필, 아젠투지개발·아젠투지데브는 role=dev인 현재 등록 프로젝트, “프로젝트담당자 + 프로젝트명” 또는 “프로젝트명 + 프로젝트담당자”(“프로젝트명 + 담당자”도 같음)는 그 이름의 현재 등록 프로젝트를 뜻합니다. 프로젝트명만 부른 경우도 정확히 같은 이름으로 해석하고, 같은 이름이 없을 때만 정확히 같은 별명을 봅니다. 공백과 영문 대소문자만 무시하며, 동명 또는 DEV 후보가 여러 개면 임의 선택하지 말고 정확한 후보를 확인합니다.';

const normalized=(value:string)=>value.normalize('NFKC').replace(/\s+/g,'').toLocaleLowerCase('ko-KR');
const OPS_ALIASES=new Set(['아젠투지','에이전츠투지','agentstoz','아젠투지총괄','아젠투지오피에스','아젠투지ops','아젠투지운영'].map(normalized));
const DEV_ALIASES=new Set(['아젠투지개발','아젠투지데브'].map(normalized));
const PROJECT_MANAGER=normalized('프로젝트담당자');
const MANAGER=normalized('담당자');
const PROJECT=normalized('프로젝트');

function candidate(project:ConversationTargetProject):ConversationTargetCandidate{
  const aliases=(project.aliases??[]).filter(alias=>alias.trim()&&normalized(alias)!==normalized(project.name));
  return aliases.length?{id:project.id,name:project.name,aliases:[...aliases]}:{id:project.id,name:project.name};
}

function projectRole(project:ConversationTargetProject):'ops'|'dev'|'managed'|'unknown'{
  return project.role==='ops'||project.role==='dev'||project.role==='managed'?project.role:'unknown';
}

/** Resolve a user-spoken target only against the current, server-provided inventory. */
export function resolveConversationTargetAlias(alias:string,projects:readonly ConversationTargetProject[]):ConversationTargetResolution{
  const value=normalized(alias);
  if(!value)throw new ConversationTargetAliasError('호칭을 확인하세요.','TARGET_ALIAS_NOT_FOUND');
  if(OPS_ALIASES.has(value))return {kind:'ops',label:'AgentsToZ OPS'};
  if(DEV_ALIASES.has(value)){
    const candidates=projects.filter(project=>project.role==='dev'&&(project.scope===undefined||project.scope==='main'));
    // Several DEV mains: hand back exactly those so the caller asks which one. None: suggest nothing,
    // because any other project offered here would be a guess at DEV.
    if(candidates.length!==1)throw new ConversationTargetAliasError(candidates.length?'아젠투지개발 대상이 여러 개입니다. candidates에서 정확한 프로젝트를 사용자에게 확인해 주세요.':'role=dev인 현재 등록 프로젝트를 찾지 못했습니다.','TARGET_ALIAS_AMBIGUOUS',candidates.slice(0,CONVERSATION_TARGET_MAX_CANDIDATES).map(candidate),candidates.length);
    const selected=candidates[0]!;return {kind:'project',projectId:selected.id,projectName:selected.name,role:projectRole(selected)};
  }
  const mains=projects.filter(project=>project.scope===undefined||project.scope==='main');
  // A registered name always wins over another project's alias.
  const matching=(name:string)=>{
    const byName=mains.filter(project=>normalized(project.name)===name);
    return byName.length?byName:mains.filter(project=>(project.aliases??[]).some(alias=>normalized(alias)===name));
  };
  // A project literally named "… 담당자" is matched by its full name first. Otherwise the
  // title is stripped: 프로젝트담당자, then the natural "<프로젝트> 담당자" people actually say
  // (2026-09-28: '헤르메스 담당자' was NOT_FOUND while '헤르메스 프로젝트담당자' resolved).
  let candidates=matching(value),requested=value;
  if(!candidates.length){
    for(const title of [PROJECT_MANAGER,MANAGER,PROJECT]){
      if(!value.startsWith(title)&&!value.endsWith(title))continue;
      requested=value.startsWith(title)?value.slice(title.length):value.slice(0,-title.length);
      if(!requested)throw new ConversationTargetAliasError('프로젝트담당자 뒤에 담당 프로젝트명을 말해 주세요.','TARGET_ALIAS_PROJECT_REQUIRED');
      candidates=matching(requested);
      break;
    }
  }
  if(candidates.length!==1){
    const ambiguous=candidates.length>1;
    // A miss puts the names that sound like what was said first (바이브2 → vibe2): the list is cut
    // here at 200 and voice sends only a page of it (spokenNameRank.ts). It is an order, not a pick.
    const pool=ambiguous?candidates:rankBySpokenName(requested,mains);
    throw new ConversationTargetAliasError(ambiguous
      ?'같은 이름의 프로젝트가 여러 개입니다. candidates에서 정확한 대상을 사용자에게 확인해 주세요.'
      :'현재 등록 프로젝트에서 해당 이름을 찾지 못했습니다. 발음대로 적힌 이름(예: 바이브2 → vibe2)일 수 있으니 candidates에서 같은 프로젝트를 골라 그 정확한 이름으로 다시 확인하고, 확실하지 않으면 사용자에게 물어보세요.',
    ambiguous?'TARGET_ALIAS_AMBIGUOUS':'TARGET_ALIAS_NOT_FOUND',pool.slice(0,CONVERSATION_TARGET_MAX_CANDIDATES).map(candidate),pool.length);
  }
  const selected=candidates[0]!;return {kind:'project',projectId:selected.id,projectName:selected.name,role:projectRole(selected)};
}
