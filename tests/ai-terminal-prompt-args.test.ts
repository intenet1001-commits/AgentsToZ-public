import {describe, expect, test} from 'bun:test';
import {aiTerminalPromptArgs, aiTerminalSupportsPrompt} from '../src/aiTerminalPromptArgs';
import {AI_TERMINAL_AGENTS, normalizeAiTerminalRequest} from '../src/aiTerminalProtocol';

// The workroom used to refuse a prompt for hermes/agy. That was not arbitrary: the single
// `-- <prompt>` form only fits codex/claude. hermes rejects `--` outright
// ("'--' is not a `hermes` command") and agy needs --prompt-interactive to keep the
// session open. Each agent gets its measured form instead of one shared guess.
describe('workroom initial prompt argv', () => {
  test('every workroom agent can carry an initial prompt', () => {
    for (const agent of AI_TERMINAL_AGENTS) {
      expect(aiTerminalSupportsPrompt(agent)).toBe(true);
    }
  });

  test('codex and claude take the prompt positionally after --', () => {
    expect(aiTerminalPromptArgs('codex', 'do the thing')).toEqual(['--', 'do the thing']);
    expect(aiTerminalPromptArgs('claude', 'do the thing')).toEqual(['--', 'do the thing']);
  });

  test('hermes uses the interactive chat entry point, never a bare --', () => {
    const args = aiTerminalPromptArgs('hermes', 'do the thing');
    expect(args).toEqual(['chat', '-q', 'do the thing']);
    expect(args).not.toContain('--');
  });

  test('agy keeps the session open with --prompt-interactive, not --print', () => {
    const args = aiTerminalPromptArgs('agy', 'do the thing');
    expect(args).toEqual(['-i', 'do the thing']);
    expect(args).not.toContain('--print');
    expect(args).not.toContain('-p');
  });

  test('a prompt survives argument injection attempts for every agent', () => {
    for (const agent of AI_TERMINAL_AGENTS) {
      const args = aiTerminalPromptArgs(agent, '--yolo ; rm -rf /');
      // The prompt is always one single argv entry, never split into flags.
      expect(args[args.length - 1]).toBe('--yolo ; rm -rf /');
    }
  });

  test('the protocol accepts a prompt for all four agents', () => {
    for (const agent of AI_TERMINAL_AGENTS) {
      const request = normalizeAiTerminalRequest({
        requestId: 'a'.repeat(24),
        operation: 'start',
        targetId: 'b'.repeat(24),
        agent,
        cols: 100,
        rows: 30,
        prompt: '이 프로젝트를 점검해줘',
      });
      expect(request.agent).toBe(agent);
      expect(request.prompt).toBe('이 프로젝트를 점검해줘');
    }
  });
});
