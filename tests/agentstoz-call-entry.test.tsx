import {expect, test} from 'bun:test';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {AgentsToZVoiceDock} from '../src/components/AgentsToZVoiceDock';
import {AiTerminalPanel} from '../src/AiTerminalPanel';

test('「아젠투지 호출」 is the voice dock with the character — the one entry (VOC 2026-09-29)', () => {
  const html = renderToStaticMarkup(<AgentsToZVoiceDock transport={async () => ({})} />);
  expect(html).toContain('data-testid="voice-dock-call"');
  expect(html).toContain('아젠투지 호출');
  expect(html).toContain('data-testid="agentstoz-mascot"');
  expect(html).toContain('눌러서 말하기');
});

test('a workroom has no voice button of its own; it shows what 아젠투지 sent there', () => {
  const panel = readFileSync(join(import.meta.dir, '../src/AiTerminalPanel.tsx'), 'utf8');
  expect(panel).not.toMatch(/\bVoiceButton\b|WorkroomVoiceCall|workroom-voice-button/);
  expect(panel).toContain('<VoiceSentReceipt sessionId={activeSession.id}/>');
});

test('the OPS Workroom landing has no second voice entry; it says its box types to the OPS AI (VOC 2026-09-29)', () => {
  const projects = [{targetId: 'ops-target', label: 'AgentsToZ-Control'}, {targetId: 'other-target', label: 'Other'}];
  // The panel restores its selected project from sessionStorage before effects run.
  const stored = new Map<string, string>();
  (globalThis as any).sessionStorage = {getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => stored.set(k, v), removeItem: (k: string) => stored.delete(k)};
  const render = (targetId: string) => { stored.set('agentstoz-terminal-target:local', targetId); return renderToStaticMarkup(<AiTerminalPanel projects={projects} opsTargetId="ops-target" />); };
  const ops = render('ops-target');
  expect(ops).not.toContain('workroom-ops-voice-start');
  expect(ops).toContain('data-testid="workroom-ops-input-hint"');
  expect(ops).toContain('화면 아래 「아젠투지 호출」');
  const other = render('other-target');
  expect(other).not.toContain('workroom-ops-input-hint');
  expect(ops).not.toContain('Gemini 음성 설정');
  delete (globalThis as any).sessionStorage;
});
