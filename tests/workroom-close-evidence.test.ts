import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,utimesSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {projectMemoryCloseEvidence} from '../project-memory-server';
test('close evidence detects new project work without requiring a global V2 remembered baseline',()=>{
 const root=mkdtempSync(join(tmpdir(),'workroom-evidence-'));
 try{
  writeFileSync(join(root,'work.txt'),'before');mkdirSync(join(root,'.agent-memory'));
  const before=projectMemoryCloseEvidence(root);
  writeFileSync(join(root,'.agent-memory','CORE.md'),'memory saved');expect(projectMemoryCloseEvidence(root)).toBe(before);
  writeFileSync(join(root,'work.txt'),'after with more work');expect(projectMemoryCloseEvidence(root)).not.toBe(before);
  const after=projectMemoryCloseEvidence(root);
  writeFileSync(join(root,'.agent-memory','activity.json'),JSON.stringify({lastActivityAt:new Date().toISOString(),agent:'codex'}));expect(projectMemoryCloseEvidence(root)).not.toBe(after);
 }finally{rmSync(root,{recursive:true,force:true})}
});

for (const gitProject of [false, true]) test(`saving managed output rules does not invalidate close evidence (${gitProject ? 'git' : 'folder'})`,()=>{
 const root=mkdtempSync(join(tmpdir(),'workroom-managed-evidence-'));
 try{
  if(gitProject){
   const result=Bun.spawnSync(['git','init','-b','main'],{cwd:root,stdout:'pipe',stderr:'pipe'});
   expect(result.exitCode).toBe(0);
  }
  const rules=join(root,'.agents','rules');mkdirSync(rules,{recursive:true});
  const managed=join(rules,'agentstoz-output-style.md');
  writeFileSync(managed,'managed output style');
  const before=projectMemoryCloseEvidence(root);
  writeFileSync(managed,'managed output style');utimesSync(managed,new Date(),new Date(Date.now()+10_000));
  expect(projectMemoryCloseEvidence(root)).toBe(before);
  writeFileSync(join(rules,'my-project.md'),'user-authored project instructions');
  expect(projectMemoryCloseEvidence(root)).not.toBe(before);
 }finally{rmSync(root,{recursive:true,force:true})}
});
