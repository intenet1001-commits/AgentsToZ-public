import {expect,test} from 'bun:test';
import {readdirSync,readFileSync} from 'node:fs';

// CLAUDE.md is read whole at the start of every Claude Code session and is cut past 150k characters
// (it had grown to 334k by 2026-10-24). Deep-dive notes live in docs/claude/; this file keeps an index.
const root=new URL('../',import.meta.url);
const guide=readFileSync(new URL('CLAUDE.md',root),'utf8');
const topics=readdirSync(new URL('docs/claude/',root)).filter(f=>f.endsWith('.md')).sort();

test('CLAUDE.md stays well under the Claude Code size limit',()=>{
  // Characters, as Claude Code counts them (Korean text is ~1.7 bytes per character here).
  expect(guide.length).toBeLessThan(100_000);
  // An @-import would be inlined and counted against the same limit.
  expect(guide).not.toMatch(/^@docs\//m);
});

test('every docs/claude topic is in the CLAUDE.md index, and every indexed file exists',()=>{
  const indexed=[...guide.matchAll(/`docs\/claude\/([a-z0-9-]+\.md)`/g)].map(m=>m[1]!);
  expect([...new Set(indexed)].sort()).toEqual(topics);
  for(const topic of topics)expect(readFileSync(new URL('docs/claude/'+topic,root),'utf8')).toMatch(/^# \S/);
});

test('the installer-managed blocks are still present exactly once',()=>{
  for(const name of ['shared-output-style','project-memory','tester','mentions']){
    expect(guide.split(`<!-- AgentsToZ ${name}:start -->`)).toHaveLength(2);
    expect(guide.split(`<!-- AgentsToZ ${name}:end -->`)).toHaveLength(2);
  }
});
