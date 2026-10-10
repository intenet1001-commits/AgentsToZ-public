import {afterEach, describe, expect, test} from 'bun:test';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {orcaManagedFloatingTerminalMarker, relocateOrcaFloatingTerminalRecords} from '../src/orcaFloatingTerminal';
import {TerminalMemoryQueue} from '../src/terminalMemoryQueue';
import {bindExclusiveProjectMemoryThread, findProjectMemoryThreadBindings, relocateProjectMemoryThreadBindings} from '../src/projectMemoryThreadBindings';

// App-data records that name the OPS folder by absolute path follow it when it is renamed.
// Only paths that are the folder or inside it move; everything else is left byte-for-byte.
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, {recursive: true, force: true}); });
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'ops-references-')); dirs.push(dir); return dir; };
const FROM = '/Users/me/product/AgentsToZ-Control', TO = '/Users/me/product/AgentsToZ-OPS';
const aliases = [[FROM, TO]] as const;

describe('Orca Floating terminal registry', () => {
  test('records under the folder move to the key of their new path; others stay', () => {
    const record = (agent: string, folderPath: string) => ({agent, folderPath, handle: `h-${agent}-${folderPath.length}`, title: 't', updatedAt: 1});
    const inside = record('codex', FROM), nested = record('claude', `${FROM}/docs`), other = record('codex', '/Users/me/product/AgentsToZ-Control-old');
    const terminals = {
      [orcaManagedFloatingTerminalMarker('codex', FROM)]: inside,
      [orcaManagedFloatingTerminalMarker('claude', `${FROM}/docs`)]: nested,
      [orcaManagedFloatingTerminalMarker('codex', other.folderPath)]: other,
    };
    const moved = relocateOrcaFloatingTerminalRecords(terminals, aliases);
    expect(moved.count).toBe(2);
    expect(moved.terminals[orcaManagedFloatingTerminalMarker('codex', TO)]).toEqual({...inside, folderPath: TO});
    expect(moved.terminals[orcaManagedFloatingTerminalMarker('claude', `${TO}/docs`)]).toEqual({...nested, folderPath: `${TO}/docs`});
    expect(moved.terminals[orcaManagedFloatingTerminalMarker('codex', other.folderPath)]).toBe(other);
    expect(Object.keys(moved.terminals)).toHaveLength(3);
    // A terminal already remembered for the new path is kept rather than overwritten.
    const newer = record('codex', TO);
    const kept = relocateOrcaFloatingTerminalRecords({...terminals, [orcaManagedFloatingTerminalMarker('codex', TO)]: newer}, aliases);
    expect(kept.terminals[orcaManagedFloatingTerminalMarker('codex', TO)]).toBe(newer);
    expect(relocateOrcaFloatingTerminalRecords({[orcaManagedFloatingTerminalMarker('codex', other.folderPath)]: other}, aliases).count).toBe(0);
  });
});

describe('Workroom memory queue', () => {
  test('unresolved jobs under the folder follow it; finished history and other projects do not', async () => {
    const dir = temp();
    const saves: string[] = [];
    const queue = new TerminalMemoryQueue(join(dir, 'workroom-memory-queue.json'), async job => { saves.push(job.cwd); return 'saved'; });
    queue.enqueue({sessionId: 'done', targetId: 'ops', cwd: FROM, agent: 'codex'});
    await queue.tick();
    queue.enqueue({sessionId: 'pending', targetId: 'ops', cwd: FROM, agent: 'codex'});
    queue.enqueue({sessionId: 'nested', targetId: 'ops', cwd: `${FROM}/docs`, agent: 'claude'});
    queue.enqueue({sessionId: 'other', targetId: 'x', cwd: '/Users/me/product/other', agent: 'codex'});
    expect(queue.relocatePendingCwd(aliases)).toBe(2);
    expect(queue.relocatePendingCwd(aliases)).toBe(0);
    await queue.tick(); await queue.tick(); await queue.tick();
    expect(saves).toEqual([FROM, TO, `${TO}/docs`, '/Users/me/product/other']);
  });
});

describe('chat and channel bindings', () => {
  test('bindings for the folder follow it; the route and identity are unchanged', async () => {
    const file = join(temp(), 'project-memory-thread-bindings.json');
    await bindExclusiveProjectMemoryThread(file, {platform: 'buzz', chatId: 'relay', threadId: 'ops-channel', projectId: 'ops-id', projectName: 'AgentsToZ-Control', memoryId: 'm-ops', canonicalPath: FROM});
    await bindExclusiveProjectMemoryThread(file, {platform: 'telegram', chatId: 'chat', threadId: '7', projectId: 'other', projectName: 'other', memoryId: 'm-other', canonicalPath: '/Users/me/product/other'});
    expect(await relocateProjectMemoryThreadBindings(file, aliases)).toBe(1);
    const [ops] = await findProjectMemoryThreadBindings(file, {projectId: 'ops-id'});
    expect(ops).toMatchObject({platform: 'buzz', chatId: 'relay', threadId: 'ops-channel', memoryId: 'm-ops', canonicalPath: TO});
    expect((await findProjectMemoryThreadBindings(file, {projectId: 'other'}))[0]?.canonicalPath).toBe('/Users/me/product/other');
    const before = readFileSync(file, 'utf8');
    expect(await relocateProjectMemoryThreadBindings(file, aliases)).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(await relocateProjectMemoryThreadBindings(join(temp(), 'absent.json'), aliases)).toBe(0);
  });
});
