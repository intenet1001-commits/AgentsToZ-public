/** Disposable real React + common-memory service preview. No installed app or production data. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { MetaCommonMemoryStore } from '../../src/metaCommonMemoryStore';
import { MetaCommonMemoryService } from '../../src/metaCommonMemoryService';
import type { MetaMemoryProject } from '../../src/metaCommonMemoryContract';
import { MetaCommonMemoryRemoteHost, metaMemoryRemoteProjectRef } from '../../src/metaCommonMemoryRemoteHost';
import { createMobileWorkspaceGateway } from '../../src/mobileWorkspaceGateway';
const repo = resolve(import.meta.dir, '../..');
const root = mkdtempSync(join(tmpdir(), 'meta-common-memory-ui-'));
const entry = join(root, 'entry.tsx');
writeFileSync(entry, `import React from ${JSON.stringify(join(repo, 'node_modules/react/index.js'))};import {createRoot} from ${JSON.stringify(join(repo, 'node_modules/react-dom/client.js'))};import Panel from ${JSON.stringify(join(repo, 'src/MetaCommonMemoryPanel.tsx'))};import {RemoteMetaCommonMemoryPanel} from ${JSON.stringify(join(repo, 'src/RemoteMetaCommonMemoryPanel.tsx'))};const mobile=location.pathname==='/mobile';createRoot(document.getElementById('root')!).render(mobile?React.createElement(RemoteMetaCommonMemoryPanel,{visible:true,available:true,online:true,hostName:'시험 Mac',transport:async request=>{const response=await fetch('/__workspace',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request)});const result=await response.json();if(!response.ok)throw Error(result.error);return result;}}):React.createElement(Panel));`);
const built = await Bun.build({ entrypoints: [entry], target: 'browser', define: { 'process.env.NODE_ENV': '"production"' } });
if (!built.success) throw new Error(built.logs.map(String).join('\n'));
const cssPath = join(root, 'style.css');
const css = Bun.spawnSync([join(repo, 'node_modules/.bin/tailwindcss'), '-i', join(repo, 'src/index.css'), '-o', cssPath, '--content', join(repo, 'src/MetaCommonMemoryPanel.tsx')], { cwd: repo, stderr: 'pipe', stdout: 'pipe' });
if (css.exitCode !== 0) throw new Error(css.stderr.toString());
const projects: MetaMemoryProject[] = [
  { id: 'A', name: 'nhdesign-marketplace', category: 'NHCS', memoryId: randomUUID(), state: 'ready' },
  { id: 'B', name: 'nhdesign-usher', category: 'NHCS', memoryId: randomUUID(), state: 'ready' },
  { id: 'C', name: '다른 앱 C', category: '앱', memoryId: randomUUID(), state: 'ready' },
  { id: 'D', name: '새 프로젝트 D', category: '앱', memoryId: null, state: 'uninitialized' },
];
const store = new MetaCommonMemoryStore(root);
const service = new MetaCommonMemoryService(store, { projects: async () => projects, prepareProject: async id => { const p = projects.find(p => p.id === id)!; p.memoryId ??= randomUUID(); p.state = 'ready'; } });
let loseNextSave = false, mobilePermission = true;
const mobileHost = new MetaCommonMemoryRemoteHost(async (owner, request, active) => {
  const assertActive = () => { if (!active()) throw Error('permission revoked'); };
  return new MetaCommonMemoryService(store, { assertActive, projects: async () => projects.map(p => ({ ...p, id: metaMemoryRemoteProjectRef(owner, p.id) })), prepareProject: async ref => { assertActive(); const p = projects.find(p => metaMemoryRemoteProjectRef(owner, p.id) === ref)!; p.memoryId ??= randomUUID(); p.state = 'ready'; } }).execute(request);
});
const gateway = createMobileWorkspaceGateway({ terminal: async () => { throw Error('not available'); }, active: () => true, resolve: async () => [], consent: async () => ({ targetIds: new Set<string>(), workspaceScopes: mobilePermission ? ['meta-memory.manage'] : [], isActive: () => mobilePermission, requestOwner: 'ui-test-phone' }), perform: async () => { throw Error('not available'); }, metaMemory: (request, owner, active) => mobileHost.perform(owner, request, active) });
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
  const path = new URL(req.url).pathname;
  if (path === '/app.js') return new Response(built.outputs[0], { headers: { 'Content-Type': 'application/javascript' } });
  if (path === '/appearanceTokens.css') return new Response(Bun.file(join(repo, 'src/appearanceTokens.css')));
  if (path === '/style.css') return new Response(Bun.file(cssPath));
  if (path === '/__fault' && req.method === 'POST') { loseNextSave = true; return Response.json({ armed: true }); }
  if (path === '/__mobile-permission' && req.method === 'POST') { mobilePermission = (await req.json() as any).allowed === true; return Response.json({ allowed: mobilePermission }); }
  if (path === '/__workspace' && req.method === 'POST') {
    try {
      const request = await req.json() as any; const result = await gateway(request, [], 'fixture');
      if (loseNextSave && request.workspace.meta?.phase === 'execute') { loseNextSave = false; return Response.json({ error: '시험: 저장 결과 응답 유실' }, { status: 503 }); }
      return Response.json(result);
    } catch (e: any) { return Response.json({ error: e.message }, { status: 403 }); }
  }
  if (path === '/api/meta-common-memory') {
    try {
      const request = await req.json() as any;
      const result = await service.execute(request);
      if (loseNextSave && request.operation === 'save') { loseNextSave = false; return Response.json({ error: '시험: 저장 후 응답 유실', code: 'RESULT_UNKNOWN' }, { status: 503 }); }
      return Response.json({ success: true, ...result });
    } catch (e: any) { return Response.json({ error: e.message, code: e.code }, { status: e.status ?? 400 }); }
  }
  return new Response('<!doctype html><html lang="ko" data-app-theme="dark"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>메타 공통 기억 화면 검증</title><link rel="stylesheet" href="/style.css"><style>.meta-common-memory-mobile input:not([type=checkbox]),.meta-common-memory-mobile textarea,.meta-common-memory-mobile select{font-size:16px}</style><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
} });
console.log(JSON.stringify({ url: `http://127.0.0.1:${server.port}`, root, pid: process.pid }));
process.on('SIGTERM', () => { mobileHost.dispose(); server.stop(true); rmSync(root, { recursive: true, force: true }); process.exit(0); });
