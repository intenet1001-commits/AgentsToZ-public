#!/usr/bin/env bun

/**
 * Opt-in live adapter benchmark. It deliberately bypasses no safety gate: both
 * turns use workspace-write/never in a new private temp directory, print no
 * prompt, transcript, provider IDs, executable path, hash, or account data,
 * and delete the retained provider thread before removing the temp directory.
 */

import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  inspectCodexAgentRuntimeCompatibility,
  mutateCodexConversation,
  runCodexConversationTurn,
  type CodexAgentProviderIds,
  type CodexAgentTaskEventDraft,
} from './src/codexAgentRuntime';
import {
  resolveCodexRuntimeExecutable,
  type CodexRuntimeExecutableIdentity,
} from './src/codexRuntimeExecutable';

interface TurnTiming {
  readonly totalMs: number;
  readonly threadBoundMs: number | null;
  readonly turnBoundMs: number | null;
  readonly firstEventMs: number | null;
}

function elapsed(startedAt: number, at: number | null): number | null {
  return at === null ? null : Math.round((at - startedAt) * 10) / 10;
}

async function measuredTurn(input: {
  conversationId: string;
  providerThreadId: string | null;
  executable: NonNullable<Awaited<ReturnType<typeof resolveCodexRuntimeExecutable>>>;
  cwd: string;
  model: string;
  reasoningEffort: string;
}): Promise<{ threadId: string; timing: TurnTiming }> {
  const startedAt = performance.now();
  let threadBoundAt: number | null = null;
  let turnBoundAt: number | null = null;
  let firstEventAt: number | null = null;
  let threadId = '';
  await runCodexConversationTurn({
    conversationId: input.conversationId,
    providerThreadId: input.providerThreadId,
    codexExecutable: input.executable.path,
    codexExecutableIdentity: input.executable,
    cwd: input.cwd,
    model: input.model,
    reasoningEffort: input.reasoningEffort,
    executionMode: 'workspace-write',
    prompt: '도구를 사용하지 말고 OK 한 단어만 답하세요.',
    emit(_event: CodexAgentTaskEventDraft) {
      firstEventAt ??= performance.now();
    },
    bindProviderIds(ids: CodexAgentProviderIds) {
      threadId = ids.threadId;
      if (ids.turnId) turnBoundAt ??= performance.now();
      else threadBoundAt ??= performance.now();
    },
  }, { timeoutMs: 120_000 });
  if (!threadId) throw new Error('Codex benchmark thread binding was not recorded');
  const completedAt = performance.now();
  return {
    threadId,
    timing: Object.freeze({
      totalMs: elapsed(startedAt, completedAt)!,
      threadBoundMs: elapsed(startedAt, threadBoundAt),
      turnBoundMs: elapsed(startedAt, turnBoundAt),
      firstEventMs: elapsed(startedAt, firstEventAt),
    }),
  };
}

export async function benchmarkCodexConversationAdapter() {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'agentstoz-codex-benchmark-')));
  let executable: CodexRuntimeExecutableIdentity | null = null;
  let providerThreadId: string | null = null;
  let providerThreadDeleted = false;
  try {
    const identityStartedAt = performance.now();
    executable = await resolveCodexRuntimeExecutable({ fresh: true });
    if (!executable) throw new Error('검증 가능한 Codex CLI를 찾지 못했습니다.');
    const identityMs = elapsed(identityStartedAt, performance.now())!;

    const inspectionStartedAt = performance.now();
    const inspection = await inspectCodexAgentRuntimeCompatibility({
      codexExecutable: executable.path,
      codexExecutableIdentity: executable,
      cwd: scratch,
    });
    const inspectionMs = elapsed(inspectionStartedAt, performance.now())!;
    const model = inspection.models.find(candidate => candidate.isDefault);
    if (!model) throw new Error('Codex 기본 모델을 확인하지 못했습니다.');
    const conversationId = `benchmark_${randomUUID().replaceAll('-', '_')}`;
    const first = await measuredTurn({
      conversationId,
      providerThreadId: null,
      executable,
      cwd: scratch,
      model: model.providerModel,
      reasoningEffort: model.reasoningEffort,
    });
    providerThreadId = first.threadId;
    const resumed = await measuredTurn({
      conversationId,
      providerThreadId,
      executable,
      cwd: scratch,
      model: model.providerModel,
      reasoningEffort: model.reasoningEffort,
    });
    await mutateCodexConversation({
      codexExecutable: executable.path,
      codexExecutableIdentity: executable,
      cwd: scratch,
      providerThreadId,
      action: 'delete',
    });
    providerThreadDeleted = true;
    return Object.freeze({
      schemaVersion: 1,
      kind: 'agentstoz-codex-conversation-live-benchmark',
      runtimeVersion: executable.version,
      runtimeSource: executable.source,
      modelId: model.modelId,
      reasoningEffort: model.reasoningEffort,
      identityInspectionMs: identityMs,
      compatibilityInspectionMs: inspectionMs,
      coldRetainedTurn: first.timing,
      resumedRetainedTurn: resumed.timing,
      providerThreadDeleted: true,
      promptOrTranscriptRetainedByAgentsToZ: false,
      managedExecutionAuthorized: false,
    });
  } finally {
    if (providerThreadId && !providerThreadDeleted) {
      // The primary error remains authoritative; a best-effort delete may use
      // a provider boundary that is already unhealthy.
      await mutateCodexConversation({
        codexExecutable: executable!.path,
        codexExecutableIdentity: executable!,
        cwd: scratch,
        providerThreadId,
        action: 'delete',
      }, { timeoutMs: 5_000 }).then(
        () => { providerThreadDeleted = true; },
        () => undefined,
      );
    }
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  if (process.argv.length !== 3 || process.argv[2] !== '--live') {
    console.error('usage: bun benchmark-codex-conversation.ts --live');
    process.exit(64);
  }
  try {
    const receipt = await benchmarkCodexConversationAdapter();
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : 'Codex live benchmark failed');
    process.exit(2);
  }
}
