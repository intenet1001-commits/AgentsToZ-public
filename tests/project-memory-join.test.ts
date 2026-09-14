import { describe, expect, test } from 'bun:test';
import { joinMemoryIdProblem, normalizeJoinMemoryId } from '../src/projectMemoryJoin';

const ID = '884575df-63c4-407c-8b43-860d1295e663';

describe('joining an existing memory by id', () => {
  test('accepts the value the ID badge copies', () => {
    expect(normalizeJoinMemoryId(ID)).toBe(ID);
  });

  // The id travels through chat, notes and clipboards, so it arrives wrapped in
  // whatever the user pasted around it. Normalizing is safe; guessing is not.
  test('tolerates the wrappers a pasted id arrives in', () => {
    expect(normalizeJoinMemoryId(`  ${ID}  `)).toBe(ID);
    expect(normalizeJoinMemoryId(ID.toUpperCase())).toBe(ID);
    expect(normalizeJoinMemoryId(`"${ID}"`)).toBe(ID);
    expect(normalizeJoinMemoryId(`memoryId: ${ID}`)).toBe(ID);
    expect(normalizeJoinMemoryId(`memory_id=${ID}`)).toBe(ID);
  });

  // The panel badge shows only the first 8 characters, so copying what is on
  // screen instead of clicking it is the likeliest mistake. Eight hex digits
  // cannot identify a lineage, and silently accepting them would create a new
  // memory the user believes they joined.
  test('rejects the 8-character badge text with a specific hint', () => {
    const failure = (() => { try { normalizeJoinMemoryId('884575df'); } catch (e) { return e as any; } })();
    expect(failure?.code).toBe('MEMORY_ID_TRUNCATED');
    expect(failure?.message).toContain('배지');
  });

  test('rejects anything that is not a memory id', () => {
    for (const bad of ['hello', '884575df-63c4', `${ID}-extra`, 'zz4575df-63c4-407c-8b43-860d1295e663']) {
      expect(() => normalizeJoinMemoryId(bad)).toThrow();
    }
    const empty = (() => { try { normalizeJoinMemoryId('   '); } catch (e) { return e as any; } })();
    expect(empty?.code).toBe('MEMORY_ID_EMPTY');
  });

  // The live-typing helper must stay quiet until there is something to judge,
  // or the field shouts at the user from the first keystroke.
  test('reports problems for the field without throwing', () => {
    expect(joinMemoryIdProblem('')).toBeNull();
    expect(joinMemoryIdProblem('   ')).toBeNull();
    expect(joinMemoryIdProblem(ID)).toBeNull();
    expect(joinMemoryIdProblem('884575df')).toContain('8자리');
    expect(joinMemoryIdProblem('nope')).toBeTruthy();
  });
});
