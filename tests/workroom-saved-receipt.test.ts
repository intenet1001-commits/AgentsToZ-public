import {expect,test} from 'bun:test';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {projectMemoryCloseEvidence} from '../project-memory-server';
import {WORKROOM_CONTEXT_SAVE_REFUSALS,verifyWorkroomSaveReceipt,type WorkroomSavedPurpose} from '../src/workroomSavedReceipt';

const git=(cwd:string,...args:string[])=>{
  const r=Bun.spawnSync(['git',...args],{cwd,stdout:'pipe',stderr:'pipe',env:{...process.env,GIT_AUTHOR_NAME:'t',GIT_AUTHOR_EMAIL:'t@example.invalid',GIT_COMMITTER_NAME:'t',GIT_COMMITTER_EMAIL:'t@example.invalid'}});
  if(r.exitCode)throw Error(r.stderr.toString());
};
/** A project with a linked worktree where another agent works, and this Workroom's save receipt taken in the main one. */
function project(){
  const base=mkdtempSync(join(tmpdir(),'workroom-saved-receipt-')),root=join(base,'main'),linked=join(base,'linked');
  mkdirSync(root);git(root,'init','-b','main');writeFileSync(join(root,'a.txt'),'a');git(root,'add','.');git(root,'commit','-m','init');
  git(root,'worktree','add','-b','side',linked);
  const receipt={result:{localSaved:true},binding:3,evidence:projectMemoryCloseEvidence(root),startedAt:1_000};
  const verify=(purpose:WorkroomSavedPurpose,inputRevision=3,sameFolder=true)=>verifyWorkroomSaveReceipt({purpose,receipt,inputRevision,sameFolder:()=>sameFolder,projectEvidence:()=>projectMemoryCloseEvidence(root)});
  return {base,root,linked,receipt,verify};
}

test('another worktree changing after the save blocks closing the Workroom but not its /compact·/clear',async()=>{
  const p=project();
  try{
    expect(await p.verify('context')).toEqual({startedAt:1_000});
    expect(await p.verify('close')).toEqual({startedAt:1_000});
    // Another agent edits the linked worktree while this conversation sits saved and idle.
    writeFileSync(join(p.linked,'other-agent.txt'),'not this conversation');
    expect(projectMemoryCloseEvidence(p.root)).not.toBe(p.receipt.evidence);
    await expect(p.verify('close')).rejects.toThrow('저장 이후 활동 또는 프로젝트 변경이 있습니다. 다시 저장 후 종료하세요.');
    expect(await p.verify('context')).toEqual({startedAt:1_000});
    // Another agent's prompt in the same project (the project-wide activity marker) is not this conversation either.
    mkdirSync(join(p.root,'.agent-memory'),{recursive:true});
    writeFileSync(join(p.root,'.agent-memory','activity.json'),JSON.stringify({lastActivityAt:new Date().toISOString(),agent:'codex'}));
    await expect(p.verify('close')).rejects.toThrow();
    expect(await p.verify('context')).toEqual({startedAt:1_000});
  }finally{rmSync(p.base,{recursive:true,force:true});}
});

test('unsaved input in this conversation, no receipt or another folder still refuse the context command, in its own words',async()=>{
  const p=project();
  try{
    for(const failure of [p.verify('context',4),verifyWorkroomSaveReceipt({purpose:'context',receipt:null,inputRevision:3,sameFolder:()=>true,projectEvidence:()=>''}),
      verifyWorkroomSaveReceipt({purpose:'context',receipt:{...p.receipt,result:{localSaved:false}},inputRevision:3,sameFolder:()=>true,projectEvidence:()=>''})])
      await expect(failure).rejects.toThrow(WORKROOM_CONTEXT_SAVE_REFUSALS.unsaved);
    await expect(p.verify('context',3,false)).rejects.toThrow(WORKROOM_CONTEXT_SAVE_REFUSALS.folder);
    // The context refusals never borrow the close flow's 「종료」·「터미널 유지」.
    for(const message of Object.values(WORKROOM_CONTEXT_SAVE_REFUSALS)){expect(message).not.toMatch(/종료|터미널을 유지/);expect(message).toContain('명령을 보내지 않았습니다');}
    // Close keeps its own words.
    await expect(p.verify('close',4)).rejects.toThrow('현재 입력까지 저장된 결과가 확인되지 않아 터미널을 유지합니다.');
    await expect(p.verify('close',3,false)).rejects.toThrow('다시 저장 후 종료하세요');
  }finally{rmSync(p.base,{recursive:true,force:true});}
});
