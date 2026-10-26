import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {WorkroomTeamBuilder} from '../../src/WorkroomTeamBuilder';
import {hermesVariantItems} from '../../src/hermesVariants';

// The builder alone, as the Workroom composer mounts it: leader = this session's AI, goal = the current draft.
const f=window as any;f.composed=[];f.teamClosed=0;
function Harness(){
  const [open,setOpen]=useState(true);
  const leader=(new URLSearchParams(location.search).get('leader')??'claude') as 'claude';
  // Open sessions of this project: two sharing one worktree (only one may work there), one in the main checkout (review only).
  const openSessions=[{id:'s-wt0000',agent:'codex' as const,label:'Demo · codex #2',linked:true,checkout:'wt-a'},{id:'s-main00',agent:'hermes' as const,label:'Demo · hermes',linked:false,checkout:'main'},{id:'s-wt0002',agent:'claude' as const,label:'Demo · claude #3',linked:true,checkout:'wt-a'}];
  // This Mac's Hermes has an Anthropic credential only, and this host lists two Codex accounts.
  const variants=hermesVariantItems(new Set(['anthropic']));
  const accounts={codex:[{id:'host-default',label:'이 Mac 기본'},{id:'acct_12345678-1234-4123-8123-123456789abc',label:'회사 계정'}]};
  return <div style={{padding:8}}>{open?<WorkroomTeamBuilder leader={leader} initialGoal={String(f.initialGoal??'결제 오류를 고친다')} openSessions={openSessions} accounts={accounts} hermesVariants={variants} onCompose={text=>{f.composed.push(text);setOpen(false);}} onClose={()=>{f.teamClosed++;setOpen(false);}}/>:<button type="button" onClick={()=>setOpen(true)}>다시 열기</button>}</div>;
}
createRoot(document.getElementById('root')!).render(<Harness/>);
