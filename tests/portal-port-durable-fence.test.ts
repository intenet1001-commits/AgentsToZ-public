import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const portal = readFileSync(new URL('../src/portal-main.tsx', import.meta.url), 'utf8');

function section(start: string, end: string): string {
  const from = portal.indexOf(start);
  const to = portal.indexOf(end, from + start.length);
  if (from < 0 || to < 0) throw new Error(`missing portal section: ${start}`);
  return portal.slice(from, to);
}

describe('deployed portal port mutation durability', () => {
  test('canonicalizes bigint generations as decimal text when rows are loaded', () => {
    expect(portal).toContain('sync_generation: string;');
    expect(portal).toContain('sync_generation: portFenceGeneration(row.sync_generation ?? 0)');
    expect(portal).toContain('setPorts((data ?? []).map(canonicalPortRow))');
    expect(section('async function loadPorts()', 'useEffect(() =>')).toContain('setPorts([]);');
  });

  test('never falls back to direct table mutation or optional-column data loss', () => {
    expect(portal).not.toContain("from('portmgr_ports').insert(");
    expect(portal).not.toContain("from('portmgr_ports').update(");
    expect(portal).not.toContain("from('portmgr_ports').delete(");
    expect(portal).not.toContain('isMissingOptionalColumnError');
    expect(portal).not.toContain('isMissingGithubUrlsColumnError');
    expect(portal).toContain('안전 동기화 DB 업데이트가 필요합니다.');
    expect(portal).toContain(".select('id,name,device_id,sync_generation,port,deploy_url,github_url,github_urls,category,description')");
    expect(portal).toContain('if (error) throw new PortalPortSchemaError(error);');
  });

  test('creates generation zero and edits with the current row fence identity', () => {
    const create = section('async function createProject()', 'async function updateProject()');
    expect(create).toContain('upsertPortsWithDurableFence');
    expect(create).toContain("sync_generation: '0'");

    const inline = section('async function saveInlineUrl(', 'async function createProject()');
    expect(inline).toContain('id: current.id');
    expect(inline).toContain('device_id: current.device_id ?? null');
    expect(inline).toContain('name: current.name');
    expect(inline).toContain('sync_generation: current.sync_generation');

    const edit = section('async function updateProject()', 'async function deleteProject(');
    expect(edit).toContain('id: current.id');
    expect(edit).toContain('device_id: current.device_id ?? null');
    expect(edit).toContain('sync_generation: current.sync_generation');
  });

  test('deletes only the exact visible identity and generation through the CAS RPC', () => {
    const deletion = section('async function deleteProject(', 'function openEdit(');
    expect(deletion).toContain('deletePortsWithDurableFence');
    expect(deletion).toContain('id: current.id');
    expect(deletion).toContain('device_id: current.device_id ?? null');
    expect(deletion).toContain('name: current.name');
    expect(deletion).toContain('sync_generation: current.sync_generation');
  });
});
