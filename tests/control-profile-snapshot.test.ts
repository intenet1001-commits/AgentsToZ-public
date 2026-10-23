import {afterEach,expect,test} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,readFileSync,readdirSync,realpathSync} from 'node:fs';
import {join} from 'node:path';import {tmpdir} from 'node:os';import {randomUUID} from 'node:crypto';
import {readProjectMemorySnapshot} from '../project-memory-server';
const roots:string[]=[];afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
test('Control snapshot reads current canonical memory without writing activity metadata',()=>{
 const root=mkdtempSync(join(tmpdir(),'control-memory-snapshot-'));roots.push(root);mkdirSync(join(root,'.agent-memory'));
 const memoryId=randomUUID();writeFileSync(join(root,'.agent-memory','config.json'),JSON.stringify({version:1,memoryId,sourcePath:'.agent-memory/CORE.md',agent:'codex',autoBackup:false}));
 const path=join(root,'.agent-memory','CORE.md');writeFileSync(path,'# OPS memory\n\n### Current rule\nUse verified evidence.\n');
 const before=readFileSync(path,'utf8');const snapshot=readProjectMemorySnapshot(root);
 expect(snapshot.memoryId).toBe(memoryId);expect(snapshot.root).toBe(realpathSync(root));expect(snapshot.document).toBe(before);expect(readFileSync(path,'utf8')).toBe(before);
 expect(readdirSync(join(root,'.agent-memory')).sort()).toEqual(['CORE.md','config.json']);
 writeFileSync(path,before+'New evidence.\n');expect(readProjectMemorySnapshot(root).document).toContain('New evidence.');
 rmSync(path);expect(()=>readProjectMemorySnapshot(root)).toThrow();
});
test('Control snapshot resolves a linked checkout to the current primary memory',()=>{
 const root=mkdtempSync(join(tmpdir(),'control-canonical-snapshot-'));roots.push(root);const main=join(root,'main'),linked=join(root,'linked');mkdirSync(main);
 const git=(args:string[])=>{const result=Bun.spawnSync(['git',...args],{cwd:main,stdout:'pipe',stderr:'pipe'});if(result.exitCode!==0)throw Error(result.stderr.toString());};
 git(['init','-q']);mkdirSync(join(main,'.agent-memory'));const memoryId=randomUUID();
 writeFileSync(join(main,'.agent-memory/config.json'),JSON.stringify({memoryId,sourcePath:'.agent-memory/CORE.md'}));writeFileSync(join(main,'.agent-memory/CORE.md'),'# Current canonical OPS\n');
 git(['add','.']);git(['-c','user.name=Test','-c','user.email=test@example.com','commit','-qm','fixture']);git(['worktree','add','-qb','linked',linked]);
 writeFileSync(join(linked,'.agent-memory/config.json'),JSON.stringify({memoryId:randomUUID(),sourcePath:'.agent-memory/CORE.md'}));writeFileSync(join(linked,'.agent-memory/CORE.md'),'# Stale linked copy\n');
 const snapshot=readProjectMemorySnapshot(linked);expect(snapshot.root).toBe(realpathSync(main));expect(snapshot.memoryId).toBe(memoryId);expect(snapshot.document).toBe('# Current canonical OPS\n');
});
