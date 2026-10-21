import {describe, expect, test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {OpsFolderMigrationNotice, opsFolderMigrationNotice, type OpsFolderMigrationRecord} from '../src/opsFolderMigrationNotice';

// Review finding 7: a rename that waits (an open OPS Workroom keeps the folder in use) or stops for a
// person was only a line in logs/api-sidecar.log. The desktop status now carries the last outcome and
// 아젠투지 설정 shows one line for it.
const at = '2026-09-29T01:02:03.004Z';
const record = (value: Omit<OpsFolderMigrationRecord, 'at'>): OpsFolderMigrationRecord => ({...value, at});

describe('the OPS folder rename notice', () => {
  test('a rename waiting on processes names them so the person can close them', () => {
    const notice = opsFolderMigrationNotice(record({status: 'skipped', reason: 'folder-in-use', blocking: [{pid: 4242, command: 'agy'}, {pid: 5151}]}));
    expect(notice).toContain('AgentsToZ-OPS');
    expect(notice).toContain('agy (4242)');
    expect(notice).toContain('PID 5151');
    expect(notice).toContain('워크룸');
  });

  test('many blocking processes are summarized', () => {
    const blocking = Array.from({length: 8}, (_, index) => ({pid: 100 + index, command: `proc${index}`}));
    const notice = opsFolderMigrationNotice(record({status: 'skipped', reason: 'folder-in-use', blocking}))!;
    expect(notice).toContain('proc0 (100)');
    expect(notice).not.toContain('proc7');
    expect(notice).toContain('외 3개');
  });

  test('other waits, a stop for a person and an unfinished run each get one line', () => {
    expect(opsFolderMigrationNotice(record({status: 'skipped', reason: 'linked-worktrees'}))).toContain('워크트리');
    expect(opsFolderMigrationNotice(record({status: 'skipped', reason: 'some-new-reason'}))).toContain('some-new-reason');
    const attention = opsFolderMigrationNotice(record({status: 'needs-attention', reason: 'OPS_FOLDER_MIGRATION_BOTH_EXIST'}))!;
    expect(attention).toContain('OPS_FOLDER_MIGRATION_BOTH_EXIST');
    expect(attention).toContain('지우거나 합치지 않았습니다');
    expect(opsFolderMigrationNotice(record({status: 'failed', reason: 'EACCES'}))).toContain('다음 실행');
  });

  test('steady states say nothing', () => {
    for (const quiet of [
      record({status: 'migrated'}), record({status: 'current'}),
      record({status: 'skipped', reason: 'no-binding'}), record({status: 'skipped', reason: 'not-control-folder'}),
      record({status: 'skipped', reason: 'custom-folder-name'}), record({status: 'skipped', reason: 'binding-not-ready'}),
    ]) expect(opsFolderMigrationNotice(quiet)).toBeNull();
    expect(opsFolderMigrationNotice(null)).toBeNull();
    expect(opsFolderMigrationNotice(undefined)).toBeNull();
  });

  test('the panel line renders only when there is something to say', () => {
    const html = renderToStaticMarkup(createElement(OpsFolderMigrationNotice, {record: record({status: 'skipped', reason: 'folder-in-use', blocking: [{pid: 4242, command: 'agy'}]})}));
    expect(html).toContain('data-testid="ops-folder-migration-notice"');
    expect(html).toContain('agy (4242)');
    expect(renderToStaticMarkup(createElement(OpsFolderMigrationNotice, {record: record({status: 'migrated'})}))).toBe('');
    expect(renderToStaticMarkup(createElement(OpsFolderMigrationNotice, {record: null}))).toBe('');
  });

  test('아젠투지 설정 reads the field from the desktop status response and shows the line', () => {
    const panel = readFileSync(new URL('../src/ControlProfilePanel.tsx', import.meta.url), 'utf8');
    expect(panel).toContain('setMigration(status.opsFolderMigration??null)');
    expect(panel).toContain('<OpsFolderMigrationNotice record={migration}/>');
  });
});
