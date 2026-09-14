import { describe, expect, test } from 'bun:test';
import {
  findLiveOrcaTerminal,
  findOrcaSessionBinding,
  inspectLiveOrcaTerminal,
  inspectOrcaSessionBinding,
} from '../src/orcaSessionLookup';

const sessionId = '0bbbc3c7-9ae3-4878-856d-4097479f1a3f';
const paneKey = 'f42d2fba-9f79-450f-99d3-3feca4f10d0e:6cd2b928-a539-4db9-b015-4f5303a39486';
const tabId = 'f42d2fba-9f79-450f-99d3-3feca4f10d0e';
const worktreeId = 'bdfe4122-e699-4912-9ebb-a463f8074b00::/Users/gwanli/product_2026/portmanagement';

describe('Orca context-session lookup', () => {
  test('requires a persisted session and pane identity to agree', () => {
    const state = {
      workspaceSession: {
        tabsByWorktree: {
          [worktreeId]: [{
            paneKey,
            tabId,
            worktreeId,
            providerSession: { id: sessionId },
          }],
        },
      },
    };
    expect(findOrcaSessionBinding(state, sessionId, paneKey)).toEqual({ paneKey, tabId, worktreeId });
    expect(findOrcaSessionBinding(state, sessionId, 'another:pane')).toBeNull();
  });

  test('accepts one connected runtime terminal with the exact tab and worktree', () => {
    const binding = { paneKey, tabId, worktreeId };
    const runtime = {
      terminals: [{
        handle: 'term_cb6fe34c-7d44-4cd6-a923-e512bc916475',
        tabId,
        worktreeId,
        connected: true,
        orphaned: false,
      }],
    };
    expect(findLiveOrcaTerminal(runtime, binding)).toMatchObject({
      handle: 'term_cb6fe34c-7d44-4cd6-a923-e512bc916475', tabId, worktreeId,
    });
  });

  test('fails closed for stale, disconnected, or ambiguous runtime terminals', () => {
    const binding = { paneKey, tabId, worktreeId };
    expect(findLiveOrcaTerminal({ terminals: [{
      handle: 'term_stale', tabId, worktreeId, connected: false,
    }] }, binding)).toBeNull();
    expect(findLiveOrcaTerminal({ terminals: [
      { handle: 'term_one', tabId, worktreeId, connected: true },
      { handle: 'term_two', tabId, worktreeId, connected: true },
    ] }, binding)).toBeNull();
  });

  test('exposes ambiguity to presence checks without weakening focus safety', () => {
    expect(inspectOrcaSessionBinding({ sessions: [
      { paneKey, tabId, worktreeId, providerSession: { id: sessionId } },
      { paneKey, tabId: 'other-tab', worktreeId: 'other-worktree', providerSession: { id: sessionId } },
    ] }, sessionId, paneKey).kind).toBe('ambiguous');
    expect(inspectLiveOrcaTerminal({ terminals: [
      { handle: 'term_one', tabId, worktreeId, connected: true },
      { handle: 'term_two', tabId, worktreeId, connected: true },
    ] }, { paneKey, tabId, worktreeId }).kind).toBe('ambiguous');
  });
});
