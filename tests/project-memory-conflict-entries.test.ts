import { describe, expect, test } from 'bun:test';
import { compareProjectMemoryEntries, projectMemoryChoiceLosses } from '../src/projectMemoryConflictEntries';
import { projectMemoryConflictIdentityIssues } from '../src/projectMemoryConflict';

// The dock's 「비교·해결」 (src/components/DockMemoryConflictReview.tsx): what differs, entry by entry, and the one merge
// that needs no judgement — each side only added entries the other lacks.
const id = (c: string) => c.repeat(24);
const entry = (title: string, c: string, body: string) => `### ${title}\n<!-- memory-entry-id:${id(c)} -->\n\n- ${body}\n`;
const doc = (...sections: [string, ...string[]][]) =>
  `# Project Core Memory\n\nIntro line.\n\n${sections.map(([heading, ...entries]) => `## ${heading}\n\n${entries.join('\n')}`).join('\n')}`;

const base = doc(['Decisions', entry('Keep A', 'a', 'a body')], ['Workflows', entry('Run B', 'b', 'b body')]);

describe('entry comparison', () => {
  test('both sides only added: additions are named by side and the merge keeps everything once, in its section', () => {
    const local = doc(['Decisions', entry('Keep A', 'a', 'a body'), entry('Local new', 'c', 'local')], ['Workflows', entry('Run B', 'b', 'b body')]);
    const remote = doc(['Decisions', entry('Keep A', 'a', 'a body')], ['Workflows', entry('Run B', 'b', 'b body'), entry('Remote new', 'd', 'remote')]);
    const result = compareProjectMemoryEntries({ localContent: local, remoteContent: remote, baseContent: base });
    expect(result.same).toBe(2);
    expect(result.differences.map(d => [d.title, d.change])).toEqual([['Local new', 'local-added'], ['Remote new', 'remote-added']]);
    expect(result.contextChanged).toBe(false);
    if (!result.merge.ok) throw Error(result.merge.reason);
    expect(result.merge).toMatchObject({ addedFromLocal: 1, addedFromRemote: 1 });
    const merged = result.merge.content;
    // Local stays byte-for-byte as the prefix; the remote entry lands at the end of 「Workflows」 with its ID untouched.
    expect(merged.startsWith(local.trimEnd())).toBe(true);
    expect(merged.indexOf('### Remote new')).toBeGreaterThan(merged.indexOf('### Run B'));
    expect(merged).toContain(`### Remote new\n<!-- memory-entry-id:${id('d')} -->`);
    expect(projectMemoryConflictIdentityIssues(merged)).toEqual({ duplicateIds: [], malformedIds: 0 });
    // Compared again, the merge contains both sides: nothing of either is missing.
    const again = compareProjectMemoryEntries({ localContent: merged, remoteContent: remote, baseContent: base });
    expect(again.differences.map(d => d.change)).toEqual(['local-added']);
  });

  test('an addition into a section the other side lacks brings that section along, at the end', () => {
    const local = doc(['Decisions', entry('Keep A', 'a', 'a body'), entry('Local new', 'c', 'local')], ['Workflows', entry('Run B', 'b', 'b body')]);
    const remote = base + '\n## Pitfalls\n\nSection intro.\n\n' + entry('Remote pitfall', 'e', 'watch out');
    const result = compareProjectMemoryEntries({ localContent: local, remoteContent: remote, baseContent: base });
    if (!result.merge.ok) throw Error(result.merge.reason);
    expect(result.merge.content).toContain('## Pitfalls\n\nSection intro.\n\n### Remote pitfall');
    expect(result.merge.content.indexOf('## Pitfalls')).toBeGreaterThan(result.merge.content.indexOf('### Run B'));
  });

  test('nothing to bring over from Supabase: the merge is the local document byte for byte', () => {
    const local = base + '\n' + entry('Local new', 'c', 'local');
    const result = compareProjectMemoryEntries({ localContent: local, remoteContent: base, baseContent: base });
    if (!result.merge.ok) throw Error(result.merge.reason);
    expect(result.merge.content).toBe(local);
  });

  test('an edit or a deletion on either side is shown, and the merge refuses with the reason', () => {
    const remoteEdited = base.replace('- a body', '- a body, edited elsewhere');
    const edited = compareProjectMemoryEntries({ localContent: base + '\n' + entry('Local new', 'c', 'x'), remoteContent: remoteEdited, baseContent: base });
    expect(edited.differences.map(d => [d.title, d.change])).toEqual([['Keep A', 'remote-changed'], ['Local new', 'local-added']]);
    expect(edited.merge.ok).toBe(false);
    if (!edited.merge.ok) expect(edited.merge.reason).toContain('고치거나 지운 항목이 1개');

    const both = compareProjectMemoryEntries({ localContent: base.replace('- a body', '- local wording'), remoteContent: remoteEdited, baseContent: base });
    expect(both.differences.map(d => d.change)).toEqual(['both-changed']);

    const localDeleted = compareProjectMemoryEntries({ localContent: doc(['Decisions'], ['Workflows', entry('Run B', 'b', 'b body')]), remoteContent: base, baseContent: base });
    expect(localDeleted.differences.map(d => [d.title, d.change])).toEqual([['Keep A', 'local-deleted']]);
    expect(localDeleted.merge.ok).toBe(false);
  });

  test('without the base, one-sided entries cannot be told from deletions, so there is no automatic merge', () => {
    const local = base + '\n' + entry('Local new', 'c', 'local');
    const remote = base + '\n' + entry('Remote new', 'd', 'remote');
    const result = compareProjectMemoryEntries({ localContent: local, remoteContent: remote, baseContent: null });
    expect(result.baseKnown).toBe(false);
    expect(result.differences.map(d => d.change)).toEqual(['local-only', 'remote-only']);
    expect(result.merge.ok).toBe(false);
    if (!result.merge.ok) expect(result.merge.reason).toContain('기준 리비전');
  });

  test('ambiguous IDs, a changed header, and headings inside code fences', () => {
    const duplicated = base + '\n' + entry('Copy of A', 'a', 'other body');
    const ambiguous = compareProjectMemoryEntries({ localContent: duplicated, remoteContent: base, baseContent: base });
    expect(ambiguous.identityIssue).toBe(true);
    expect(ambiguous.merge.ok).toBe(false);

    const header = compareProjectMemoryEntries({ localContent: base, remoteContent: base.replace('Intro line.', 'Another intro.'), baseContent: base });
    expect(header.contextChanged).toBe(true);
    expect(header.merge.ok).toBe(false);

    const fenced = base + '\n```md\n### Not an entry\n```\n';
    const code = compareProjectMemoryEntries({ localContent: fenced, remoteContent: fenced, baseContent: base });
    expect(code.differences).toEqual([]);
    expect(code.same).toBe(2);
  });

  test('each one-sided choice says how many differing entries it leaves out of the new version', () => {
    const local = base.replace('- b body', '- b local') + '\n' + entry('Local new', 'c', 'local');
    const remote = base + '\n' + entry('Remote new', 'd', 'remote') + '\n' + entry('Remote two', 'f', 'remote');
    const result = compareProjectMemoryEntries({ localContent: local, remoteContent: remote, baseContent: base });
    expect(projectMemoryChoiceLosses(result)).toEqual({ keepLocal: 2, useRemote: 2 });
  });
});
