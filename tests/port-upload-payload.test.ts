import { describe, expect, test } from 'bun:test';
import { buildPortUploadRow, portAutoUploadChangeKey, portAutoUploadTargetKey } from '../src/portUploadPayload';
import { buildPortUpsertRpcArgs } from '../src/portDurableFence';

const port = {
  id: 'one', name: 'Project', folderPath: '/tmp/project', category: '업무',
  description: '보존할 메모', syncGeneration: '9007199254740993',
  githubUrl: 'https://github.com/example/project', favorite: true,
};

describe('automatic port upload content', () => {
  test('an unconfigured startup is not Pull evidence for a later or different target', () => {
    expect(portAutoUploadTargetKey(null)).toBeNull();
    expect(portAutoUploadTargetKey({ supabaseUrl: 'https://example.test', supabaseAnonKey: 'public' })).toBeNull();
    const config = { supabaseUrl: 'https://example.test', supabaseAnonKey: 'public', deviceId: 'mac' };
    const key = portAutoUploadTargetKey(config);
    expect(key).not.toBeNull();
    for (const patch of [{ deviceId: 'win' }, { supabaseUrl: 'https://other.test' }, { supabaseAnonKey: 'new-public' }]) {
      expect(portAutoUploadTargetKey({ ...config, ...patch })).not.toBe(key);
    }
  });
  test('preserves category, description and memo through the actual fenced RPC arguments', () => {
    const row = buildPortUploadRow(port, { deviceId: 'mac', deviceName: 'Mac' }, {
      content: '메모 변경', updatedAt: '2026-09-08T13:00:00Z',
    });
    const args = buildPortUpsertRpcArgs([row], 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    expect(args.p_rows).toEqual([expect.objectContaining({
      category: '업무', description: '보존할 메모', memo: '메모 변경',
      sync_generation: '9007199254740993', device_id: 'mac',
    })]);
    expect(row).not.toHaveProperty('memory_id');
  });

  test('explicit clearing is uploaded; omitted optional memory lookup cannot clear its mapping', () => {
    const row = buildPortUploadRow({ id: 'one', name: 'Project', description: '', category: '' }, {
      deviceId: 'mac', deviceName: null,
    });
    expect(row.description).toBe('');
    expect(row.category).toBe('');
    expect(row).not.toHaveProperty('memory_id');
  });

  test('running-state polling, generation receipts and display reordering never schedule upload', () => {
    const other = { id: 'two', name: 'Other' };
    const initial = portAutoUploadChangeKey([port, other], {});
    const polled = { ...port, isRunning: true, syncGeneration: '9007199254740994' };
    expect(portAutoUploadChangeKey([other, polled], {})).toBe(initial);
    expect(portAutoUploadChangeKey([{ ...port, syncGeneration: 'invalid' }, other], {})).toBe(initial);
    expect(portAutoUploadChangeKey([port, other], { unrelated: { content: 'x', updatedAt: 'now' } })).toBe(initial);
  });

  test('relevant edits and memo-only changes schedule upload without losing precision', () => {
    const initial = portAutoUploadChangeKey([port], {});
    for (const patch of [
      { category: '개인' }, { description: '' }, { favorite: false },
      { name: 'Renamed' }, { sourceDeviceId: 'another-mac' },
      { githubUrl: 'https://github.com/example/changed' },
    ]) {
      expect(portAutoUploadChangeKey([{ ...port, ...patch }], {})).not.toBe(initial);
    }
    expect(portAutoUploadChangeKey([port], { one: { content: 'new', updatedAt: 'now' } })).not.toBe(initial);
  });
});
