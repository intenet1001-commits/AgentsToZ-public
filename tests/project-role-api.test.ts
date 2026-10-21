import {test, expect} from 'bun:test';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startTestApiServer} from './startTestApiServer';

test('real local API preserves optional roles, rejects invalid writes and does not migrate a read', async () => {
  const home = mkdtempSync(join(tmpdir(), 'project-role-api-'));
  const data = join(home, 'data'); mkdirSync(data);
  const file = join(data, 'ports.json');
  const original = JSON.stringify([{id:'legacy', name:'Legacy'}, {id:'ops', name:'Operations', role:'ops'}]);
  writeFileSync(file, original);
  let child: Bun.Subprocess | undefined;
  try {
    const server = await startTestApiServer({cwd:join(import.meta.dir, '..'), env:{...process.env,
      HOME:home, APP_DATA_DIR:data, NODE_ENV:'test', AGENTSTOZ_SKIP_CONTROL_BOOTSTRAP:'1',
      AGENTSTOZ_SKIP_OUTPUT_STYLE_SYNC:'1', AGENTSTOZ_SKIP_HERMES_SYNC:'1',
    }});
    child = server.child;
    const read = async () => await fetch(server.baseUrl + '/api/ports').then(r => r.json()) as any[];
    const post = (path:string, body:unknown) => fetch(server.baseUrl + path, {
      method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body),
    });
    expect(await read()).toEqual(JSON.parse(original));
    expect(readFileSync(file, 'utf8')).toBe(original);
    expect((await post('/api/ports', [{id:'ops', name:'Renamed'}])).status).toBe(200);
    expect((await read()).find(row => row.id === 'ops')?.role).toBe('ops');
    const base = await read();
    const desired = base.map(row => row.id === 'legacy' ? {...row, role:'dev'} : {id:row.id, name:row.name});
    expect((await post('/api/ports/merge', {ports:desired, basePorts:base})).status).toBe(200);
    expect((await read()).map(row => row.role)).toEqual(['ops','dev']);
    const saved = readFileSync(file, 'utf8');
    for (const path of ['/api/ports','/api/ports/merge']) {
      const invalid = [{id:'ops', role:'admin'}];
      const response = await post(path, path.endsWith('/merge') ? {ports:invalid} : invalid);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({error:'PROJECT_ROLE_INVALID'});
      expect(readFileSync(file, 'utf8')).toBe(saved);
    }
  } finally {
    if (child) { child.kill(); await child.exited; }
    rmSync(home, {recursive:true, force:true});
  }
}, 30_000);
