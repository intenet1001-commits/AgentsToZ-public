import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureProjectMemoryBackupGuard, pushProjectMemory, sessionEndProjectMemory } from '../project-memory-server';

for (const mutation of ['content', 'identity', 'destination', 'opt-out'] as const) {
  test(`backup refuses ${mutation} drift before any network request or local rewrite`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'memory-backup-guard-'));
    const folderPath = join(root, 'project'); mkdirSync(join(folderPath, '.agent-memory'), { recursive: true });
    const core = join(folderPath, '.agent-memory/CORE.md');
    const configPath = join(folderPath, '.agent-memory/config.json');
    const portalDataFile = join(root, 'portal.json');
    const config = { schemaVersion: 1, memoryId: 'memory-one', sourcePath: '.agent-memory/CORE.md', agent: 'codex', autoBackup: true };
    writeFileSync(core, '# Project Core Memory\n\nSaved content.\n');
    writeFileSync(configPath, JSON.stringify(config));
    writeFileSync(portalDataFile, JSON.stringify({ supabaseUrl: 'http://127.0.0.1:1', supabaseAnonKey: 'fixture', deviceId: 'device' }));
    try {
      const expectedBackup = captureProjectMemoryBackupGuard({ folderPath, portalDataFile });
      if (mutation === 'content') writeFileSync(core, '# Project Core Memory\n\nNew local work.\n');
      if (mutation === 'identity') writeFileSync(configPath, JSON.stringify({ ...config, memoryId: 'memory-two' }));
      if (mutation === 'opt-out') writeFileSync(configPath, JSON.stringify({ ...config, autoBackup: false }));
      if (mutation === 'destination') writeFileSync(portalDataFile, JSON.stringify({ supabaseUrl: 'http://127.0.0.1:2', supabaseAnonKey: 'fixture' }));
      const before = readFileSync(core, 'utf8');
      await expect(pushProjectMemory({ folderPath, portalDataFile, expectedBackup })).rejects.toMatchObject({ code: 'BACKUP_GUARD_CHANGED' });
      expect(readFileSync(core, 'utf8')).toBe(before);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test('deferring backup without a durable local outcome handler is rejected before AI or file access', async () => {
  await expect(sessionEndProjectMemory({ folderPath: '/nonexistent-project', portalDataFile: '/unused', deferBackup: true }))
    .rejects.toThrow('영수증');
});

test('remote parent and memory-alias drift block guarded Push without remote writes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'backup-remote-guard-'));
  const script = join(root, 'fixture.ts');
  writeFileSync(script, `
    import {mkdirSync,writeFileSync} from 'node:fs';
    import {join} from 'node:path';
    import {captureProjectMemoryBackupGuard,pushProjectMemory} from ${JSON.stringify(join(import.meta.dir, '..', 'project-memory-server.ts'))};
    const root=process.argv[2], folderPath=join(root,'project'), portalDataFile=join(root,'portal.json');
    mkdirSync(join(folderPath,'.agent-memory'),{recursive:true});
    writeFileSync(join(folderPath,'.agent-memory/CORE.md'),'# Project Core Memory\\nSaved.\\n');
    writeFileSync(join(folderPath,'.agent-memory/config.json'),JSON.stringify({schemaVersion:1,memoryId:'memory-one',sourcePath:'.agent-memory/CORE.md',autoBackup:true,agent:'codex',lastPulledRevisionId:'parent'}));
    let alias=false,writes=0,reads=0;
    const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch(req){
      if(req.method!=='GET'){writes++;return new Response('{}',{status:500});}
      reads++; const p=new URL(req.url).pathname;
      if(p.endsWith('/portmgr_project_memory_aliases')) return Response.json(alias&&new URL(req.url).searchParams.get('alias_memory_id')==='eq.memory-one'?{canonical_memory_id:'merged-memory'}:null);
      if(p.endsWith('/portmgr_project_memory_revisions')) return Response.json([{id:'new-remote-parent',content_hash:'different'}]);
      return new Response('{}',{status:500});
    }});
    writeFileSync(portalDataFile,JSON.stringify({supabaseUrl:'http://127.0.0.1:'+server.port,supabaseAnonKey:'fixture'}));
    const expectedBackup=captureProjectMemoryBackupGuard({folderPath,portalDataFile});
    const codes=[];
    try {for(const mode of [false,true]){alias=mode;try{await pushProjectMemory({folderPath,portalDataFile,expectedBackup});codes.push('unexpected-success');}catch(e){codes.push(e.code);}}}
    finally{server.stop(true);}
    console.log(JSON.stringify({codes,writes,reads}));
  `);
  try {
    const child = Bun.spawn([process.execPath, script, root], {
      env: { ...process.env, SUPABASE_SERVICE_ROLE_KEY: 'fixture-only' }, stdout: 'pipe', stderr: 'pipe',
    });
    const [out, err, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit, err).toBe(0);
    const result = JSON.parse(out);
    expect(result.codes).toEqual(['BACKUP_GUARD_CHANGED', 'BACKUP_GUARD_CHANGED']);
    expect(result.writes).toBe(0);
    expect(result.reads).toBeGreaterThan(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
