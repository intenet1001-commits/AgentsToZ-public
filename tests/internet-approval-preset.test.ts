import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  INTERNET_APPROVAL_PRESET_KEY,
  describeInternetApprovalPrefill,
  parseInternetApprovalPreset,
  prefillFromPreset,
  readInternetApprovalPreset,
  rememberInternetApproval,
} from '../src/internetApprovalPreset';
import { ALL_WORKROOM_TARGETS } from '../src/workroomApprovalScope';

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  };
}

const options = [{ value: ALL_WORKROOM_TARGETS, label: '현재 목록의 모든 프로젝트' }, { value: 'port:a', label: 'A 프로젝트' }];

// 2026-11-01: every new phone meant ticking the workroom grant, its scope, each feature and the Codex box one by
// one. The person asked for it to be one step next time — pre-selected from their own last approval.
describe('Mac approval of a phone: pre-select the last approved permissions', () => {
  test('the stored value is read strictly: unknown scopes are dropped, a set with no grant is nothing', () => {
    expect(parseInternetApprovalPreset(null)).toBeNull();
    expect(parseInternetApprovalPreset('{not json')).toBeNull();
    expect(parseInternetApprovalPreset(JSON.stringify({ workroom: false, conversation: false, task: false }))).toBeNull();
    const parsed = parseInternetApprovalPreset(JSON.stringify({
      workroom: true, scope: 'port:a', workspaceScopes: ['voice.use', 'admin.everything', 'voice.use'],
      historyScopes: ['nope'], conversation: 'yes', task: true,
    }));
    expect(parsed).toEqual({ workroom: true, scope: 'port:a', workspaceScopes: ['voice.use'], historyScopes: [], conversation: false, task: true });
  });

  test('an approval writes the whole set; a later save on an approved phone updates only its own fields', () => {
    const storage = memoryStorage();
    rememberInternetApproval({ workroom: true, scope: ALL_WORKROOM_TARGETS, workspaceScopes: ['voice.use', 'meta-memory.manage'], historyScopes: [] }, storage);
    rememberInternetApproval({ conversation: true, task: false }, storage);
    expect(readInternetApprovalPreset(storage)).toEqual({
      workroom: true, scope: ALL_WORKROOM_TARGETS, workspaceScopes: ['voice.use', 'meta-memory.manage'], historyScopes: [], conversation: true, task: false,
    });
    // An approval without the workroom forgets the workroom half instead of keeping a stale grant.
    rememberInternetApproval({ conversation: true, task: false, workroom: false, workspaceScopes: [], historyScopes: [] }, storage);
    expect(readInternetApprovalPreset(storage)?.workroom).toBe(false);
    // Nothing granted at all: the key is removed rather than kept as an empty preset.
    rememberInternetApproval({ conversation: false }, storage);
    expect(storage.data.has(INTERNET_APPROVAL_PRESET_KEY)).toBe(false);
  });

  test('a remembered scope this Mac no longer offers is left blank, never replaced by another target', () => {
    const preset = { workroom: true, scope: 'port:gone', workspaceScopes: ['voice.use' as const], historyScopes: [], conversation: true, task: true };
    const prefill = prefillFromPreset(preset, options, false)!;
    expect(prefill.scope).toBe('');
    expect(prefill.scopeMissing).toBe(true);
    // The production gate for Codex task execution is closed in this build: never pre-select it.
    expect(prefill.task).toBe(false);
    expect(prefill.conversation).toBe(true);
    expect(describeInternetApprovalPrefill(prefill, options)).toContain('워크룸(범위는 다시 선택)');
    expect(prefillFromPreset(null, options, true)).toBeNull();
  });

  test('the card says what was pre-selected and that nothing applies before the code and approval', () => {
    const prefill = prefillFromPreset({ workroom: true, scope: 'port:a', workspaceScopes: ['voice.use', 'records.read'], historyScopes: [], conversation: true, task: false }, options, true)!;
    const text = describeInternetApprovalPrefill(prefill, options);
    expect(text).toContain('워크룸(A 프로젝트)');
    expect(text).toContain('모바일 기능 2개');
    expect(text).toContain('지속형 Codex 대화');
    expect(text).toContain('코드를 확인하고 승인해야 적용됩니다');
  });

  test('the dialog pre-selects once per phone, shows the summary with a clear button, and remembers every save', () => {
    const dialog = readFileSync(new URL('../src/InternetQrRemoteControlDialog.tsx', import.meta.url), 'utf8');
    // Once per pending phone, without overwriting a box the person already changed.
    expect(dialog).toContain('prefillAppliedRef.current.has(session.sessionId)');
    expect(dialog).toContain("sessionId in current ? current");
    // Waits for the workroom targets so a remembered scope is not misread as gone.
    expect(dialog).toContain('preset.workroom && workroomOptions.length === 0 && !workroomOptionError');
    expect(dialog).toContain('data-testid="internet-approval-prefill"');
    expect(dialog).toContain('data-testid="clear-internet-approval-prefill"');
    // Remembered after a workroom grant succeeds, after an approval, and after a Codex scope change.
    expect(dialog).toContain('rememberInternetApproval({workroom:true,scope,workspaceScopes,historyScopes})');
    expect(dialog).toContain('rememberInternetApproval({conversation:grantConversationScope,task:grantTaskScope');
    expect(dialog).toContain('rememberInternetApproval({conversation:draft.conversation,task:nextTaskScope})');
    // Approval itself is unchanged: the exact 6-digit code is still required first.
    expect(dialog).toContain('if (entered !== session.sasCode)');
  });
});
