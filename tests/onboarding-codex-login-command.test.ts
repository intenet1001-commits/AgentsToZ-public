import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {codexLoginCommand} from '../src/onboardingCodexDiagnosis';
test('login handoff works before PATH refresh and keeps an existing PATH installation',()=>{
 if(process.platform==='win32')return;
 const root=mkdtempSync(join(tmpdir(),'codex login command '));
 try{
  const local=join(root,'.local/bin'),existing=join(root,'existing');mkdirSync(local,{recursive:true});mkdirSync(existing);
  writeFileSync(join(local,'codex'),'#!/bin/sh\nprintf "local:%s" "$1" > "$HOME/result"\n',{mode:0o700});
  writeFileSync(join(existing,'codex'),'#!/bin/sh\nprintf "existing:%s" "$1" > "$HOME/result"\n',{mode:0o700});
  execFileSync('/bin/sh',['-c',codexLoginCommand('mac')],{cwd:'/',env:{HOME:root,PATH:'/usr/bin:/bin'}});
  expect(readFileSync(join(root,'result'),'utf8')).toBe('local:login');
  execFileSync('/bin/sh',['-c',codexLoginCommand('linux')],{cwd:'/',env:{HOME:root,PATH:existing}});
  expect(readFileSync(join(root,'result'),'utf8')).toBe('existing:login');
  expect(codexLoginCommand('windows')).toBe('codex login');
 }finally{rmSync(root,{recursive:true,force:true});}
});
