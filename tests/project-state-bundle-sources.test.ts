import {afterEach,describe,expect,test} from 'bun:test';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,symlink,lstat,utimes,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createProjectStateBundleSources,createReadToolSourceAdapters,resolveProjectStateCheckout} from '../src/projectStateBundleSources';
import {parseProjectMemoryEntries} from '../src/projectMemoryRecall';
import {parseReadToolPlan,resolveReadToolInput,type ResolvedReadToolInput} from '../src/readToolBundle';
import type {ReadBudget,SectionId,TargetBinding,ReadToolSourceAdapters} from '../src/projectStateBundle';

const roots:string[]=[];
const git=(root:string,...args:string[])=>execFileSync('git',args,{cwd:root,stdio:['ignore','pipe','pipe']});
const budget=(max=1024*1024):ReadBudget=>{let bytes=0;return {deadline:Date.now()+3000,maxSourceBytes:max,maxTotalBytes:max,consume(count){bytes+=count;return bytes<=max;}};};
async function project(){
  const root=await mkdtemp(join(tmpdir(),'state-sources-'));roots.push(root);
  git(root,'init','-b','main');git(root,'config','user.email','fixture@example.invalid');git(root,'config','user.name','Fixture');
  await writeFile(join(root,'.gitignore'),'.agent-memory/\n.agentstoz/maintainer/\n');
  await writeFile(join(root,'tracked.txt'),'original\n');git(root,'add','.');git(root,'commit','-m','initial');return root;
}
const bind=(rootPath:string,authorityRevision='authority-v1')=>resolveProjectStateCheckout({rootPath,targetId:'project-1',projectId:'project-1',owner:'local',authorityRevision},new AbortController().signal);
const read=(binding:TargetBinding,id:SectionId,query?:string,max?:number)=>createProjectStateBundleSources()[id].read(binding,{id,query},budget(max),new AbortController().signal);
async function configure(root:string){await mkdir(join(root,'.agentstoz'),{recursive:true});await writeFile(join(root,'.agentstoz/maintainer.json'),JSON.stringify({schemaVersion:1,checks:[{id:'unit',argv:['bun','test']}],profiles:{quick:['unit']}}));git(root,'add','.agentstoz/maintainer.json');git(root,'commit','-m','tester config');}
function fingerprint(root:string){const head=git(root,'rev-parse','HEAD'),diff=git(root,'diff','--no-ext-diff','--no-textconv','--binary','HEAD'),untracked=git(root,'ls-files','--others','--exclude-standard','-z');expect(untracked.length).toBe(0);return createHash('sha256').update(head).update(diff).digest('hex');}
async function report(root:string,source?:{commit?:string;fingerprint?:string},id='20261024T100000Z-abcdef12'){
  const dir=join(root,'.agentstoz/maintainer/runs',id);await mkdir(dir,{recursive:true});
  await writeFile(join(dir,'report.json'),JSON.stringify({schemaVersion:1,runId:id,state:'passed',profile:'quick',startedAt:'2026-10-24T10:00:00Z',finishedAt:'2026-10-24T10:00:01Z',source,checks:[{id:'unit',state:'passed',output:'secret transcript /Users/person/private sk-12345678901234567890'}]}));
}
async function memory(root:string,body:string){await mkdir(join(root,'.agent-memory'),{recursive:true});await writeFile(join(root,'.agent-memory/config.json'),JSON.stringify({memoryId:'memory-1',sourcePath:'.agent-memory/CORE.md'}));await writeFile(join(root,'.agent-memory/CORE.md'),body);}
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
const toolRead=(adapters:ReadToolSourceAdapters,binding:TargetBinding,input:ResolvedReadToolInput,limits=budget(),signal=new AbortController().signal)=>adapters[input.operation]!.read(binding,input,limits,signal);

describe('bounded project state production sources',()=>{
  test('binds checkout and authority; same HEAD tracked/untracked content changes invalidate fresh proof',async()=>{
    const root=await project(),first=await bind(root),same=await bind(root);expect(first.proof).toBe(same.proof);expect(first.sourceProofComplete).toBe(true);
    expect((await bind(root,'authority-v2')).proof).not.toBe(first.proof);
    await writeFile(join(root,'tracked.txt'),'edited\n');const dirty=await bind(root);expect(dirty.proof).not.toBe(first.proof);
    await writeFile(join(root,'tracked.txt'),'edited again\n');expect((await bind(root)).proof).not.toBe(dirty.proof);
    await writeFile(join(root,'new.txt'),'one');const added=await bind(root);await writeFile(join(root,'new.txt'),'two');expect((await bind(root)).proof).not.toBe(added.proof);
    const observed=await read(await bind(root),'git');expect(observed.availability).toBe('ready');expect(observed.summary.join('\n')).toContain('unstaged 1, untracked 1');expect(observed.summary.join('\n')).toContain('file: tracked.txt');expect(JSON.stringify(observed)).not.toContain(root);
    git(root,'switch','-c','another');expect((await bind(root)).proof).not.toBe(added.proof);
  });

  test('isolated index preserves Git racy-index detection for a same-size change',async()=>{
    const root=await project(),indexPath=join(root,'.git/index'),tracked=join(root,'tracked.txt');
    const clean=await bind(root);expect(clean.sourceProofComplete).toBe(true);
    // Make the stat tuple match the changed file while the index still contains
    // the original blob. A same-second index mtime forces Git to rehash it.
    await writeFile(tracked,'changed!\n');const sec=Math.floor(Date.now()/1000)-120;await utimes(tracked,sec,sec);
    const stat=await lstat(tracked,{bigint:true}),index=await readFile(indexPath);
    let offset=12,found=false;for(let n=0;n<index.readUInt32BE(8);n++){
      const start=offset,flags=index.readUInt16BE(offset+60);offset+=62;if(flags&0x4000)offset+=2;
      const end=index.indexOf(0,offset);if(index.toString('utf8',offset,end)==='tracked.txt'){
        for(const [pos,ns] of [[0,stat.ctimeNs],[8,stat.mtimeNs]] as const){index.writeUInt32BE(Number(ns/1000000000n),start+pos);index.writeUInt32BE(Number(ns%1000000000n),start+pos+4);}found=true;
      }offset=start+Math.ceil((end+1-start)/8)*8;
    }
    expect(found).toBe(true);createHash('sha1').update(index.subarray(0,-20)).digest().copy(index,index.length-20);
    await writeFile(indexPath,index);await utimes(indexPath,sec,sec);
    expect(git(root,'diff','--no-ext-diff','--no-textconv','--binary','HEAD').toString()).toContain('changed!');
    const changed=await bind(root),result=await read(changed,'git');expect(changed.sourceProofComplete).toBe(true);
    expect(changed.proof).not.toBe(clean.proof);expect(result.summary.join('\n')).toContain('unstaged 1');
  });

  test('replacing the original index while probing withholds source proof',async()=>{
    const root=await project(),indexPath=join(root,'.git/index');let temporary='';
    const binding=await resolveProjectStateCheckout({rootPath:root,targetId:'project-1',projectId:'project-1',owner:'local',authorityRevision:'v1'},new AbortController().signal,{beforeIsolatedRead:async directory=>{
      temporary=directory;await writeFile(indexPath+'.replacement',await readFile(indexPath));await rename(indexPath+'.replacement',indexPath);
    }});
    expect(binding.sourceProofComplete).toBe(false);expect((await read(binding,'git')).availability).toBe('partial');await expect(lstat(temporary)).rejects.toThrow();
  });

  test('cached tester result requires both exact commit and maintainer source fingerprint',async()=>{
    const root=await project();await configure(root);const commit=git(root,'rev-parse','HEAD').toString().trim();await report(root,{commit,fingerprint:fingerprint(root)});
    let result=await read(await bind(root),'tester');expect(result.freshness).toBe('current');expect(result.summary.join('\n')).toContain('original result: passed');expect(JSON.stringify(result)).not.toMatch(/secret transcript|sk-123456|\/Users\//);
    await writeFile(join(root,'tracked.txt'),'dirty same HEAD\n');result=await read(await bind(root),'tester');expect(result.freshness).toBe('stale');
    await report(root,{commit});result=await read(await bind(root),'tester');expect(result.freshness).toBe('unknown');
    await report(root,{commit:'a'.repeat(40)});expect((await read(await bind(root),'tester')).freshness).toBe('stale');
  });

  test('tester excludes scenario and auto runs using existing cached profile selector',async()=>{
    const root=await project();await configure(root);await report(root);const dir=join(root,'.agentstoz/maintainer/runs/20261024T110000Z-abcdef13');await mkdir(dir,{recursive:true});await writeFile(join(dir,'report.json'),JSON.stringify({runId:'20261024T110000Z-abcdef13',state:'passed',profile:'auto',startedAt:'2026-10-24T11:00:00Z',checks:[]}));
    const result=await read(await bind(root),'tester');expect(result.summary.join('\n')).toContain('20261024T100000Z-abcdef12');expect(result.summary.join('\n')).not.toContain('abcdef13');
  });

  test('oversized source remains viewable as partial without claiming exact fingerprint',async()=>{
    const root=await project();await writeFile(join(root,'tracked.txt'),'different line\n'.repeat(30000));const binding=await bind(root);expect(binding.sourceProofComplete).toBe(false);
    const result=await read(binding,'git');expect(result.availability).toBe('partial');expect(result.freshness).toBe('unknown');expect(result.limits).toContain('SOURCE_FINGERPRINT_UNAVAILABLE_SEND_BLOCKED');
  });

  test('Git summary bounds relative paths and reports incomplete lower bounds on stdout overflow',async()=>{
    const root=await project();for(let i=0;i<25;i++)await writeFile(join(root,`file-${i}.txt`),'x');
    let result=await read(await bind(root),'git');expect(result.summary.filter(v=>v.startsWith('file:'))).toHaveLength(20);expect(result.limits).toContain('GIT_PATHS_LIMIT_20');
    const dir=join(root,'many');await mkdir(dir);for(let i=0;i<700;i++)await writeFile(join(dir,`${String(i).padStart(4,'0')}-${'x'.repeat(190)}.txt`),'x');
    const binding=await bind(root);result=await read(binding,'git');expect(binding.sourceProofComplete).toBe(false);expect(result.availability).toBe('partial');expect(result.summary.join('\n')).toContain('incomplete');expect(result.limits).toContain('GIT_STATUS_TRUNCATED_COUNTS_ARE_LOWER_BOUNDS');
  });

  test('repository clean/process filter configuration and includes never execute during preview',async()=>{
    const root=await project(),marker=join(root,'filter-marker');
    await writeFile(join(root,'.gitattributes'),'tracked.txt filter=review\n');git(root,'add','.gitattributes');git(root,'commit','-m','attributes');
    const hook=join(root,'filter.sh');await writeFile(hook,`#!/bin/sh\nprintf invoked > '${marker}'\ncat\n`);
    git(root,'config','filter.review.clean',`sh '${hook}'`);await writeFile(join(root,'tracked.txt'),'changed by test\n');
    let binding=await bind(root),result=await read(binding,'git');expect(binding.sourceProofComplete).toBe(false);expect(result.limits).toContain('GIT_FILTER_OR_SUBDIRECTORY_SCOPE_UNSUPPORTED');expect(result.summary.join('\n')).not.toContain('staged 0');
    await expect(lstat(marker)).rejects.toThrow();
    git(root,'config','--unset-all','filter.review.clean');const included=join(root,'.git/included-filter.conf');await writeFile(included,`[filter "review"]\n clean = sh '${hook}'\n`);git(root,'config','include.path',included);
    binding=await bind(root);result=await read(binding,'git');expect(binding.sourceProofComplete).toBe(false);expect(result.availability).toBe('partial');await expect(lstat(marker)).rejects.toThrow();
  });

  test('isolated status/diff cannot execute a clean driver inserted after the filter preflight',async()=>{
    const root=await project(),marker=join(root,'race-filter-marker'),hook=join(root,'race-filter.sh');
    await writeFile(join(root,'.gitattributes'),'tracked.txt filter=review\n');git(root,'add','.gitattributes');git(root,'commit','-m','attributes before driver');
    await writeFile(hook,`#!/bin/sh\nprintf invoked > '${marker}'\ncat\n`);await writeFile(join(root,'tracked.txt'),'changed for race\n');
    const indexBefore=await readFile(join(root,'.git/index')),indexStat=await lstat(join(root,'.git/index'));let temporary='';
    const binding=await resolveProjectStateCheckout({rootPath:root,targetId:'project-1',projectId:'project-1',owner:'local',authorityRevision:'v1'},new AbortController().signal,{beforeIsolatedRead:async directory=>{
      temporary=directory;expect((await lstat(directory)).mode&0o777).toBe(0o700);expect((await lstat(join(directory,'index'))).mode&0o777).toBe(0o600);
      git(root,'config','filter.review.clean',`sh '${hook}'`);
    }});
    expect(binding.sourceProofComplete).toBe(false);expect(temporary).toBeTruthy();await expect(lstat(marker)).rejects.toThrow();await expect(lstat(temporary)).rejects.toThrow();
    expect((await readFile(join(root,'.git/index'))).equals(indexBefore)).toBe(true);expect((await lstat(join(root,'.git/index'))).mtimeMs).toBe(indexStat.mtimeMs);
  });

  test('split and oversized indexes stay metadata-only without opening an unsafe worktree diff',async()=>{
    const root=await project();git(root,'update-index','--split-index');let binding=await bind(root);expect(binding.sourceProofComplete).toBe(false);expect((await read(binding,'git')).availability).toBe('partial');
    await writeFile(join(root,'.git/index'),Buffer.alloc(1024*1024+1));binding=await bind(root);expect(binding.sourceProofComplete).toBe(false);expect((await read(binding,'git')).summary.join('\n')).toContain('changes: unavailable');
  });

  test('registered Git subdirectories do not reveal sibling paths or exact parent-repository counts',async()=>{
    const root=await project();await mkdir(join(root,'nested'));await writeFile(join(root,'nested/local.txt'),'local');git(root,'add','nested');git(root,'commit','-m','nested');await writeFile(join(root,'sibling-secret.txt'),'changed');
    const binding=await bind(join(root,'nested')),result=await read(binding,'git');expect(result.availability).toBe('partial');expect(binding.sourceProofComplete).toBe(false);expect(result.summary.join('\n')).not.toContain('sibling-secret');expect(result.summary.join('\n')).not.toContain('file:');
  });

  test('memory is opt-in, uses canonical primary worktree and existing withdrawal selection without writes',async()=>{
    const root=await project();await memory(root,'## Decisions\n### Widget policy\nUse the canonical widget behavior.\n### Widget withdrawn\nOld widget claim.\n');
    const entries=parseProjectMemoryEntries((await readFile(join(root,'.agent-memory/CORE.md'),'utf8'))),withdrawn=entries[1]!;
    await mkdir(join(root,'.agent-memory/feedback'));await writeFile(join(root,'.agent-memory/feedback/events.jsonl'),JSON.stringify({id:'feedback-1',memoryId:'memory-1',entryKey:withdrawn.entryKey,contentVersionHash:withdrawn.contentVersionHash,kind:'corrected',recordedAt:'2026-10-24T10:00:00Z',evidence:'Widget behavior corrected.'})+'\n');
    const linked=join(root,'linked');git(root,'worktree','add','-b','linked',linked);await memory(linked,'## Decisions\n### Widget wrong copy\nDO NOT READ THE LINKED COPY.\n');
    const before=await readdir(join(root,'.agent-memory'));const binding=await bind(linked);
    const skipped=await read(binding,'memory');expect(skipped.limits).toContain('MEMORY_QUERY_NOT_SELECTED');
    const result=await read(binding,'memory','widget');expect(result.availability).toBe('ready');expect(result.summary.join('\n')).toContain('canonical widget behavior');expect(result.summary.join('\n')).not.toContain('DO NOT READ');expect(result.summary.join('\n')).not.toContain('Old widget claim');expect(result.summary.join('\n')).toContain('withheld; review required');
    expect(await readdir(join(root,'.agent-memory'))).toEqual(before);expect(await readdir(join(root,'.agent-memory'))).not.toContain('journal-index.sqlite');
    expect(JSON.stringify(result)).not.toContain(root);
  });

  test('bounded memory fails closed for oversized feedback, pending writes, symlinks and corrupt documents',async()=>{
    const root=await project();await memory(root,'## Decisions\n### Widget policy\nDo widget work.\n');const binding=await bind(root);
    await mkdir(join(root,'.agent-memory/feedback'));await writeFile(join(root,'.agent-memory/feedback/events.jsonl'),'x'.repeat(8000));let result=await read(binding,'memory','widget',4000);expect(result.availability).toBe('partial');expect(result.summary).toEqual([]);expect(result.errorCode).toBe('SOURCE_BYTE_LIMIT');
    await writeFile(join(root,'.agent-memory/feedback/events.jsonl'),'{broken\n');result=await read(binding,'memory','widget');expect(result.errorCode).toBe('SOURCE_FORMAT_INVALID');expect(result.summary).toEqual([]);
    await rm(join(root,'.agent-memory/feedback'),{recursive:true});await mkdir(join(root,'.agent-memory/backups'));await writeFile(join(root,'.agent-memory/backups/.pending-document-write.json'),'{}');result=await read(binding,'memory','widget');expect(result.errorCode).toBe('MEMORY_RECOVERY_REQUIRED');
    await rm(join(root,'.agent-memory/backups'),{recursive:true});await rm(join(root,'.agent-memory/CORE.md'));await symlink(join(root,'tracked.txt'),join(root,'.agent-memory/CORE.md'));result=await read(binding,'memory','widget');expect(result.errorCode).toBe('SOURCE_SYMLINK');
    await rm(join(root,'.agent-memory/CORE.md'));await writeFile(join(root,'.agent-memory/CORE.md'),'\xff');await writeFile(join(root,'.agent-memory/config.json'),'{broken');result=await read(binding,'memory','widget');expect(result.availability).toBe('unavailable');expect(result.summary).toEqual([]);
  });

  test('a confirmed standalone folder reports unconfigured Git and can read its own curated memory',async()=>{
    const root=await mkdtemp(join(tmpdir(),'state-standalone-'));roots.push(root);await memory(root,'## Widget\n### Widget standalone\nLocal widget context.\n');
    const binding=await bind(root);expect(binding.sourceProofComplete).toBe(false);expect((await read(binding,'git')).availability).toBe('unconfigured');expect((await read(binding,'tester')).availability).toBe('unconfigured');expect((await read(binding,'memory','widget')).summary.join('\n')).toContain('Local widget context.');
  });

  test('memory manifest uses shared composition, limits hits and redacts source secrets/absolute paths',async()=>{
    const root=await project();await memory(root,'index');await mkdir(join(root,'.agent-memory/notes'));
    await writeFile(join(root,'.agent-memory/notes/manifest.json'),JSON.stringify({version:1,parts:[{file:'a.md'},{file:'b.md'}]}));
    await writeFile(join(root,'.agent-memory/notes/a.md'),'## Widget\n### Widget one\npassword=hidden /Users/test/private\n### Widget two\nsecond\n');
    await writeFile(join(root,'.agent-memory/notes/b.md'),'### Widget three\nthird\n### Widget four\nfourth\n');
    const result=await read(await bind(root),'memory','widget');expect(result.summary.filter(v=>v.startsWith('entry'))).toHaveLength(3);expect(JSON.stringify(result)).not.toMatch(/password=hidden|\/Users\/test/);expect(result.limits).toContain('CURATED_ONLY_NO_JOURNAL_COMMON_MEMORY_INDEX_OR_PULL');
  });

  test('workroom reads injected exact-target metadata only with bounded deterministic revision',async()=>{
    const root=await project(),binding=await bind(root);const rows:any[]=[{targetId:'other',sessionId:'wrong',agent:'codex',state:'working',since:1,lastOutputAt:2,turn:0,exact:true},...Array.from({length:9},(_,i)=>({targetId:'project-1',sessionId:'s'+i,agent:'codex',state:'working',since:1,lastOutputAt:2,turn:0,exact:true,transcript:'must never escape'}))];
    const readers=createProjectStateBundleSources({workroom:()=>rows}),one=await readers.workroom.read(binding,{id:'workroom'},budget(),new AbortController().signal),two=await readers.workroom.read(binding,{id:'workroom'},budget(),new AbortController().signal);
    expect(one.availability).toBe('partial');expect(one.summary).toHaveLength(8);expect(one.sourceRevision).toBe(two.sourceRevision);expect(JSON.stringify(one)).not.toMatch(/wrong|transcript|must never escape/);
  });

  test('trusted continuation excludes only its own exact session while observing remaining updates',async()=>{
    const root=await project(),binding=await bind(root),rows:any[]=[{targetId:'project-1',sessionId:'existing',agent:'codex',state:'working',since:1,lastOutputAt:2,turn:0,exact:true}];
    const source=createProjectStateBundleSources({workroom:()=>rows}).workroom;
    const initial=await source.read(binding,{id:'workroom'},budget(),new AbortController().signal);
    rows.push({targetId:'project-1',sessionId:'new-continuation',agent:'claude',state:'starting',since:3,lastOutputAt:null,turn:0,exact:true});
    const excluded=await source.read(binding,{id:'workroom',excludeWorkroomSessionId:'new-continuation'},budget(),new AbortController().signal);
    expect(excluded.sourceRevision).toBe(initial.sourceRevision);expect(excluded.summary).toEqual(initial.summary);
    const different=await source.read(binding,{id:'workroom',excludeWorkroomSessionId:'new'},budget(),new AbortController().signal);expect(different.summary.join('\n')).toContain('new-continuation');
    rows[0].state='needs-answer';const changed=await source.read(binding,{id:'workroom',excludeWorkroomSessionId:'new-continuation'},budget(),new AbortController().signal);
    expect(changed.sourceRevision).not.toBe(excluded.sourceRevision);expect(changed.summary.join('\n')).toContain('needs-answer');
  });

  test('P2 tester DAG uses validated exact run metadata and never falls back to a newer latest report',async()=>{
    const root=await project();await configure(root);const source={commit:git(root,'rev-parse','HEAD').toString().trim(),fingerprint:fingerprint(root)},oldId='20261024T100000Z-abcdef12',newId='20261024T110000Z-abcdef13';await report(root,source,oldId);
    const binding=await bind(root),adapters=createReadToolSourceAdapters(),status=await toolRead(adapters,binding,{operation:'tester.status.read'});
    expect(status.latestRunId).toBe(oldId);expect(status.reportRunId).toBeUndefined();expect(status.observation.freshness).toBe('current');
    const plan=parseReadToolPlan({steps:[{id:'status',input:{operation:'tester.status.read'}},{id:'report',input:{operation:'tester.report.read',runId:{stepId:'status',field:'latest.runId'}},dependsOn:['status'],condition:'on-report-present'}]});
    const resolved=resolveReadToolInput(plan.steps[1]!,[{stepId:'status',operation:'tester.status.read',state:'completed',availability:status.observation.availability,freshness:status.observation.freshness,latestRunId:status.latestRunId}]);expect(resolved).toEqual({operation:'tester.report.read',runId:oldId});
    await report(root,source,newId);const selected=await toolRead(adapters,binding,resolved!);expect(selected.reportRunId).toBe(oldId);expect(selected.latestRunId).toBeUndefined();expect(selected.observation.summary.join('\n')).toContain(oldId);expect(selected.observation.summary.join('\n')).not.toContain(newId);expect(selected.observation.summary.join('\n')).toContain('check: unit');
    const newest=await toolRead(adapters,binding,{operation:'tester.status.read'});expect(newest.latestRunId).toBe(newId);
    const oldFile=join(root,`.agentstoz/maintainer/runs/${oldId}/report.json`),raw=JSON.parse(await readFile(oldFile,'utf8'));raw.runId=newId;await writeFile(oldFile,JSON.stringify(raw));
    const mismatch=await toolRead(adapters,binding,{operation:'tester.report.read',runId:oldId});expect(mismatch.observation.errorCode).toBe('TESTER_REPORT_ID_MISMATCH');expect(mismatch.reportRunId).toBeUndefined();expect(mismatch.observation.summary).toEqual([]);
    await rm(oldFile);const missing=await toolRead(adapters,binding,{operation:'tester.report.read',runId:oldId});expect(missing.observation.errorCode).toBe('TESTER_REPORT_NOT_FOUND');expect(missing.reportRunId).toBeUndefined();expect(missing.latestRunId).toBeUndefined();
  });

  test('P2 exact report reads only that file, retains source freshness and withholds raw logs',async()=>{
    const root=await project();await configure(root);const id='20261024T100000Z-abcdef12';await report(root,{commit:'a'.repeat(40),fingerprint:'b'.repeat(64)},id);const binding=await bind(root),adapters=createReadToolSourceAdapters();
    // An unrelated latest report/config can be corrupt without becoming an exact-report fallback or read dependency.
    await writeFile(join(root,'.agentstoz/maintainer.json'),'{broken');const dir=join(root,'.agentstoz/maintainer/runs/20261024T120000Z-abcdef14');await mkdir(dir);await writeFile(join(dir,'report.json'),'{broken');
    let bytes=0;const limits=budget();limits.consume=count=>{bytes+=count;return true;};const result=await toolRead(adapters,binding,{operation:'tester.report.read',runId:id},limits);
    expect(result.reportRunId).toBe(id);expect(result.observation.availability).toBe('ready');expect(result.observation.freshness).toBe('stale');expect(bytes).toBe((await lstat(join(root,`.agentstoz/maintainer/runs/${id}/report.json`))).size);expect(JSON.stringify(result)).not.toMatch(/secret transcript|sk-123456|\/Users\//);
    await report(root,undefined,id);const legacy=await toolRead(adapters,binding,{operation:'tester.report.read',runId:id});expect(legacy.observation.freshness).toBe('unknown');expect(legacy.reportRunId).toBe(id);
  });

  test('P2 operation limits reuse bounded P1 sources, memory canonical selection and correction filtering',async()=>{
    const root=await project();await writeFile(join(root,'one.txt'),'one');await writeFile(join(root,'two.txt'),'two');await memory(root,'## Widget\n### Widget first\nfirst widget\n### Widget second\nsecond widget\n### Widget third\nthird widget\n');
    const binding=await bind(root),rows:any[]=Array.from({length:3},(_,i)=>({targetId:'project-1',sessionId:'s'+i,agent:'codex',state:'working',since:1,lastOutputAt:2,turn:0,exact:true})),adapters=createReadToolSourceAdapters({workroom:()=>rows});
    const gitResult=await toolRead(adapters,binding,{operation:'project.git.read',pathsLimit:0});expect(gitResult.observation.summary.some(line=>line.startsWith('file: '))).toBe(false);expect(gitResult.observation.summary.join('\n')).toContain('untracked 2');expect(gitResult.observation.limits).toContain('REQUESTED_PATHS_LIMIT_0');
    const sessions=await toolRead(adapters,binding,{operation:'workroom.status.read',sessionsLimit:1});expect(sessions.observation.summary).toHaveLength(1);expect(sessions.observation.summary[0]).toContain('session s0');
    const selected=await toolRead(adapters,binding,{operation:'memory.reference.read',role:'dev',query:'widget',limit:1});expect(selected.observation.summary.filter(line=>line.startsWith('entry '))).toHaveLength(1);expect(selected.observation.limits).toContain('CURATED_ONLY_NO_JOURNAL_COMMON_MEMORY_INDEX_OR_PULL');
  });

  test('P2 rejects arbitrary inputs and expired/oversized reads without references or hidden writes',async()=>{
    const root=await project();await configure(root);await memory(root,'## Widget\n### Widget policy\nwidget decision\n');await report(root);const binding=await bind(root);let workroomReads=0;const adapters=createReadToolSourceAdapters({workroom:()=>{workroomReads++;return [];}});
    const files=['.git/index','.git/config','.agentstoz/maintainer.json','.agent-memory/config.json','.agent-memory/CORE.md','.agentstoz/maintainer/runs/20261024T100000Z-abcdef12/report.json'];
    const before=await Promise.all(files.map(async path=>({path,hash:createHash('sha256').update(await readFile(join(root,path))).digest('hex'),mtime:(await lstat(join(root,path))).mtimeMs}))),memoryNames=await readdir(join(root,'.agent-memory'));
    const invalid:any[]=[{operation:'tester.report.read',runId:'../../secret'},{operation:'tester.report.read',runId:{stepId:'status',field:'latest.runId'}},{operation:'tester.status.read',profile:'quick'},{operation:'memory.reference.read',role:'ops',query:'widget'},{operation:'project.git.read',path:'/etc/passwd'}];
    for(const input of invalid){const result=await adapters[input.operation as keyof typeof adapters]!.read(binding,input,budget(),new AbortController().signal);expect(result.observation.errorCode).toBe('READ_TOOL_INPUT_INVALID');expect(result.latestRunId).toBeUndefined();expect(result.reportRunId).toBeUndefined();}
    const expired=budget();expired.deadline=Date.now()-1;const stopped=await toolRead(adapters,binding,{operation:'workroom.status.read'},expired);expect(stopped.observation.errorCode).toBe('SOURCE_TIMEOUT');expect(workroomReads).toBe(0);
    const large=await toolRead(adapters,binding,{operation:'tester.report.read',runId:'20261024T100000Z-abcdef12'},budget(10));expect(large.observation.availability).toBe('partial');expect(large.observation.errorCode).toBe('SOURCE_BYTE_LIMIT');expect(large.reportRunId).toBeUndefined();
    for(const input of [{operation:'tester.status.read'},{operation:'tester.report.read',runId:'20261024T100000Z-abcdef12'},{operation:'memory.reference.read',role:'dev',query:'widget'}] as ResolvedReadToolInput[])await toolRead(adapters,binding,input);
    const after=await Promise.all(files.map(async path=>({path,hash:createHash('sha256').update(await readFile(join(root,path))).digest('hex'),mtime:(await lstat(join(root,path))).mtimeMs})));expect(after).toEqual(before);expect(await readdir(join(root,'.agent-memory'))).toEqual(memoryNames);
  });

  test('cancelled and expired reads return honest unavailable metadata and do not read files',async()=>{
    const root=await project(),binding=await bind(root),controller=new AbortController();controller.abort();
    const result=await createProjectStateBundleSources().tester.read(binding,{id:'tester'},budget(),controller.signal);expect(result.availability).toBe('unavailable');expect(result.summary).toEqual([]);
    await expect(resolveProjectStateCheckout({rootPath:root,targetId:'p',projectId:'p',owner:'local',authorityRevision:'v1'},controller.signal)).rejects.toThrow();
    const expired=budget();expired.deadline=Date.now()-1;expect((await createProjectStateBundleSources().memory.read(binding,{id:'memory',query:'widget'},expired,new AbortController().signal)).errorCode).toBe('SOURCE_TIMEOUT');
  });

  test('an in-flight Git read is killed and actually settled before cancellation returns',async()=>{
    if(process.platform==='win32')return;
    const root=await project(),controller=new AbortController();
    await rm(join(root,'.git/config'));execFileSync('mkfifo',[join(root,'.git/config')]);
    const pending=resolveProjectStateCheckout({rootPath:root,targetId:'p',projectId:'p',owner:'local',authorityRevision:'v1'},controller.signal).then(()=>null,error=>error);
    let pid:number|undefined;
    try{
      for(let i=0;i<40;i++){try{pid=Number(execFileSync('pgrep',['-P',String(process.pid),'git']).toString().trim().split('\n')[0]);if(pid)break;}catch{}await Bun.sleep(5);}
      expect(pid).toBeGreaterThan(0);controller.abort();const error=await pending;expect(error?.code).toBe('SOURCE_CANCELLED');
      expect(()=>process.kill(pid!,0)).toThrow();
    }finally{controller.abort();await pending;if(pid)try{process.kill(pid,'SIGKILL');}catch{}}
  });
});
