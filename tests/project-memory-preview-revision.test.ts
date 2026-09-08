import {test, expect} from 'bun:test';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {previewProjectMemoryRevision} from '../project-memory-server';
import {projectMemoryConflictTerminalPrompt} from '../src/projectMemoryConflictTerminalPrompt';

test('revision preview verifies lineage/hash and never changes local memory or calls remote mutations', async () => {
  const root = mkdtempSync(join(tmpdir(), 'memory-preview-'));
  const memory = join(root, '.agent-memory'); mkdirSync(memory);
  const config = JSON.stringify({schemaVersion: 1, memoryId: 'preview-memory', sourcePath: '.agent-memory/CORE.md', agent: 'codex', autoBackup: false});
  writeFileSync(join(memory, 'config.json'), config);
  writeFileSync(join(memory, 'CORE.md'), '# Project Core Memory\n\nLocal decision.\n');
  const content = '# Project Core Memory\n\nRemote decision.\n';
  const hash = createHash('sha256').update(content).digest('hex');
  let row = {id: 'preview-revision', memory_id: 'preview-memory', content, content_hash: hash};
  const requests: string[] = [];
  const server = Bun.serve({hostname:'127.0.0.1',port:0,fetch(request) {
    requests.push(request.method);
    return Response.json(row);
  }});
  const portalDataFile = join(root, 'portal.json');
  writeFileSync(portalDataFile, JSON.stringify({supabaseUrl: `http://127.0.0.1:${server.port}`, supabaseAnonKey: 'fixture-public-key'}));
  const input = {portalDataFile, folderPath: root, revisionId: row.id};
  try {
    expect(await previewProjectMemoryRevision(input)).toEqual({revisionId: row.id, contentHash: hash, content});
    row = {...row, memory_id: 'other-memory'};
    await expect(previewProjectMemoryRevision(input)).rejects.toThrow();
    row = {...row, memory_id: 'preview-memory', content: 'tampered'};
    await expect(previewProjectMemoryRevision(input)).rejects.toThrow();
    expect(requests).toEqual(['GET', 'GET', 'GET']);
    expect(readFileSync(join(memory, 'config.json'), 'utf8')).toBe(config);
    expect(readFileSync(join(memory, 'CORE.md'), 'utf8')).toContain('Local decision.');
    expect(readdirSync(memory).sort()).toEqual(['CORE.md', 'config.json']);
  } finally {server.stop(true);rmSync(root,{recursive:true,force:true});}
});

test('large conflict bodies stay out of CLI arguments while the exact evidence and review-only instructions remain', () => {
  const prompt = projectMemoryConflictTerminalPrompt('/tmp/project', {
    origin: 'pull', localContent: 'x'.repeat(500_000), remoteContent: 'y'.repeat(500_000),
    localContentHash: 'local-hash', remoteContentHash: 'remote-hash', remoteRevisionId: 'remote-id',
  } as Parameters<typeof projectMemoryConflictTerminalPrompt>[1]);
  expect(new TextEncoder().encode(prompt).length).toBeLessThan(24_000);
  expect(prompt).toContain('preview-revision');
  expect(prompt).toContain('remote-id');
  expect(prompt).toContain('Pull·Push·세션 기억하기를 실행하지 마세요');
  expect(prompt).not.toContain('x'.repeat(100));
});
