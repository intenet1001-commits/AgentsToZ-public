# Phase 2 integration contract

This document fixes the implementation boundary for the local DEV read batch. Phase 2 is feature-gated by the root verification gate. No new thread, provider, database, scheduler or queue is introduced.

## Source adapters

`src/projectStateBundle.ts` exports:

```ts
interface ReadToolSourceResult {
  observation: SourceObservation;
  latestRunId?: string; // only tester.status.read, exact validated run ID
  reportRunId?: string; // only tester.report.read, must equal requested run ID
}
interface ReadToolSourceAdapter {
  read(binding: TargetBinding, input: ResolvedReadToolInput,
    budget: ReadBudget, signal: AbortSignal): Promise<ReadToolSourceResult>;
}
type ReadToolSourceAdapters = Partial<Record<ReadToolOperation, ReadToolSourceAdapter>>;
```

The source module exports `createReadToolSourceAdapters(options?)`, using the same source options as P1. Five fixed operation IDs and strict input unions come from `readToolBundle.ts`. tester.report.read reads only its exact validated run ID under the bound target; it never falls back to latest. References are metadata, never extracted from summary text. No adapter admits jobs, stores receipts, runs tests, probes history, creates an index/key, writes memory or launches a provider.

## Shared executor

`ProjectStateBundleHost` receives optional `operations: ReadToolSourceAdapters` alongside its existing section readers. Its new method is:

```ts
executePlan(owner: string, input: {targetId: string; plan: unknown},
  hooks?: ReadPlanExecutionHooks, signal?: AbortSignal): Promise<ReadPlanExecutionResult>
```

The plan is parsed before any adapter/repository admission. P1 fixed preview and P2 plan execute through the same host admission, global four source slots, per-run two source slots, total/source deadlines, abort propagation, real-settlement retention and shared I/O reservation. Host active limit two, target active limit one; excess rejects without an unbounded queue.

Hooks are host-internal, never wire fields:

```ts
interface ReadPlanExecutionHooks {
  onBinding?(binding: TargetBinding): Promise<boolean | void>; // false: no source execution
  onStage?(stage: ReadExecutionStageMetadata): Promise<boolean | void>; // false: stop
  active?(): boolean; // current owner/target authority, never signal-bound receipt lifetime
}
interface ReadPlanStepOutput {
  stepId: string; operation: ReadToolOperation;
  observation: SourceObservation;
  latestRunId?: string; reportRunId?: string;
}
interface ReadPlanExecutionResult {
  id: string; targetId: string; collectedAt: number; expiresAt: number;
  state: 'completed' | 'partial' | 'failed' | 'skipped' | 'cancelled' | 'unknown';
  invalidated: boolean;
  stages: ReadExecutionStageMetadata[];
  outputs: ReadPlanStepOutput[];
}
```

Terminal metadata is emitted once from the bounded observation accepted before timeout/cancellation. A late native result cannot change a receipt or volatile output. Source/authority identity failure invalidates the whole execution. Independent source failures preserve other results; unavailable dependencies skip with a reason. Reference resolution uses only accepted same-run evidence.

## Existing thread receipt facade

`src/readToolBatchHost.ts` exports `ReadToolBatchHost`:

```ts
new ReadToolBatchHost({executor: ProjectStateBundleHost,
  repository: ReadToolBatchRepository & {cancel(...): Promise<ReadToolBatch>},
  active?: (owner: string, targetId: string) => boolean})

start(owner, {targetId, threadId, requestId, plan}, signal?)
read(owner, {targetId, threadId, requestId}, signal?)
cancel(owner, {targetId, threadId, requestId}, signal?)
// all return ReadToolBatchResult
interface ReadToolBatchResult {
  batch: ReadToolBatch;
  payload: 'available' | 'unavailable';
  result?: ReadPlanExecutionResult;
}
```

All request objects are exact. `start` parses the whole plan first. An exact existing DEV thread is mandatory; the repository performs get(threadId), owner/target checks, nested lookup and v4 admission. A same request/plan/target returns the original receipt without source reads. Changed intent conflicts. A duplicate while admitted execution is in progress returns current metadata and never waits for or reruns sources. `read` and `cancel` do not collect sources. Host restarts leave old pending/running receipts unknown through the existing repository recovery.

Durable receipts contain only the existing 16 KiB metadata schema, digests and provenance. No query, path, output excerpt or raw payload is persisted. CAS retries merge metadata only and do not invoke adapters. Cancel records unknown for an unsettled reader and cancelled for not-started stages; host capacity remains occupied until actual settlement.

The volatile result cache shares P1's host limit eight, target limit one and five-minute TTL. Expired/restarted/evicted payloads are unavailable; receipt lookup does not recollect them.

## Wire and transfer boundary

The exact local capability-protected POST path remains `/api/agent-runtime/project-state` with strict wrappers `batch.start`, `batch.read`, `batch.cancel`. Control 4 KiB and response 32 KiB remain. The UI receives metadata and bounded safe outputs, and retains the original request ID after uncertainty. Remote/MCP/USE/OPS are unsupported; no DEV fallback.

P2 initially supports **explicit copy-only result text**. It does not issue a P1 `projectState` attachment proof and does not silently attach batch output to a model submission. P1 prepared selection and final proof validation remain unchanged. A future direct batch attachment requires a separate exact `{threadId, requestId, resultId, stepIds, selectionHash}` selection, same owner/target/current binding, accepted source digest revalidation, bounded projection and existing submission receipt integration. Merely reading a completed receipt cannot authorize or trigger a send.

## API integration examples and activation (API worker)

The canonical path above is reused; no alternate URL, query parameter or remote action is added. Requests are exact JSON objects:

```json
{"operation":"batch.start","targetId":"project-id","threadId":"existing-thread-id","requestId":"stable-request-id","plan":{"steps":[{"id":"git","input":{"operation":"project.git.read"}}]}}
{"operation":"batch.read","targetId":"project-id","threadId":"existing-thread-id","requestId":"stable-request-id"}
{"operation":"batch.cancel","targetId":"project-id","threadId":"existing-thread-id","requestId":"stable-request-id"}
```

Success is `{success:true,batch,payload,result?}` (the `ReadToolBatchResult` fields flattened beside `success`). Failures are `{success:false,code,error}` with bounded generic user-facing text; no raw path/provider error is returned. The UI keeps `requestId` after an uncertain outcome and reads that exact receipt. Activated on 2026-10-24 after the root verification gate: new `batch.start`/`pack.run` requests are on by default and `AGENTSTOZ_READ_TOOL_BATCH_ENABLED=0` is the host-only kill switch. It gates new `batch.start` requests; exact existing receipt read/cancel remains available after feature-off. Tests enable it only in an isolated child environment. P1 preview/prepare stays available.

The API resolves the existing exact thread and fresh registered DEV target before the host call, compares its checkout identity with the original thread fingerprint, and uses a request-scoped active guard for the continuing execution. No source collection, provider startup, new thread or encryption key creation is used for that receipt access check.
