import {expect,test} from 'bun:test';
import {ConversationTargetAliasError,resolveConversationTargetAlias} from '../src/conversationTargetAlias';

const projects=[
  {id:'ops_project',name:'AgentsToZ-Control',role:'ops' as const,scope:'main' as const},
  {id:'dev_project',name:'AgentsToZ_byCS',role:'dev' as const,scope:'main' as const},
  {id:'client_project',name:'별빛 정원',role:'managed' as const,scope:'main' as const},
  {id:'client_worktree',name:'별빛 정원 · feature',role:'managed' as const,scope:'worktree' as const},
];

test('shared voice and chat aliases resolve OPS and DEV deterministically',()=>{
  for(const alias of ['아젠투지','아젠투지 총괄','아젠투지OPS','AgentsToZ'])expect(resolveConversationTargetAlias(alias,projects).kind).toBe('ops');
  expect(resolveConversationTargetAlias('아젠투지 개발',projects)).toMatchObject({kind:'project',projectId:'dev_project',role:'dev'});
  expect(resolveConversationTargetAlias('아젠투지데브',projects)).toMatchObject({kind:'project',projectId:'dev_project'});
});

test('project manager alias requires and exactly matches the registered project name',()=>{
  expect(resolveConversationTargetAlias('프로젝트담당자 별빛 정원',projects)).toMatchObject({kind:'project',projectId:'client_project'});
  expect(resolveConversationTargetAlias('별빛 정원 프로젝트 담당자',projects)).toMatchObject({kind:'project',projectId:'client_project'});
  expect(()=>resolveConversationTargetAlias('프로젝트담당자',projects)).toThrow('프로젝트명');
  expect(()=>resolveConversationTargetAlias('프로젝트담당자 별빛',projects)).toThrow('찾지 못했습니다');
});

test('ambiguous DEV and duplicate project names never select one implicitly',()=>{
  expect(()=>resolveConversationTargetAlias('아젠투지개발',[...projects,{id:'dev2',name:'Other',role:'dev' as const,scope:'main' as const}])).toThrow('여러 개');
  expect(()=>resolveConversationTargetAlias('프로젝트담당자 별빛 정원',[...projects,{id:'duplicate',name:'별빛정원',role:'managed' as const,scope:'main' as const}])).toThrow('여러 개');
});

test('the natural "<프로젝트> 담당자" phrasing resolves like 프로젝트담당자, but a full-name match wins',()=>{
  // 2026-09-28 실측: MCP에서 '헤르메스 프로젝트담당자'는 풀렸지만 '헤르메스 담당자'는 NOT_FOUND였다.
  expect(resolveConversationTargetAlias('별빛 정원 담당자',projects)).toMatchObject({kind:'project',projectId:'client_project'});
  expect(resolveConversationTargetAlias('담당자 별빛 정원',projects)).toMatchObject({kind:'project',projectId:'client_project'});
  expect(()=>resolveConversationTargetAlias('담당자',projects)).toThrow('프로젝트명');
  const named=[...projects,{id:'cs_owner',name:'CS 담당자',role:'managed' as const,scope:'main' as const},{id:'cs',name:'CS',role:'managed' as const,scope:'main' as const}];
  expect(resolveConversationTargetAlias('CS 담당자',named)).toMatchObject({projectId:'cs_owner'});
  expect(resolveConversationTargetAlias('CS 프로젝트담당자',named)).toMatchObject({projectId:'cs'});
  expect(()=>resolveConversationTargetAlias('별빛 정원 담당자',[...projects,{id:'duplicate',name:'별빛정원',role:'managed' as const,scope:'main' as const}])).toThrow('여러 개');
});

test('a project can also be called by its exact alias (별명) when no project name matches',()=>{
  const listed=[...projects,
    {id:'nh',name:'nhdesign-marketplace',aliases:['NH Design Dashboard'],role:'managed' as const,scope:'main' as const},
    {id:'yt',name:'youtube_auto1',aliases:['YouTube Auto Bot'],role:'managed' as const,scope:'main' as const},
    {id:'yt2',name:'youtube_auto2',aliases:['YouTube Auto Bot'],role:'managed' as const,scope:'main' as const},
    {id:'named',name:'NH Design Dashboard',role:'managed' as const,scope:'main' as const},
  ];
  expect(resolveConversationTargetAlias('nhdesign-marketplace 담당자',listed)).toMatchObject({projectId:'nh'});
  // A registered NAME always wins over someone else's alias.
  expect(resolveConversationTargetAlias('NH Design Dashboard 담당자',listed)).toMatchObject({projectId:'named'});
  expect(resolveConversationTargetAlias('NH design dashboard 담당자',listed.filter(p=>p.id!=='named'))).toMatchObject({projectId:'nh'});
  expect(()=>resolveConversationTargetAlias('YouTube Auto Bot 담당자',listed)).toThrow('여러 개');
  // Aliases never reach worktrees.
  expect(()=>resolveConversationTargetAlias('Feature Alias',[{id:'wt',name:'x',aliases:['Feature Alias'],scope:'worktree' as const}])).toThrow('찾지 못했습니다');
});

test('a miss returns the registered names so the calling AI can map spoken 「바이브2」 to vibe2 itself',()=>{
  const listed=[...projects,{id:'vibe',name:'vibe2',aliases:['vibe claude guide'],role:'managed' as const,scope:'main' as const}];
  let caught:unknown;
  try{resolveConversationTargetAlias('바이브2 담당자',listed);}catch(error){caught=error;}
  expect(caught).toBeInstanceOf(ConversationTargetAliasError);
  const error=caught as ConversationTargetAliasError;
  expect(error.code).toBe('TARGET_ALIAS_NOT_FOUND');
  expect(error.candidates).toContainEqual({id:'vibe',name:'vibe2',aliases:['vibe claude guide']});
  expect(error.candidates.some(candidate=>candidate.id==='client_worktree')).toBe(false);
  expect(error.message).toContain('정확한 이름');
  // The exact name then resolves; 「… 프로젝트」 (as in "vibe2 프로젝트 열어") works too.
  expect(resolveConversationTargetAlias('vibe2 담당자',listed)).toMatchObject({projectId:'vibe'});
  expect(resolveConversationTargetAlias('vibe2 프로젝트',listed)).toMatchObject({projectId:'vibe'});
});

test('an ambiguous 아젠투지개발 lists the DEV candidates instead of failing bare',()=>{
  const listed=[...projects,{id:'dev2',name:'AgentsToZ_byCS 사본',role:'dev' as const,scope:'main' as const},{id:'dev_wt',name:'AgentsToZ_byCS · feature',role:'dev' as const,scope:'worktree' as const}];
  let caught:unknown;
  try{resolveConversationTargetAlias('아젠투지개발',listed);}catch(error){caught=error;}
  const error=caught as ConversationTargetAliasError;
  expect(error).toBeInstanceOf(ConversationTargetAliasError);
  expect(error.code).toBe('TARGET_ALIAS_AMBIGUOUS');
  // Only the tied DEV mains: never a worktree, never a managed project.
  expect(error.candidates.map(candidate=>candidate.id).sort()).toEqual(['dev2','dev_project']);
  // No DEV project at all: nothing to pick from, so no project is suggested as DEV.
  try{resolveConversationTargetAlias('아젠투지개발',projects.filter(project=>project.role!=='dev'));throw new Error('expected a miss');}
  catch(miss){expect((miss as ConversationTargetAliasError).candidates).toEqual([]);}
});

test('an ambiguous name lists only the tied candidates',()=>{
  const listed=[...projects,{id:'duplicate',name:'별빛정원',role:'managed' as const,scope:'main' as const}];
  try{resolveConversationTargetAlias('별빛 정원 담당자',listed);throw new Error('expected ambiguity');}
  catch(error){expect((error as ConversationTargetAliasError).candidates.map(candidate=>candidate.id).sort()).toEqual(['client_project','duplicate']);}
});
