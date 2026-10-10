import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, realpathSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { initializeProjectMemory, prepareProjectMemorySession, applyProjectMemorySession,
  readProjectMemoryJournal, readProjectMemoryDeviceState, readMemoryDocument } from '../project-memory-server';
import { MemorySessionStore } from '../src/memorySessionStore';
import { applyPreparedMemoryDocumentTransaction } from '../src/memoryDocumentTransaction';

function fixture(next = '# Project Core Memory\n\n## Key Decisions\n\n### Prepared decision\nKeep verified evidence.\n') {
  const root = realpathSync(mkdtempSync(join(tmpdir(),'session-recovery-')));
  const status = initializeProjectMemory({folderPath:root,autoBackup:false});
  const store = new MemorySessionStore(join(root,'host','sessions.sqlite'));
  const plan = prepareProjectMemorySession({root,memoryPath:status.memoryPath!,next,narrative:'Exact prepared session',agent:'codex',recordedAt:'2026-09-07T01:00:00Z'});
  store.prepare(plan);
  return {root,store,plan,next,clean:()=>rmSync(root,{recursive:true,force:true})};
}

for (const stage of ['document','journal','state','outcome']) {
  test(`session recovery resumes after ${stage} without new journal or activity timestamp`, () => {
    const f=fixture();
    try {
      expect(()=>applyProjectMemorySession(f.store,f.root,f.plan.id,at=>{if(at===stage)throw new Error('crash');})).toThrow('crash');
      const restarted=new MemorySessionStore(f.store.path);
      expect(()=>restarted.assertReady(f.root)).toThrow('복구');
      applyProjectMemorySession(restarted,f.root,f.plan.id);
      expect(readFileSync(join(f.root,'.agent-memory/CORE.md'),'utf8')).toBe(f.next);
      expect(readProjectMemoryJournal(f.root).filter(e=>e.entryHash===f.plan.journal.entryHash)).toHaveLength(1);
      expect(readProjectMemoryDeviceState(f.root).lastRememberedAt).toBe('2026-09-07T01:00:00Z');
      expect(restarted.status(f.root)?.phase).toBe('outcome');
      restarted.finish(f.root,f.plan.id);
      expect(restarted.status(f.root)).toBeNull();
    } finally {f.clean();}
  });
}

test('partial config writes are recovered from the host proposal',()=>{
  const f=fixture();
  try {
    expect(()=>applyProjectMemorySession(f.store,f.root,f.plan.id,at=>{if(at==='journal')throw new Error('stop');})).toThrow();
    f.store.advance(f.root,f.plan.id,'journal','state');
    expect(()=>applyPreparedMemoryDocumentTransaction({root:f.root,memoryId:f.plan.memoryId,primaryPath:f.plan.sourcePath,
      sessionState:true,safePath:p=>join(f.root,p)},f.plan.state,{afterFile:()=>{throw new Error('partial');}})).toThrow();
    applyProjectMemorySession(new MemorySessionStore(f.store.path),f.root,f.plan.id);
    expect(readProjectMemoryDeviceState(f.root).lastRememberedAt).toBe(f.plan.journal.recordedAt);
  } finally {f.clean();}
});

test('external document/config edits and stale IDs retain the proposal and never overwrite',()=>{
  for(const changed of ['.agent-memory/CORE.md','.agent-memory/state.json']) {
    const f=fixture();
    try {
      expect(()=>applyProjectMemorySession(f.store,f.root,'stale')).toThrow();
      writeFileSync(join(f.root,changed),'external edit');
      expect(()=>applyProjectMemorySession(f.store,f.root,f.plan.id)).toThrow();
      expect(readFileSync(join(f.root,changed),'utf8')).toBe('external edit');
      expect(f.store.status(f.root)).not.toBeNull();
    } finally {f.clean();}
  }
});

test('future host database and oversized proposal fail closed',()=>{
  const f=fixture();
  try {
    expect(()=>f.store.prepare({...f.plan,id:'oversized',root:'another',journal:{...f.plan.journal,body:'x'.repeat(21*1024*1024)}})).toThrow();
    const db=new Database(f.store.path);db.run('PRAGMA user_version=999');db.close();
    expect(()=>new MemorySessionStore(f.store.path).status(f.root)).toThrow('최신');
  } finally {f.clean();}
});


test('a different process completes a session interrupted after durable journal append',async()=>{
  const f=fixture();
  try {
    const script=join(f.root,'interrupt.ts');
    writeFileSync(script,`
      import {MemorySessionStore} from ${JSON.stringify(join(import.meta.dir,'../src/memorySessionStore.ts'))};
      import {applyProjectMemorySession} from ${JSON.stringify(join(import.meta.dir,'../project-memory-server.ts'))};
      applyProjectMemorySession(new MemorySessionStore(process.argv[2]),process.argv[3],process.argv[4],stage=>{if(stage==='journal')process.exit(93);});
    `);
    const child=Bun.spawn([process.execPath,script,f.store.path,f.root,f.plan.id],{stdout:'ignore',stderr:'pipe'});
    expect(await child.exited).toBe(93);
    applyProjectMemorySession(new MemorySessionStore(f.store.path),f.root,f.plan.id);
    expect(readProjectMemoryJournal(f.root).filter(e=>e.entryHash===f.plan.journal.entryHash)).toHaveLength(1);
    expect(readProjectMemoryDeviceState(f.root).lastRememberedAt).toBe(f.plan.journal.recordedAt);
  } finally {f.clean();}
});


test('a decomposed session resumes from its exact index and notes without changing its document hash',()=>{
  const doc='# Project Core Memory\n\n## Key Decisions\n\n### Large evidence\n'+('Verified evidence.\n'.repeat(3000));
  const f=fixture(doc);
  try {
    expect(()=>applyProjectMemorySession(f.store,f.root,f.plan.id,at=>{if(at==='document')throw new Error('stop');})).toThrow();
    applyProjectMemorySession(f.store,f.root,f.plan.id);
    expect(readMemoryDocument(f.root,join(f.root,'.agent-memory/CORE.md'))).toBe(doc);
  } finally {f.clean();}
});
