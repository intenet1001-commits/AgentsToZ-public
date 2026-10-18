import {afterEach,expect,test} from 'bun:test';
import {mkdirSync,mkdtempSync,rmSync,statSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {collectWhatISaidTranscripts} from '../src/whatISaidTranscriptCollector';
import {enableWhatISaidCapture,listWhatISaidEntries} from '../src/whatISaidStore';
import {claudeProjectSlug} from '../src/sessionTranscript';
import {MemoryObservationDiscovery} from '../src/memoryObservationDiscovery';
import {CliAccountStore} from '../src/cliAccountStore';
import {CliAccountManager} from '../src/cliAccountManager';
const dirs:string[]=[];
afterEach(()=>{for(const path of dirs.splice(0))rmSync(path,{recursive:true,force:true});});
function fixture(){const root=mkdtempSync(join(tmpdir(),'atz-account-observers-'));dirs.push(root);const projectRoot=join(root,'project'),appDataDir=join(root,'app-data');mkdirSync(projectRoot);mkdirSync(appDataDir);return {root,projectRoot,appDataDir,memoryId:'account-observer-memory',key:Buffer.alloc(32,7)};}
const now='2026-10-12T10:00:00Z';
function codex(root:string,cwd:string,text:string){mkdirSync(root,{recursive:true});const path=join(root,'rollout-'+crypto.randomUUID()+'.jsonl');const id=crypto.randomUUID();writeFileSync(path,[{type:'session_meta',timestamp:now,payload:{id,cwd,source:'cli'}},{type:'event_msg',timestamp:now,payload:{type:'user_message',message:text}}].map(value=>JSON.stringify(value)).join('\n')+'\n');return path;}
test('registered account transcripts obey existing project consent and exact project ownership',()=>{
 const f=fixture(),extraCodex=join(f.root,'account-codex'),extraClaude=join(f.root,'account-claude'),foreign=join(f.root,'foreign');mkdirSync(foreign);
 codex(extraCodex,f.projectRoot,'추가 Codex 계정');codex(extraCodex,foreign,'다른 프로젝트');
 const slug=join(extraClaude,claudeProjectSlug(f.projectRoot));mkdirSync(slug,{recursive:true});
 writeFileSync(join(slug,'session.jsonl'),JSON.stringify({type:'user',timestamp:now,uuid:crypto.randomUUID(),sessionId:'session-account-1234',cwd:f.projectRoot,message:{role:'user',content:'추가 Claude 계정'}})+'\n');
 const input={...f,claudeProjectsDir:join(f.root,'absent-claude'),codexSessionsDir:join(f.root,'absent-codex'),additionalClaudeProjectsDirs:[extraClaude],additionalCodexSessionsDirs:[extraCodex],worktreeRoots:[f.projectRoot],now:'2026-10-12T10:05:00Z'};
 expect(collectWhatISaidTranscripts(input).stored).toBe(0);
 enableWhatISaidCapture({...f,retention:'forever',now:'2026-10-12T09:00:00Z'});
 const collected=collectWhatISaidTranscripts(input);expect(collected.stored).toBe(2);
 expect(listWhatISaidEntries({...f,now:input.now}).items.map(item=>item.text).sort()).toEqual(['추가 Claude 계정','추가 Codex 계정'].sort());
 expect(collectWhatISaidTranscripts(input).stored).toBe(0);
});
test('all account roots share one scan byte budget',()=>{
 const f=fixture();enableWhatISaidCapture({...f,retention:'forever',now:'2026-10-12T09:00:00Z'});
 const roots=Array.from({length:3},(_,i)=>join(f.root,'account-'+i));for(const root of roots)codex(root,f.projectRoot,'prompt '.repeat(100));
 const r=collectWhatISaidTranscripts({...f,claudeProjectsDir:join(f.root,'absent'),codexSessionsDir:roots[0],additionalCodexSessionsDirs:roots.slice(1),worktreeRoots:[f.projectRoot],now:'2026-10-12T10:05:00Z',scanByteBudget:128});
 expect(r.bytesRead).toBeLessThanOrEqual(128);expect(r.budgetExhausted).toBe(true);expect(r.hasMore).toBe(true);
});
test('recent memory discovery preserves the exact account transcript root and ignores unmapped files',async()=>{
 const f=fixture(),codexRoot=join(f.root,'codex-account'),claudeRoot=join(f.root,'claude-account');
 const path=codex(codexRoot,f.projectRoot,'prompt'),foreign=codex(join(f.root,'other'),f.projectRoot,'foreign');
 const slug=join(claudeRoot,claudeProjectSlug(f.projectRoot));mkdirSync(slug,{recursive:true});const claude=join(slug,'session-12345678.jsonl');writeFileSync(claude,'{}\n');
 const files=[path,foreign].map(full=>({full,size:statSync(full).size,mtimeMs:statSync(full).mtimeMs}));
 const discovery=new MemoryObservationDiscovery({codexRoot:join(f.root,'default-codex'),claudeRoot:join(f.root,'default-claude'),codexFiles:async()=>files,codexRootForFile:p=>p===path?codexRoot:null,additionalClaudeRoots:()=>[claudeRoot]});
 expect(await discovery.discover(f.projectRoot)).toEqual(expect.arrayContaining([expect.objectContaining({agent:'codex',path,transcriptRoot:codexRoot}),expect.objectContaining({agent:'claude',path:claude,transcriptRoot:claudeRoot})]));
 expect((await discovery.discover(f.projectRoot)).some(s=>s.path===foreign)).toBe(false);
});
test('account root discovery is host-only and archival retires its future observation root',async()=>{
 const f=fixture(),store=new CliAccountStore(f.appDataDir),a=await store.create('codex','A',crypto.randomUUID());
 const manager=new CliAccountManager({store,executable:()=>null});expect(manager.transcriptDirectories('codex')).toEqual([join(store.directory(a.id),'sessions')]);
 expect(JSON.stringify(manager.list('codex'))).not.toContain(store.root);
 await store.edit(a.id,null,crypto.randomUUID(),()=>false);expect(manager.transcriptDirectories('codex')).toEqual([]);
});
