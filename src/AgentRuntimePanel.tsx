import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import {
  type AgentRuntimeAdapterCapability,
  type AgentRuntimeCapabilitiesResponse,
  type AgentRuntimeTarget,
  type AgentTaskSummary,
} from './agentRuntimeApiContract';
import {
  AgentRuntimeClient,
  AgentRuntimeClientError,
  createAgentRuntimeRequestId,
} from '../packages/runtime-sdk/client';
import {
  AGENT_RUNTIME_DANGEROUS_MODE_ENABLED,
  AGENT_RUNTIME_MANAGED_EXECUTION_ENABLED,
  AGENT_RUNTIME_PROTOCOL_VERSION,
  type AgentTaskEvent,
  type AgentTaskExecutionMode,
  type AgentTaskStatus,
} from './agentRuntimeProtocol';
import {
  clearAgentRuntimePendingRequest,
  digestAgentRuntimeStartIntent,
  persistAgentRuntimePendingRequest,
  recoverAgentRuntimePendingRequestId,
  type AgentRuntimePendingStartStorage,
} from './agentRuntimePendingStart';
import {
  BUILTIN_AGENT_RUNTIME_LABELS,
  type BuiltinAgentRuntimeId,
} from './agentRuntimeRegistry';
import {
  type AgentRuntimeReadinessDiagnostic,
  type AgentRuntimeReadinessGateStatus,
  type AgentRuntimeReadinessReason,
} from './agentRuntimeReadinessContract';
import {
  agentTaskDisplayStatus,
  agentTaskEventPollDelay,
  applyAgentTaskEventBatch,
  emptyAgentTaskProjection,
  shouldContinueAgentTaskEventPolling,
  type AgentTaskProjection,
} from './agentRuntimeState';
import { AgentRuntimeConversationView } from './AgentRuntimeConversationView';
import { MacOSRuntimeBrokerSetup } from './MacOSRuntimeBrokerSetup';
import { useDocumentVisible } from './useDocumentVisible';
import { pruneAgentRuntimeProjections, retainAgentRuntimeProjection } from './agentRuntimeProjectionCache';

export interface AgentRuntimePanelProps {
  visible: boolean;
  projects: Array<Pick<AgentRuntimeTarget, 'targetId' | 'label' | 'scope'> &
    Partial<Pick<AgentRuntimeTarget, 'projectTargetId' | 'branch' | 'locked' | 'worktreeCapable'>>>;
  onManageProject?: (projectTargetId: string) => void;
  onOpenMemory?: () => void;
  onOpenWhatISaid?: () => void;
  entryRequest?: {
    nonce: number;
    surface: 'conversations';
    targetId: string;
  } | null;
}

const TASK_REFRESH_MS = 4_000;
const CAPABILITY_REFRESH_MS = 30_000;
const TARGET_REFRESH_MS = 30_000;
const UNKNOWN_CAPABILITY_REFRESH_MS = 4_000;
const TERMINAL_TASK_STATUSES: readonly AgentTaskStatus[] = ['succeeded', 'failed', 'cancelled'];
// Vite replaces this value at build time. It is true only for the source dev
// UI served by `bun run dev` / `tauri dev`; packaged UI bundles stay closed.
const LOCAL_DEVELOPMENT_RUNTIME_TEST_MODE = String(import.meta.env.DEV) === 'true';
const CLIENT_MANAGED_EXECUTION_ENABLED = AGENT_RUNTIME_MANAGED_EXECUTION_ENABLED
  || LOCAL_DEVELOPMENT_RUNTIME_TEST_MODE;
const CLIENT_DANGEROUS_MODE_ENABLED = AGENT_RUNTIME_DANGEROUS_MODE_ENABLED
  || LOCAL_DEVELOPMENT_RUNTIME_TEST_MODE;

const READINESS_REASON_LABELS: Readonly<Record<AgentRuntimeReadinessReason, string>> = {
  'runtime-supervisor-ready': 'AI 실행 관리자가 준비됐습니다.',
  'runtime-supervisor-recovery-required': '이전 AI 실행의 잠금 복구가 필요합니다. 관련 작업의 종료 확인이 필요하며 앱 재시작만으로 해제되지 않습니다.',
  'runtime-supervisor-unavailable': 'AI 실행 관리자를 준비하지 못했습니다. 상태 확인이 필요합니다.',
  'managed-execution-policy-closed': '관리형 실행 정책이 아직 닫혀 있습니다.',
  'platform-supported': '지원하는 macOS 환경입니다.',
  'platform-unsupported': '이 운영체제용 격리 경계는 아직 준비되지 않았습니다.',
  'codex-adapter-verified': 'Codex CLI·로그인·모델·연속 대화 연결을 확인했습니다.',
  'codex-adapter-missing': '검증 가능한 Codex CLI를 찾지 못했습니다.',
  'codex-adapter-unverified': 'Codex CLI 연결을 아직 확인하지 못했습니다.',
  'production-team-pin-unconfigured': '운영용 Apple Team ID가 빌드에 고정되지 않았습니다.',
  'production-team-pin-present': '운영용 Apple Team ID 입력은 있으나 실시간 인증이 남았습니다.',
  'static-signature-snapshot-only': '정적 서명은 확인됐지만 실행 권한으로 재사용할 수 없습니다.',
  'development-ad-hoc-signing': '현재 앱은 개발용 ad-hoc 서명입니다.',
  'app-bundle-missing': '설치된 AgentsToZ 앱 번들을 찾지 못했습니다.',
  'app-executable-missing': '설치된 앱 실행 파일을 찾지 못했습니다.',
  'broker-helper-missing': '앱 번들에 네이티브 runtime broker가 아직 포함되지 않았습니다.',
  'bundle-path-unverified': '설치 앱 번들의 고정 경로 상태를 확인하지 못했습니다.',
  'signature-unverified': '앱과 broker의 코드서명을 확인하지 못했습니다.',
  'signing-mode-mismatch': '앱과 broker의 서명 방식이 서로 다릅니다.',
  'production-team-unverified': '앱과 broker의 Apple Team ID가 일치하지 않습니다.',
  'developer-id-unverified': 'Developer ID Application 서명을 확인하지 못했습니다.',
  'hardened-runtime-required': 'Hardened Runtime 서명이 필요합니다.',
  'secure-timestamp-required': '운영 서명에 secure timestamp가 필요합니다.',
  'channel-entitlement-unverified': '앱과 broker의 전용 통신 entitlement를 확인하지 못했습니다.',
  'smappservice-channel-awaits-installed-proof': 'SMAppService 상호 인증 채널은 구현됐으며 운영 서명 설치본 검증을 기다립니다.',
  'dedicated-runtime-identity-not-implemented': '전용 non-login 실행 계정 격리 구현이 남았습니다.',
  'detached-descendant-canary-not-implemented': '분리된 자식 프로세스 탈출 방지 반복 검증이 남았습니다.',
};

const READINESS_STATUS_LABELS: Readonly<Record<AgentRuntimeReadinessGateStatus, string>> = {
  passed: '확인',
  blocked: '차단',
  pending: '구현 중',
  unsupported: '미지원',
};

const STATUS_LABELS: Readonly<Record<AgentTaskStatus, string>> = {
  accepted: '접수됨',
  running: '진행 중',
  waiting: '응답 대기',
  succeeded: '완료',
  failed: '실패',
  cancelled: '취소됨',
  unknown: '상태 확인 중',
};

// State colours carry a fixed meaning (design tokens): ok = running·success,
// warn = waiting, danger = failed, info = accepted, neutral = cancelled/unknown.
const STATUS_STYLES: Readonly<Record<AgentTaskStatus, string>> = {
  accepted: 'bg-[var(--info-soft)] text-[var(--info)]',
  running: 'bg-[var(--ok-soft)] text-[var(--ok)]',
  waiting: 'bg-[var(--warn-soft)] text-[var(--warn)]',
  succeeded: 'bg-[var(--ok-soft)] text-[var(--ok)]',
  failed: 'bg-[var(--danger-soft)] text-[var(--danger)]',
  cancelled: 'bg-[var(--sunken)] text-[var(--ink-3)]',
  unknown: 'bg-[var(--sunken)] text-[var(--ink-3)]',
};

// Shared visual recipes (see the redesign brief). Tokens only — no hardcoded hues.
const MONO_CLASS = 'font-[family-name:var(--font-mono)]';
const OVERLINE_CLASS = 'text-[10.5px] font-bold uppercase tracking-[.06em]';
const BADGE_CLASS = 'inline-flex h-[22px] shrink-0 items-center whitespace-nowrap rounded-md px-2 text-[11px] font-bold';
const FIELD_LABEL_CLASS = 'flex min-w-0 flex-col gap-1.5 text-[11.5px] font-semibold text-[var(--ink-2)]';
const FIELD_CONTROL_CLASS = 'h-[38px] w-full min-w-0 rounded-lg border border-[var(--line)] bg-[var(--surface)] px-3 text-[13px] font-normal text-[var(--ink)] outline-none transition focus:border-[var(--accent-line)] focus:shadow-[0_0_0_3px_var(--accent-soft)] disabled:cursor-not-allowed disabled:opacity-50 max-sm:text-base';
const FIELD_TEXTAREA_CLASS = 'min-h-[110px] w-full min-w-0 resize-y rounded-lg border border-[var(--line)] bg-[var(--surface)] px-3 py-2.5 text-[13px] font-normal leading-[1.5] text-[var(--ink)] outline-none transition placeholder:text-[var(--ink-3)] focus:border-[var(--accent-line)] focus:shadow-[0_0_0_3px_var(--accent-soft)] disabled:cursor-not-allowed disabled:opacity-50 max-sm:text-base';
const PRIMARY_CTA_CLASS = 'inline-flex h-[38px] w-full items-center justify-center rounded-[9px] border-0 bg-[var(--ink)] px-4 text-[13px] font-bold text-[var(--bg)] transition hover:opacity-90 focus:outline-none focus:shadow-[0_0_0_3px_var(--accent-soft)] disabled:cursor-not-allowed disabled:opacity-45 max-sm:h-11';
const SOLID_BUTTON_CLASS = 'inline-flex h-8 shrink-0 items-center justify-center rounded-lg border-0 bg-[var(--ink)] px-3.5 text-xs font-bold text-[var(--bg)] transition hover:opacity-90 focus:outline-none focus:shadow-[0_0_0_3px_var(--accent-soft)] disabled:cursor-not-allowed disabled:opacity-45 max-sm:h-10';
const SECONDARY_BUTTON_CLASS = 'inline-flex h-8 shrink-0 items-center justify-center rounded-lg border border-[var(--line)] bg-transparent px-3 text-xs font-semibold text-[var(--ink-2)] transition hover:border-[var(--line-2)] hover:text-[var(--ink)] focus:outline-none focus:shadow-[0_0_0_3px_var(--accent-soft)] disabled:cursor-not-allowed disabled:opacity-50 max-sm:h-10';
const DANGER_BUTTON_CLASS = 'inline-flex h-8 shrink-0 items-center justify-center rounded-lg border border-[var(--line)] bg-transparent px-3 text-xs font-semibold text-[var(--danger)] transition hover:bg-[var(--danger-soft)] focus:outline-none focus:shadow-[0_0_0_3px_var(--danger-soft)] disabled:cursor-not-allowed disabled:opacity-50 max-sm:h-10';
const ACCENT_SOFT_BUTTON_CLASS = 'inline-flex h-[30px] shrink-0 items-center self-start rounded-[7px] border border-[var(--accent-line)] bg-[var(--accent-soft)] px-[11px] text-xs font-bold text-[var(--accent)] transition hover:border-[var(--accent)] focus:outline-none focus:shadow-[0_0_0_3px_var(--accent-soft)] max-sm:h-10';
const EMPTY_STATE_CLASS = 'rounded-xl border border-dashed border-[var(--line-2)] text-center text-[12.5px] leading-5 text-[var(--ink-3)]';
const CAPTION_CLASS = 'text-[11.5px] leading-4 text-[var(--ink-3)]';
const DISCLOSURE_SUMMARY_CLASS = 'flex cursor-pointer list-none items-center gap-2 [&::-webkit-details-marker]:hidden';

type FeedbackTone = 'danger' | 'warn' | 'ok';
const FEEDBACK_TONE_STYLES: Readonly<Record<FeedbackTone, { box: string; dot: string; lead: string }>> = {
  danger: { box: 'bg-[var(--danger-soft)]', dot: 'bg-[var(--danger)]', lead: 'text-[var(--danger)]' },
  warn: { box: 'bg-[var(--warn-soft)]', dot: 'bg-[var(--warn)]', lead: 'text-[var(--warn)]' },
  ok: { box: 'bg-[var(--ok-soft)]', dot: 'bg-[var(--ok)]', lead: 'text-[var(--ok)]' },
};

function DisclosureChevron() {
  return (
    <svg
      aria-hidden="true"
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0 transition-transform group-open:rotate-90"
    >
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}

function FeedbackBanner({
  tone,
  role,
  className = '',
  children,
}: {
  tone: FeedbackTone;
  role: 'alert' | 'status';
  className?: string;
  children: ReactNode;
}) {
  const styles = FEEDBACK_TONE_STYLES[tone];
  return (
    <p role={role} className={`flex items-start gap-2.5 rounded-[9px] px-3 py-2.5 text-xs leading-[1.5] text-[var(--ink)] ${styles.box} ${className}`}>
      <span aria-hidden="true" className={`mt-[6px] h-1.5 w-1.5 shrink-0 rounded-full ${styles.dot}`} />
      <span className="min-w-0 flex-1">{children}</span>
    </p>
  );
}

const EVENT_TITLES: Readonly<Record<AgentTaskEvent['type'], string>> = {
  'task.accepted': '작업 접수',
  'task.started': '실행 시작',
  'task.progress': '진행 상태',
  'task.question': '질문 도착',
  'task.approval.requested': '승인 요청',
  'task.approval.resolved': '승인 결과',
  'task.artifact.summary': '결과물 요약',
  'task.result': '작업 완료',
  'task.failed': '작업 실패',
  'task.cancelled': '작업 취소',
};

function formatTime(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return '';
  return new Intl.DateTimeFormat('ko-KR', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(timestamp);
}

function promptBytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function agentRuntimeStartFingerprint(
  targetId: string,
  adapterId: BuiltinAgentRuntimeId,
  modelId: string,
  executionMode: AgentTaskExecutionMode,
  prompt: string,
): string {
  return JSON.stringify([targetId, adapterId, modelId, executionMode, prompt]);
}

export interface AgentRuntimeModelSelection {
  adapterId: BuiltinAgentRuntimeId;
  modelId: string;
  requiresExplicitChoice: boolean;
}

export interface AgentRuntimeFailureRecovery {
  code: string;
  title: string;
  guidance: string;
}

export function agentRuntimeFailureRecovery(
  events: readonly AgentTaskEvent[],
): AgentRuntimeFailureRecovery | null {
  const failure = [...events].reverse().find((event): event is Extract<AgentTaskEvent, { type: 'task.failed' }> => (
    event.type === 'task.failed'
  ));
  if (!failure) return null;
  if (failure.payload.code === 'CODEX_PROCESS_TERMINATION_UNCONFIRMED') {
    return {
      code: failure.payload.code,
      title: '종료 여부를 확인하지 못해 자동 재실행을 막았습니다.',
      guidance: '준비 상태를 다시 확인하고 이 Mac의 Codex 프로세스를 점검한 뒤, 같은 요청을 자동 반복하지 말고 새 작업으로 작성하세요.',
    };
  }
  if (failure.payload.code === 'CODEX_TASK_FAILED') {
    return {
      code: failure.payload.code,
      title: 'Codex가 요청을 완료하지 못했습니다.',
      guidance: '준비 상태를 다시 확인한 뒤 새 작업에서 요청을 검토해 다시 작성할 수 있습니다. 원문 요청은 안전을 위해 자동 복원하지 않습니다.',
    };
  }
  return {
    code: failure.payload.code,
    title: failure.payload.message,
    guidance: failure.payload.retryable
      ? '준비 상태를 확인한 뒤 새 작업으로 다시 작성하세요. 중복 실행을 막기 위해 자동 재시도하지 않습니다.'
      : '진단 ID와 오류 코드를 확인하세요. 같은 요청을 자동 반복하지 않습니다.',
  };
}

export function reconcileAgentRuntimeModelSelection(
  current: AgentRuntimeModelSelection | null,
  adapterId: BuiltinAgentRuntimeId | '',
  capability: AgentRuntimeAdapterCapability | null,
): AgentRuntimeModelSelection | null {
  if (!adapterId) return null;
  if (!capability || capability.adapterId !== adapterId || capability.availability !== 'available') {
    return current?.adapterId === adapterId ? current : null;
  }
  if (current?.adapterId !== adapterId) {
    const fallback = capability.models.find(model => model.isDefault) ?? capability.models[0];
    return fallback
      ? { adapterId, modelId: fallback.modelId, requiresExplicitChoice: false }
      : { adapterId, modelId: '', requiresExplicitChoice: true };
  }
  if (current.modelId && capability.models.some(model => model.modelId === current.modelId)) return current;
  if (current.requiresExplicitChoice) return current;
  if (current.modelId) return { adapterId, modelId: '', requiresExplicitChoice: true };
  const fallback = capability.models.find(model => model.isDefault) ?? capability.models[0];
  return fallback
    ? { adapterId, modelId: fallback.modelId, requiresExplicitChoice: false }
    : { adapterId, modelId: '', requiresExplicitChoice: true };
}

function readableError(error: unknown): string {
  if (error instanceof AgentRuntimeClientError) return error.message;
  return '에이전트 런타임 상태를 확인하지 못했습니다.';
}

function isAborted(error: unknown): boolean {
  return error instanceof AgentRuntimeClientError
    && error.code === 'AGENT_RUNTIME_REQUEST_ABORTED';
}

function isTaskActive(status: AgentTaskStatus): boolean {
  return !TERMINAL_TASK_STATUSES.includes(status);
}

function pendingStartStorage(): AgentRuntimePendingStartStorage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function upsertTask(tasks: readonly AgentTaskSummary[], task: AgentTaskSummary): AgentTaskSummary[] {
  return [task, ...tasks.filter(candidate => candidate.taskId !== task.taskId)]
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
}

export function mergeAgentRuntimeTargets(
  current: readonly AgentRuntimeTarget[],
  incoming: readonly AgentRuntimeTarget[],
  complete: boolean,
): AgentRuntimeTarget[] {
  if (complete) return [...incoming];
  const merged = new Map(current.map(target => [target.targetId, target]));
  for (const target of incoming) merged.set(target.targetId, target);
  return [...merged.values()].sort((left, right) => (
    left.label.localeCompare(right.label, 'ko')
      || left.targetId.localeCompare(right.targetId)
  ));
}

function fallbackAgentRuntimeTarget(
  project: AgentRuntimePanelProps['projects'][number],
): AgentRuntimeTarget {
  return {
    targetId: project.targetId,
    projectTargetId: project.scope === 'main'
      ? project.targetId
      : project.projectTargetId ?? project.targetId,
    label: project.label,
    scope: project.scope,
    branch: project.branch ?? null,
    locked: project.locked ?? false,
    worktreeCapable: project.worktreeCapable ?? project.scope === 'worktree',
  };
}

function statusFor(task: AgentTaskSummary, projection: AgentTaskProjection | undefined): AgentTaskStatus {
  return agentTaskDisplayStatus(task, projection);
}

export function agentRuntimeCancellationNotice(status: AgentTaskStatus): string {
  switch (status) {
    case 'cancelled':
      return '작업이 취소되었습니다. 취소 전에 적용된 일부 변경은 남아 있을 수 있습니다.';
    case 'succeeded':
      return '작업이 이미 완료되었습니다. 적용된 변경은 자동으로 되돌리지 않습니다.';
    case 'failed':
      return '작업이 이미 실패로 종료되었습니다. 실패 전에 적용된 일부 변경은 남아 있을 수 있습니다.';
    case 'unknown':
      return '취소 요청 응답을 받았지만 최종 상태를 확인 중입니다. 일부 변경은 이미 적용되었을 수 있습니다.';
    case 'accepted':
    case 'running':
    case 'waiting':
      return '취소 요청을 보냈습니다. 실행 중이던 일부 변경은 이미 적용되었을 수 있으며, 최종 상태는 이벤트로 확인합니다.';
  }
}

function featureSummary(capability: AgentRuntimeAdapterCapability): ReactNode {
  const features: string[] = [];
  if (capability.features.structuredProgress) features.push('구조화 진행');
  if (capability.features.questions) features.push('구조화 질문');
  if (capability.features.approvals) features.push('구조화 승인');
  if (capability.features.cancellation) features.push('취소');
  return features.length > 0 ? features.join(' · ') : '확인된 기능 없음';
}

function eventBody(event: AgentTaskEvent, capability: AgentRuntimeAdapterCapability | null): ReactNode {
  switch (event.type) {
    case 'task.accepted': {
      const modelLabel = event.payload.modelId === null
        ? '기존 기본 모델'
        : capability?.models.find(model => model.modelId === event.payload.modelId)?.label
          ?? event.payload.modelId;
      return (
        <p>
          {event.payload.projectLabel}의 작업을 {modelLabel} 모델로 접수했습니다.
          {event.payload.executionMode === 'dangerously-bypass-approvals-and-sandbox'
            ? ' 전체 접근 모드가 명시적으로 선택되었습니다.'
            : ''}
        </p>
      );
    }
    case 'task.started':
      return <p>{capability?.label ?? event.payload.adapterId}가 작업을 시작했습니다.</p>;
    case 'task.progress':
      return (
        <>
          {event.payload.phase ? (
            <span className={`mb-1 inline-flex h-[18px] items-center rounded-md bg-[var(--sunken)] px-1.5 text-[var(--ink-3)] ${OVERLINE_CLASS}`}>
              {event.payload.phase}
            </span>
          ) : null}
          <p className="whitespace-pre-wrap break-words">{event.payload.summary}</p>
        </>
      );
    case 'task.question':
      if (!capability?.features.questions) {
        return <p>현재 확인된 기능 범위에서는 질문 내용을 표시하지 않습니다.</p>;
      }
      return (
        <>
          <p className="whitespace-pre-wrap break-words">{event.payload.prompt}</p>
          {event.payload.choices.length > 0 ? (
            <ul className="mt-2 flex flex-wrap gap-1.5" aria-label="선택지">
              {event.payload.choices.map(choice => (
                <li key={choice} className="rounded-md border border-[var(--line)] bg-[var(--surface)] px-2 py-1 text-[11px] text-[var(--ink-2)]">
                  {choice}
                </li>
              ))}
            </ul>
          ) : null}
        </>
      );
    case 'task.approval.requested':
      if (!capability?.features.approvals) {
        return <p>현재 확인된 기능 범위에서는 승인 상세를 표시하지 않습니다.</p>;
      }
      return (
        <div className="space-y-1">
          <p className="whitespace-pre-wrap break-words">{event.payload.title}</p>
          <p className="text-[11px] text-[var(--ink-3)]">위험도 {event.payload.risk} · {formatTime(event.payload.expiresAt)}까지</p>
        </div>
      );
    case 'task.approval.resolved':
      if (!capability?.features.approvals) return <p>작업이 다음 단계로 이동했습니다.</p>;
      return <p>{event.payload.decision === 'allow-once' ? '이번 작업만 승인됨' : '승인 거절됨'}</p>;
    case 'task.artifact.summary':
      return (
        <div className="space-y-1">
          <p className="font-semibold text-[var(--ink)]">{event.payload.label}</p>
          <p className="whitespace-pre-wrap break-words">{event.payload.summary}</p>
        </div>
      );
    case 'task.result':
      return <p className="whitespace-pre-wrap break-words text-[var(--ok)]">{event.payload.summary}</p>;
    case 'task.failed':
      return (
        <div className="space-y-1">
          <p className="whitespace-pre-wrap break-words text-[var(--danger)]">{event.payload.message}</p>
          <p className={`text-[11px] text-[var(--ink-3)] ${MONO_CLASS}`}>
            {event.payload.code}{event.payload.retryable ? ' · 재시도 가능' : ''}
          </p>
        </div>
      );
    case 'task.cancelled':
      return <p className="whitespace-pre-wrap break-words">{event.payload.reason}</p>;
  }
}

function TimelineEvent({
  event,
  capability,
}: {
  event: AgentTaskEvent;
  capability: AgentRuntimeAdapterCapability | null;
}) {
  const unsupportedInteractive = (event.type === 'task.question' && !capability?.features.questions)
    || ((event.type === 'task.approval.requested' || event.type === 'task.approval.resolved')
      && !capability?.features.approvals);
  return (
    <li className="group relative pl-6">
      <span aria-hidden="true" className="absolute left-[3px] top-[13px] h-2 w-2 rounded-full border border-[var(--line-2)] bg-[var(--ink-3)]" />
      <span aria-hidden="true" className="absolute bottom-[-14px] left-[6.5px] top-[23px] w-px bg-[var(--line)] group-last:hidden" />
      <article className="rounded-[10px] border border-[var(--line)] bg-[var(--bg)] p-3">
        <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
          <h4 className="text-xs font-bold text-[var(--ink)]">
            {unsupportedInteractive ? '작업 대기' : EVENT_TITLES[event.type]}
          </h4>
          <time dateTime={event.occurredAt} className={`text-[10.5px] text-[var(--ink-3)] ${MONO_CLASS}`}>
            {formatTime(event.occurredAt)}
          </time>
        </div>
        <div className="text-xs leading-5 text-[var(--ink-2)]">{eventBody(event, capability)}</div>
      </article>
    </li>
  );
}

export function AgentRuntimePanel({
  visible,
  projects,
  onManageProject,
  onOpenMemory,
  onOpenWhatISaid,
  entryRequest = null,
}: AgentRuntimePanelProps) {
  const documentVisible = useDocumentVisible();
  const observing = visible && documentVisible;
  const clientRef = useRef<AgentRuntimeClient | null>(null);
  if (!clientRef.current) clientRef.current = new AgentRuntimeClient();
  const client = clientRef.current;

  const [capabilities, setCapabilities] = useState<AgentRuntimeCapabilitiesResponse | null>(null);
  const [conversationCapabilities, setConversationCapabilities] = useState<AgentRuntimeCapabilitiesResponse | null>(null);
  const [readiness, setReadiness] = useState<AgentRuntimeReadinessDiagnostic | null>(null);
  const [tasks, setTasks] = useState<AgentTaskSummary[]>([]);
  const tasksRef = useRef<AgentTaskSummary[]>([]);
  const taskMutationEpochRef = useRef(0);
  const pendingStartRef = useRef<{ fingerprint: string; requestId: string } | null>(null);
  const taskDetailRef = useRef<HTMLDivElement | null>(null);
  const taskPromptRef = useRef<HTMLTextAreaElement | null>(null);
  const readinessRequestRef = useRef<AbortController | null>(null);
  const [projections, setProjections] = useState<ReadonlyMap<string, AgentTaskProjection>>(new Map());
  const projectionsRef = useRef<ReadonlyMap<string, AgentTaskProjection>>(new Map());
  const fallbackTargets = useMemo(
    () => projects.map(fallbackAgentRuntimeTarget),
    [projects],
  );
  const [targetSnapshot, setTargetSnapshot] = useState<AgentRuntimeTarget[] | null>(null);
  const runtimeTargets = targetSnapshot ?? fallbackTargets;
  const [selectedTargetId, setSelectedTargetId] = useState(projects[0]?.targetId ?? '');
  const [selectedAdapterId, setSelectedAdapterId] = useState<BuiltinAgentRuntimeId | ''>('');
  const [modelSelection, setModelSelection] = useState<AgentRuntimeModelSelection | null>(null);
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const activeTaskIdRef = useRef(activeTaskId);
  activeTaskIdRef.current = activeTaskId;
  const [prompt, setPrompt] = useState('');
  const [executionMode, setExecutionMode] = useState<AgentTaskExecutionMode>('workspace-write');
  const [capabilityLoading, setCapabilityLoading] = useState(false);
  const [readinessLoading, setReadinessLoading] = useState(false);
  const [targetLoading, setTargetLoading] = useState(false);
  const [taskLoading, setTaskLoading] = useState(false);
  const [starting, setStarting] = useState(false);
  const [cancellingTaskId, setCancellingTaskId] = useState<string | null>(null);
  const [capabilityError, setCapabilityError] = useState('');
  const [readinessError, setReadinessError] = useState('');
  const [targetLoadError, setTargetLoadError] = useState('');
  const [targetStatus, setTargetStatus] = useState('');
  const [taskLoadError, setTaskLoadError] = useState('');
  const [timelineError, setTimelineError] = useState('');
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState('');
  const [surfaceMode, setSurfaceMode] = useState<'tasks' | 'conversations'>('conversations');
  const [activeConversationCount, setActiveConversationCount] = useState(0);
  const appliedEntryNonceRef = useRef<number | null>(null);

  useEffect(() => {
    if (!entryRequest || entryRequest.surface !== 'conversations'
      || appliedEntryNonceRef.current === entryRequest.nonce) return;
    setSurfaceMode('conversations');
    if (runtimeTargets.some(target => target.targetId === entryRequest.targetId)) {
      appliedEntryNonceRef.current = entryRequest.nonce;
      setSelectedTargetId(entryRequest.targetId);
    }
  }, [entryRequest?.nonce, entryRequest?.surface, entryRequest?.targetId, runtimeTargets]);

  const replaceTasks = useCallback((nextTasks: AgentTaskSummary[]) => {
    tasksRef.current = nextTasks;
    setTasks(nextTasks);
  }, []);

  const replaceProjection = useCallback((taskId: string, projection: AgentTaskProjection) => {
    const next = retainAgentRuntimeProjection(projectionsRef.current, taskId, projection, activeTaskIdRef.current);
    projectionsRef.current = next;
    setProjections(next);
  }, []);

  useEffect(() => {
    let next = pruneAgentRuntimeProjections(projectionsRef.current, new Set(tasks.map(task => task.taskId)), activeTaskId);
    const selected = activeTaskId ? next.get(activeTaskId) : undefined;
    if (activeTaskId && selected) next = retainAgentRuntimeProjection(next, activeTaskId, selected, activeTaskId);
    if (next !== projectionsRef.current) {
      projectionsRef.current = next;
      setProjections(next);
    }
  }, [tasks, activeTaskId]);

  const refreshReadiness = useCallback(async () => {
    readinessRequestRef.current?.abort();
    const controller = new AbortController();
    readinessRequestRef.current = controller;
    setReadinessLoading(true);
    try {
      const response = await client.readiness({ signal: controller.signal });
      if (readinessRequestRef.current !== controller) return;
      setReadiness(response);
      setReadinessError('');
    } catch (error) {
      if (readinessRequestRef.current === controller && !isAborted(error)) {
        setReadinessError(readableError(error));
      }
    } finally {
      if (readinessRequestRef.current === controller) {
        readinessRequestRef.current = null;
        setReadinessLoading(false);
      }
    }
  }, [client]);

  useEffect(() => {
    if (runtimeTargets.some(target => target.targetId === selectedTargetId)) return;
    setSelectedTargetId(runtimeTargets[0]?.targetId ?? '');
  }, [runtimeTargets, selectedTargetId]);

  const selectableAdapters = useMemo(
    () => capabilities?.adapters.filter(adapter => (
      adapter.availability === 'available' && adapter.features.structuredProgress
    )) ?? [],
    [capabilities],
  );

  useEffect(() => {
    if (selectableAdapters.some(adapter => adapter.adapterId === selectedAdapterId)) return;
    const selected = capabilities?.adapters.find(adapter => adapter.adapterId === selectedAdapterId);
    if (selected?.availability === 'unknown') return;
    setSelectedAdapterId(selectableAdapters[0]?.adapterId ?? '');
  }, [capabilities, selectableAdapters, selectedAdapterId]);

  useEffect(() => {
    if (!observing) return undefined;
    const controller = new AbortController();
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let refreshing = false;

    const refreshTargets = async (initial: boolean) => {
      if (refreshing || stopped) return;
      refreshing = true;
      if (initial) setTargetLoading(true);
      try {
        const response = await client.targets({ signal: controller.signal });
        if (stopped) return;
        setTargetSnapshot(current => mergeAgentRuntimeTargets(
          current ?? [],
          response.targets,
          response.complete,
        ));
        setTargetLoadError('');
        setTargetStatus(response.complete
          ? ''
          : '일부 Git 워크트리 상태를 확인하지 못했습니다. 마지막 확인 목록을 유지하며 실행 직전에 다시 검증합니다.');
      } catch (error) {
        if (!stopped && !isAborted(error)) setTargetLoadError(readableError(error));
      } finally {
        refreshing = false;
        if (initial && !stopped) setTargetLoading(false);
        if (!stopped) timer = setTimeout(() => void refreshTargets(false), TARGET_REFRESH_MS);
      }
    };

    void refreshTargets(true);
    return () => {
      stopped = true;
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [client, fallbackTargets, observing]);

  useEffect(() => {
    if (!observing) return undefined;
    const controller = new AbortController();
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let refreshing = false;

    const refreshCapabilities = async (initial: boolean) => {
      if (refreshing || stopped) return;
      refreshing = true;
      if (initial) setCapabilityLoading(true);
      let nextDelay = CAPABILITY_REFRESH_MS;
      try {
        const response = await client.capabilities({ signal: controller.signal });
        if (stopped) return;
        setCapabilities(response);
        setCapabilityError('');
        if (response.adapters.some(adapter => adapter.availability === 'unknown')) {
          nextDelay = UNKNOWN_CAPABILITY_REFRESH_MS;
        }
      } catch (error) {
        if (!stopped && !isAborted(error)) {
          setCapabilityError(readableError(error));
          nextDelay = UNKNOWN_CAPABILITY_REFRESH_MS;
        }
      } finally {
        refreshing = false;
        if (initial && !stopped) setCapabilityLoading(false);
        if (!stopped) timer = setTimeout(() => void refreshCapabilities(false), nextDelay);
      }
    };

    void refreshCapabilities(true);
    return () => {
      stopped = true;
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [client, observing]);

  useEffect(() => {
    if (!observing) return undefined;
    const controller = new AbortController();
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let refreshing = false;

    const refreshConversationCapabilities = async () => {
      if (refreshing || stopped) return;
      refreshing = true;
      let nextDelay = CAPABILITY_REFRESH_MS;
      try {
        const response = await client.conversationCapabilities({ signal: controller.signal });
        if (stopped) return;
        setConversationCapabilities(response);
        if (response.adapters.some(adapter => adapter.availability === 'unknown')) {
          nextDelay = UNKNOWN_CAPABILITY_REFRESH_MS;
        }
      } catch (error) {
        if (!stopped && !isAborted(error)) {
          setConversationCapabilities(null);
          nextDelay = UNKNOWN_CAPABILITY_REFRESH_MS;
        }
      } finally {
        refreshing = false;
        if (!stopped) timer = setTimeout(refreshConversationCapabilities, nextDelay);
      }
    };

    void refreshConversationCapabilities();
    return () => {
      stopped = true;
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [client, observing]);

  useEffect(() => {
    if (!observing) return undefined;
    void refreshReadiness();
    return () => {
      readinessRequestRef.current?.abort();
      readinessRequestRef.current = null;
    };
  }, [refreshReadiness, observing]);

  useEffect(() => {
    if (!observing) return undefined;
    const controller = new AbortController();
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let refreshing = false;

    const refreshTasks = async (initial: boolean) => {
      if (refreshing || stopped) return;
      refreshing = true;
      const taskMutationEpoch = taskMutationEpochRef.current;
      if (initial) setTaskLoading(true);
      try {
        const response = await client.tasks({ signal: controller.signal });
        if (stopped) return;
        if (taskMutationEpoch === taskMutationEpochRef.current) {
          replaceTasks(response.tasks);
          setActiveTaskId(current => (
            current && response.tasks.some(task => task.taskId === current)
              ? current
              : response.tasks[0]?.taskId ?? null
          ));
        }
        setTaskLoadError('');
      } catch (error) {
        if (!stopped && !isAborted(error)) setTaskLoadError(readableError(error));
      } finally {
        refreshing = false;
        if (initial && !stopped) setTaskLoading(false);
        if (!stopped) timer = setTimeout(() => void refreshTasks(false), TASK_REFRESH_MS);
      }
    };

    void refreshTasks(true);
    return () => {
      stopped = true;
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [client, replaceTasks, observing]);

  const activeTask = activeTaskId ? tasks.find(task => task.taskId === activeTaskId) ?? null : null;
  const activeProjection = activeTaskId ? projections.get(activeTaskId) : undefined;
  const eventPollingComplete = activeTask
    ? !shouldContinueAgentTaskEventPolling(activeTask, activeProjection)
    : false;

  useEffect(() => {
    if (!observing || surfaceMode !== 'tasks' || !activeTaskId || eventPollingComplete) return undefined;
    const controller = new AbortController();
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let projection = projectionsRef.current.get(activeTaskId) ?? emptyAgentTaskProjection();
    let consecutiveFailures = 0;

    const refreshEvents = async () => {
      let continuePolling = true;
      try {
        const response = await client.events(activeTaskId, projection.lastSeq, {
          signal: controller.signal,
        });
        if (stopped) return;
        projection = applyAgentTaskEventBatch(projection, response.events);
        replaceProjection(activeTaskId, projection);
        setTimelineError('');
        consecutiveFailures = 0;
        const latestTask = tasksRef.current.find(task => task.taskId === activeTaskId);
        continuePolling = shouldContinueAgentTaskEventPolling(latestTask, projection);
      } catch (error) {
        if (!stopped && !isAborted(error)) {
          consecutiveFailures += 1;
          setTimelineError(readableError(error));
        }
      }
      if (!stopped && continuePolling) {
        timer = setTimeout(
          () => void refreshEvents(),
          agentTaskEventPollDelay(consecutiveFailures),
        );
      }
    };

    void refreshEvents();
    return () => {
      stopped = true;
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [
    activeTask?.lastSeq,
    activeTask?.status,
    activeTaskId,
    client,
    eventPollingComplete,
    replaceProjection,
    surfaceMode,
    observing,
  ]);

  useEffect(() => () => client.abort(), [client]);

  const capabilityById = useMemo(
    () => new Map(capabilities?.adapters.map(adapter => [adapter.adapterId, adapter]) ?? []),
    [capabilities],
  );
  const selectedCapability = selectedAdapterId ? capabilityById.get(selectedAdapterId) ?? null : null;
  useEffect(() => {
    setModelSelection(current => reconcileAgentRuntimeModelSelection(
      current,
      selectedAdapterId,
      selectedCapability,
    ));
  }, [selectedAdapterId, selectedCapability]);
  const selectedModelId = modelSelection?.adapterId === selectedAdapterId ? modelSelection.modelId : '';
  const selectedModel = selectedCapability?.availability === 'available'
    ? selectedCapability.models.find(model => model.modelId === selectedModelId) ?? null
    : null;
  const selectedTarget = runtimeTargets.find(target => target.targetId === selectedTargetId) ?? null;
  const activeStatus = activeTask ? statusFor(activeTask, activeProjection) : 'unknown';
  const activeCapability = activeTask ? capabilityById.get(activeTask.adapterId) ?? null : null;
  const bytes = promptBytes(prompt);
  const maxPromptBytes = capabilities?.limits.maxPromptBytes ?? 0;
  const activeTaskCount = tasks.filter(task => isTaskActive(statusFor(task, projections.get(task.taskId)))).length;
  const hasUnknownTaskStatus = tasks.some(task => statusFor(task, projections.get(task.taskId)) === 'unknown');
  const atConcurrencyLimit = capabilities
    ? activeTaskCount >= capabilities.limits.maxConcurrentTasks
    : true;
  const loading = capabilityLoading || readinessLoading || targetLoading || taskLoading;
  const loadError = [...new Set([
    capabilityError,
    targetLoadError,
    taskLoadError,
  ].filter(Boolean))].join(' ');
  const canStart = Boolean(
    CLIENT_MANAGED_EXECUTION_ENABLED
      && selectedTargetId
      && selectedAdapterId
      && selectedCapability
      && selectedCapability.availability === 'available'
      && selectedModel
      && prompt.trim()
      && bytes <= maxPromptBytes
      && !atConcurrencyLimit
      && !starting,
  );
  const activeFailureRecovery = agentRuntimeFailureRecovery(activeProjection?.events ?? []);

  const selectTask = useCallback((taskId: string) => {
    setActiveTaskId(taskId);
    if (typeof window === 'undefined'
      || typeof window.matchMedia !== 'function'
      || !window.matchMedia('(max-width: 959px)').matches) return;
    window.requestAnimationFrame(() => {
      const detail = taskDetailRef.current;
      if (!detail) return;
      detail.focus({ preventScroll: true });
      detail.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }, []);

  const copyDiagnosticId = useCallback(async (taskId: string) => {
    setActionError('');
    setNotice('');
    try {
      if (typeof navigator === 'undefined'
        || typeof navigator.clipboard?.writeText !== 'function') {
        throw new Error('clipboard unavailable');
      }
      await navigator.clipboard.writeText(taskId);
      setNotice('진단 ID를 복사했습니다.');
    } catch {
      setActionError('진단 ID를 복사하지 못했습니다. 표시된 ID를 선택해 복사해 주세요.');
    }
  }, []);

  const prepareNewTaskFromFailure = useCallback((task: AgentTaskSummary) => {
    const target = runtimeTargets.find(candidate => candidate.targetId === task.targetId);
    const capability = capabilityById.get(task.adapterId);
    if (target && !target.locked) setSelectedTargetId(target.targetId);
    if (capability?.availability === 'available') {
      setSelectedAdapterId(task.adapterId);
      if (task.modelId && capability.models.some(model => model.modelId === task.modelId)) {
        setModelSelection({
          adapterId: task.adapterId,
          modelId: task.modelId,
          requiresExplicitChoice: false,
        });
      }
    }
    setPrompt('');
    setNotice('같은 프로젝트와 실행기를 새 작업에 준비했습니다. 원문 요청은 자동으로 복원하지 않았습니다.');
    setActionError('');
    window.requestAnimationFrame(() => {
      taskPromptRef.current?.focus({ preventScroll: true });
      taskPromptRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }, [capabilityById, runtimeTargets]);

  const submitTask = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canStart || !selectedAdapterId || !selectedModel) return;
    setStarting(true);
    taskMutationEpochRef.current += 1;
    setActionError('');
    setNotice('');
    try {
      const fingerprint = agentRuntimeStartFingerprint(
        selectedTargetId,
        selectedAdapterId,
        selectedModel.modelId,
        executionMode,
        prompt,
      );
      const intentDigest = await digestAgentRuntimeStartIntent(fingerprint);
      const storage = pendingStartStorage();
      if (!pendingStartRef.current || pendingStartRef.current.fingerprint !== fingerprint) {
        const recoveredRequestId = storage
          ? recoverAgentRuntimePendingRequestId(storage, intentDigest)
          : null;
        pendingStartRef.current = {
          fingerprint,
          requestId: recoveredRequestId ?? createAgentRuntimeRequestId(),
        };
        if (storage && !recoveredRequestId) {
          try {
            persistAgentRuntimePendingRequest(
              storage,
              intentDigest,
              pendingStartRef.current.requestId,
            );
          } catch {
            // The durable server requestId remains valid even if browser
            // storage is unavailable; only reload recovery is reduced.
          }
        }
      }
      const requestId = pendingStartRef.current.requestId;
      const response = await client.start({
        protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
        requestId,
        targetId: selectedTargetId,
        adapterId: selectedAdapterId,
        modelId: selectedModel.modelId,
        executionMode,
        prompt,
      });
      // Fence a task-list GET that began after this mutation started but
      // returned a pre-commit snapshot after the POST succeeded.
      taskMutationEpochRef.current += 1;
      const nextTasks = upsertTask(tasksRef.current, response.task);
      replaceTasks(nextTasks);
      selectTask(response.task.taskId);
      if (!projectionsRef.current.has(response.task.taskId)) {
        replaceProjection(response.task.taskId, emptyAgentTaskProjection());
      }
      setPrompt('');
      setExecutionMode('workspace-write');
      pendingStartRef.current = null;
      if (storage) clearAgentRuntimePendingRequest(storage, requestId);
      setNotice(response.duplicate ? '이미 접수된 요청으로 이동했습니다.' : '작업을 안전하게 접수했습니다.');
    } catch (error) {
      if (!isAborted(error)) setActionError(readableError(error));
    } finally {
      setStarting(false);
    }
  };

  const cancelTask = async (task: AgentTaskSummary) => {
    const capability = capabilityById.get(task.adapterId);
    const projectedStatus = statusFor(task, projectionsRef.current.get(task.taskId));
    if (!capability?.features.cancellation || !isTaskActive(projectedStatus)) return;
    setCancellingTaskId(task.taskId);
    taskMutationEpochRef.current += 1;
    setActionError('');
    setNotice('');
    try {
      const response = await client.cancel(
        task.taskId,
        createAgentRuntimeRequestId('cancel'),
      );
      // A delayed list response must not resurrect the pre-cancel status.
      taskMutationEpochRef.current += 1;
      replaceTasks(upsertTask(tasksRef.current, response.task));
      setNotice(agentRuntimeCancellationNotice(response.task.status));
    } catch (error) {
      if (!isAborted(error)) setActionError(readableError(error));
    } finally {
      setCancellingTaskId(null);
    }
  };

  if (!visible) return null;

  const unknownAdapters = capabilities?.adapters.filter(adapter => adapter.availability === 'unknown') ?? [];
  const unavailableAdapters = capabilities?.adapters.filter(adapter => adapter.availability === 'unavailable') ?? [];
  const containmentHeldAdapterLabels = !CLIENT_MANAGED_EXECUTION_ENABLED
    ? (capabilities
      ? unavailableAdapters.filter(adapter => adapter.adapterId === 'codex').map(adapter => adapter.label)
      : [BUILTIN_AGENT_RUNTIME_LABELS.codex])
    : [];
  const notImplementedAdapterLabels = capabilities
    ? unavailableAdapters
      .filter(adapter => adapter.adapterId !== 'codex')
      .map(adapter => adapter.label)
    : [
      BUILTIN_AGENT_RUNTIME_LABELS.claude,
      BUILTIN_AGENT_RUNTIME_LABELS.hermes,
      BUILTIN_AGENT_RUNTIME_LABELS.agy,
    ];
  const codexAdapterVerified = readiness?.gates.some(candidate => (
    candidate.id === 'codex-adapter'
      && candidate.status === 'passed'
      && candidate.reason === 'codex-adapter-verified'
  )) === true;

  const switchSurfaceFromKeyboard = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    let next: 'tasks' | 'conversations' | null = null;
    if (event.key === 'ArrowLeft' || event.key === 'Home') next = 'tasks';
    if (event.key === 'ArrowRight' || event.key === 'End') next = 'conversations';
    if (!next) return;
    event.preventDefault();
    setSurfaceMode(next);
    const tabId = next === 'tasks'
      ? 'agent-runtime-tasks-tab'
      : 'agent-runtime-conversations-tab';
    window.requestAnimationFrame(() => document.getElementById(tabId)?.focus());
  };

  const readinessPassedCount = readiness?.gates.filter(gate => gate.status === 'passed').length ?? 0;
  const readinessAllPassed = readiness ? readinessPassedCount === readiness.gates.length : false;
  const surfaceActivityCount = surfaceMode === 'conversations' ? activeConversationCount : activeTaskCount;
  const showStatusStrip = LOCAL_DEVELOPMENT_RUNTIME_TEST_MODE
    || !AGENT_RUNTIME_MANAGED_EXECUTION_ENABLED
    || Boolean(readinessError)
    || Boolean(readiness);

  return (
    <section
      aria-labelledby="agent-runtime-title"
      aria-busy={loading}
      data-testid="agent-runtime-panel"
      className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--surface)] text-[13px] text-[var(--ink)]"
    >
      <header className="flex min-h-[56px] flex-wrap items-center gap-x-3.5 gap-y-2 border-b border-[var(--line)] px-4 py-2 sm:px-6">
        <div className="min-w-0 shrink-0">
          <p className={`${OVERLINE_CLASS} text-[var(--accent)]`}>AgentsToZ Runtime</p>
          <h2 id="agent-runtime-title" className="whitespace-nowrap text-[15px] font-bold tracking-[-.01em] text-[var(--ink)]">
            {surfaceMode === 'tasks' ? '에이전트 작업 센터' : '에이전트 대화 센터'}
          </h2>
        </div>
        <nav aria-label="에이전트 런타임 화면" className="shrink-0">
          <div className="inline-flex gap-0.5 rounded-lg bg-[var(--sunken)] p-[3px]" role="tablist">
            <button
              id="agent-runtime-tasks-tab"
              type="button"
              role="tab"
              aria-controls="agent-runtime-tasks-panel"
              aria-selected={surfaceMode === 'tasks'}
              tabIndex={surfaceMode === 'tasks' ? 0 : -1}
              onKeyDown={switchSurfaceFromKeyboard}
              onClick={() => setSurfaceMode('tasks')}
              className={`h-[26px] rounded-md border-0 px-3 text-xs font-bold transition focus:outline-none focus-visible:shadow-[0_0_0_3px_var(--accent-soft)] max-sm:h-9 ${surfaceMode === 'tasks'
                ? 'bg-[var(--surface)] text-[var(--ink)] shadow-[0_1px_2px_rgba(0,0,0,.08)]'
                : 'bg-transparent text-[var(--ink-3)] hover:text-[var(--ink-2)]'}`}
            >
              작업
            </button>
            <button
              id="agent-runtime-conversations-tab"
              type="button"
              role="tab"
              aria-controls="agent-runtime-conversations-panel"
              aria-selected={surfaceMode === 'conversations'}
              tabIndex={surfaceMode === 'conversations' ? 0 : -1}
              onKeyDown={switchSurfaceFromKeyboard}
              onClick={() => setSurfaceMode('conversations')}
              className={`h-[26px] rounded-md border-0 px-3 text-xs font-bold transition focus:outline-none focus-visible:shadow-[0_0_0_3px_var(--accent-soft)] max-sm:h-9 ${surfaceMode === 'conversations'
                ? 'bg-[var(--surface)] text-[var(--ink)] shadow-[0_1px_2px_rgba(0,0,0,.08)]'
                : 'bg-transparent text-[var(--ink-3)] hover:text-[var(--ink-2)]'}`}
            >
              대화
            </button>
          </div>
        </nav>
        <span className="ml-auto inline-flex h-[26px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-[var(--line)] px-2.5 text-[11.5px] text-[var(--ink-2)]">
          <span
            aria-hidden="true"
            className={`h-1.5 w-1.5 rounded-full ${!loading && surfaceActivityCount > 0 ? 'bg-[var(--ok)]' : 'bg-[var(--ink-3)]'}`}
          />
          {loading
            ? '상태 확인 중'
            : surfaceMode === 'conversations'
              ? `응답 중 ${activeConversationCount}개`
              : `진행 중 ${activeTaskCount}개`}
        </span>
        <p className="hidden basis-full text-xs leading-5 text-[var(--ink-3)] sm:block">
          {surfaceMode === 'tasks'
            ? '등록된 프로젝트·폴더와 Git 워크트리를 선택해 요청하고, 작업별 진행 상태와 결과를 확인하세요.'
            : 'Codex 앱의 프로젝트별 지속 대화를 기준으로, AgentsToZ가 소유한 구조화 세션을 모바일 원격 화면에서도 이어갑니다.'}
        </p>
      </header>

      {showStatusStrip ? (
        <div className="flex flex-col gap-1.5 border-b border-[var(--line)] bg-[var(--bg)] px-4 py-2.5 sm:px-6">
          {LOCAL_DEVELOPMENT_RUNTIME_TEST_MODE ? (
            <details open className="group rounded-[9px] bg-[var(--danger-soft)] px-3 py-2.5" role="status">
              <summary className={`${DISCLOSURE_SUMMARY_CLASS} items-start gap-2.5 text-xs font-bold leading-[1.5] text-[var(--danger)]`}>
                <span aria-hidden="true" className="mt-[6px] h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--danger)]" />
                <span className="min-w-0 flex-1">로컬 개발 테스트 모드 · 파일 수정과 전체 접근 실행 허용</span>
                <span className="mt-[3px] shrink-0"><DisclosureChevron /></span>
              </summary>
              <p className="mt-1 pl-4 text-xs leading-[1.5] text-[var(--ink)]">
                이 권한은 현재 소스 개발 앱에서만 열립니다. 등록 프로젝트와 워크트리에서 Codex의 실제 쓰기 동작을 검증할 수 있지만,
                배포 빌드에는 포함되지 않습니다. 모바일 원격 테스트는 workspace-write만 허용하며 전체 접근 권한은 전달하지 않습니다.
                중요한 프로젝트에서는 먼저 전용 워크트리를 선택하세요.
              </p>
            </details>
          ) : !AGENT_RUNTIME_MANAGED_EXECUTION_ENABLED ? (
            <details className="group rounded-[9px] bg-[var(--warn-soft)] px-3 py-2.5" role="status">
              <summary className={`${DISCLOSURE_SUMMARY_CLASS} items-start gap-2.5 text-xs font-bold leading-[1.5] text-[var(--warn)]`}>
                <span aria-hidden="true" className="mt-[6px] h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--warn)]" />
                <span className="min-w-0 flex-1">파일을 바꾸는 런타임 작업은 안정성 게이트로 일시 중지했습니다.</span>
                <span className="mt-[3px] shrink-0"><DisclosureChevron /></span>
              </summary>
              <p className="mt-1 pl-4 text-xs leading-[1.5] text-[var(--ink)]">
                일반 작업공간 모드에서도 분리된 자식 프로세스가 작업 종료 뒤 남을 수 있음을 확인했습니다.
                OS가 강제하는 비탈출 프로세스 격리와 회귀 테스트가 완료될 때까지 쓰기 작업 capability는 열지 않습니다.
                Codex 대화는 별도의 읽기 전용 경계에서 사용할 수 있습니다.
              </p>
            </details>
          ) : null}

          {readinessError ? (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-[9px] bg-[var(--danger-soft)] px-3 py-2.5">
              <p role="alert" className="min-w-0 flex-1 text-xs leading-[1.5] text-[var(--ink)]">
                <b className="font-bold text-[var(--danger)]">실행 준비 상태를 확인하지 못했습니다.</b> {readinessError}
              </p>
              <button
                type="button"
                onClick={() => void refreshReadiness()}
                disabled={readinessLoading}
                className={DANGER_BUTTON_CLASS}
              >
                {readinessLoading ? '다시 확인 중…' : '준비 상태 다시 확인'}
              </button>
            </div>
          ) : null}

          {readiness ? (
            <details className="group" data-testid="agent-runtime-readiness">
              <summary className={`${DISCLOSURE_SUMMARY_CLASS} h-[30px] px-1 text-xs font-semibold text-[var(--ink-2)] transition hover:text-[var(--ink)]`}>
                <DisclosureChevron />
                <span>
                  실행 준비 현황 ·{' '}
                  <span className={`${MONO_CLASS} ${readinessAllPassed ? 'text-[var(--ok)]' : 'text-[var(--warn)]'}`}>
                    {readinessPassedCount}/{readiness.gates.length}
                  </span>
                  {' '}시스템 검사 통과
                </span>
              </summary>
              <div className="mt-1 flex flex-col gap-2 rounded-[10px] border border-[var(--line)] bg-[var(--surface)] p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <p className="max-w-2xl text-[11.5px] leading-5 text-[var(--ink-3)]">
                    아래 결과는 읽기 전용 진단이며 실행 권한으로 사용되지 않습니다.
                    {!CLIENT_MANAGED_EXECUTION_ENABLED
                      ? ' 남은 항목은 앱 격리·서명 검증 단계이며 이 화면에서 사용자가 설정할 항목이 아닙니다.'
                      : LOCAL_DEVELOPMENT_RUNTIME_TEST_MODE
                        ? ' 개발 테스트 권한은 이 출하 준비 판정과 분리되어 있습니다.'
                        : ''}
                  </p>
                  <button
                    type="button"
                    onClick={() => void refreshReadiness()}
                    disabled={readinessLoading}
                    className={SECONDARY_BUTTON_CLASS}
                  >
                    {readinessLoading ? '확인 중…' : '다시 확인'}
                  </button>
                </div>
                <ul className="flex flex-col gap-1">
                  {readiness.gates.map(gate => (
                    <li key={gate.id} className="flex items-center justify-between gap-3 rounded-lg bg-[var(--bg)] px-3 py-2 text-[11.5px] leading-4">
                      <span className="text-[var(--ink-2)]">{READINESS_REASON_LABELS[gate.reason]}</span>
                      <span className={`${BADGE_CLASS} ${gate.status === 'passed'
                        ? 'bg-[var(--ok-soft)] text-[var(--ok)]'
                        : 'bg-[var(--warn-soft)] text-[var(--warn)]'}`}>
                        {READINESS_STATUS_LABELS[gate.status]}
                      </span>
                    </li>
                  ))}
                </ul>
                <MacOSRuntimeBrokerSetup visible={observing} />
              </div>
            </details>
          ) : null}
        </div>
      ) : null}

      <div
        id="agent-runtime-tasks-panel"
        role="tabpanel"
        aria-labelledby="agent-runtime-tasks-tab"
        hidden={surfaceMode !== 'tasks'}
      >
      {(loadError || targetStatus || actionError || notice || timelineError) ? (
        <div className="flex flex-col gap-1.5 border-b border-[var(--line)] px-4 py-2.5 sm:px-6" data-testid="agent-runtime-feedback">
          {loadError ? <FeedbackBanner tone="danger" role="alert">{loadError}</FeedbackBanner> : null}
          {targetStatus ? <FeedbackBanner tone="warn" role="status">{targetStatus}</FeedbackBanner> : null}
          {actionError ? <FeedbackBanner tone="danger" role="alert">{actionError}</FeedbackBanner> : null}
          {notice ? <FeedbackBanner tone="ok" role="status">{notice}</FeedbackBanner> : null}
          {timelineError ? <FeedbackBanner tone="warn" role="alert">{timelineError}</FeedbackBanner> : null}
        </div>
      ) : null}

      <div className="grid min-w-0 min-[960px]:grid-cols-[minmax(300px,380px)_1fr]">
        <div className="flex min-w-0 flex-col gap-4 border-b border-[var(--line)] p-4 sm:p-6 min-[960px]:border-b-0 min-[960px]:border-r">
          <form onSubmit={submitTask} className="flex flex-col gap-4" aria-label="새 에이전트 작업">
            <div>
              <h3 className="text-sm font-bold text-[var(--ink)]">새 작업</h3>
              <p className="mt-1 text-xs leading-4 text-[var(--ink-3)]">실행 가능이 확인된 실행기만 선택할 수 있습니다.</p>
            </div>

            <label className={FIELD_LABEL_CLASS}>
              프로젝트
              <select
                value={selectedTargetId}
                onChange={event => setSelectedTargetId(event.target.value)}
                disabled={runtimeTargets.length === 0 || starting}
                className={`${FIELD_CONTROL_CLASS} font-semibold`}
              >
                {runtimeTargets.length === 0 ? <option value="">등록된 프로젝트 또는 폴더 없음</option> : null}
                {runtimeTargets.map(target => (
                  <option key={target.targetId} value={target.targetId}>
                    {target.label} · {target.scope === 'main' ? '기본' : 'Git 워크트리'}
                    {target.branch ? ` · ${target.branch}` : ''}
                    {target.locked ? ' · 잠김' : ''}
                  </option>
                ))}
              </select>
            </label>

            {selectedTarget ? (
              <div className="flex flex-col gap-2 rounded-[9px] border border-dashed border-[var(--line-2)] bg-[var(--bg)] p-3">
                <p className={CAPTION_CLASS}>
                  {selectedTarget.scope === 'worktree' ? 'Git 워크트리' : '등록 프로젝트·폴더'}
                  {selectedTarget.branch ? ` · 브랜치 ${selectedTarget.branch}` : ''}
                  {selectedTarget.locked ? ' · Git 잠금' : ''}
                </p>
                {onManageProject ? (
                  <button
                    type="button"
                    onClick={() => onManageProject(selectedTarget.projectTargetId)}
                    className={ACCENT_SOFT_BUTTON_CLASS}
                  >
                    {selectedTarget.scope === 'worktree'
                      ? '이 워크트리 관리'
                      : selectedTarget.worktreeCapable
                        ? '워크트리 만들기·관리'
                        : '프로젝트 관리'}
                  </button>
                ) : null}
                {selectedTarget.worktreeCapable ? (
                  <p className={CAPTION_CLASS}>
                    새 워크트리는 프로젝트 화면의 워크트리 관리에서 안전하게 만듭니다.
                  </p>
                ) : null}
              </div>
            ) : null}

            <label className={FIELD_LABEL_CLASS}>
              실행기
              <select
                value={selectedAdapterId}
                onChange={event => setSelectedAdapterId(event.target.value as BuiltinAgentRuntimeId | '')}
                disabled={selectableAdapters.length === 0 || starting}
                className={FIELD_CONTROL_CLASS}
              >
                {selectableAdapters.length === 0 ? (
                  <option value="">
                    {codexAdapterVerified
                      ? 'Codex 준비됨 · OS 실행 격리 대기'
                      : '실행 가능한 실행기 없음'}
                  </option>
                ) : null}
                {selectedCapability?.availability === 'unknown'
                  && !selectableAdapters.some(adapter => adapter.adapterId === selectedCapability.adapterId) ? (
                    <option value={selectedCapability.adapterId} disabled>
                      {selectedCapability.label} · 상태 확인 중
                    </option>
                  ) : null}
                {selectableAdapters.map(adapter => (
                  <option key={adapter.adapterId} value={adapter.adapterId}>{adapter.label}</option>
                ))}
              </select>
            </label>

            <label className={FIELD_LABEL_CLASS}>
              모델
              <select
                value={selectedModelId}
                onChange={event => {
                  if (!selectedAdapterId) return;
                  setModelSelection({
                    adapterId: selectedAdapterId,
                    modelId: event.target.value,
                    requiresExplicitChoice: false,
                  });
                }}
                disabled={selectedCapability?.availability !== 'available'
                  || selectedCapability.models.length === 0
                  || starting}
                className={FIELD_CONTROL_CLASS}
              >
                {!selectedModelId ? (
                  <option value="">
                    {selectedCapability?.availability === 'unknown' ? '모델 확인 중' : '모델을 선택하세요'}
                  </option>
                ) : null}
                {selectedCapability?.models.map(model => (
                  <option key={model.modelId} value={model.modelId}>
                    {model.label}{model.isDefault ? ' · 기본' : ''}
                  </option>
                ))}
              </select>
            </label>

            {modelSelection?.adapterId === selectedAdapterId
              && modelSelection.requiresExplicitChoice ? (
                <p className="text-[11px] leading-4 text-[var(--warn)]" role="status">
                  이전에 선택한 모델이 목록에서 사라졌습니다. 실행할 모델을 다시 선택해 주세요.
                </p>
              ) : null}

            {selectedCapability ? (
              <p className="rounded-lg border border-[var(--line)] bg-[var(--bg)] px-3 py-2 text-[11.5px] leading-4 text-[var(--ink-2)]">
                {featureSummary(selectedCapability)}
              </p>
            ) : null}

            <label className={`flex cursor-pointer items-start gap-3 rounded-[9px] border px-3 py-3 text-xs leading-5 transition ${executionMode === 'dangerously-bypass-approvals-and-sandbox'
              ? 'border-[var(--danger)] bg-[var(--danger-soft)] text-[var(--danger)]'
              : 'border-[var(--line)] bg-[var(--bg)] text-[var(--ink-2)]'}`}>
              <input
                type="checkbox"
                checked={executionMode === 'dangerously-bypass-approvals-and-sandbox'}
                onChange={event => setExecutionMode(event.target.checked
                  ? 'dangerously-bypass-approvals-and-sandbox'
                  : 'workspace-write')}
                disabled={!CLIENT_DANGEROUS_MODE_ENABLED || !selectedModel || starting}
                className="mt-1 h-4 w-4 shrink-0 accent-[var(--danger)]"
              />
              <span className="min-w-0">
                <span className={`block break-all text-[11.5px] font-bold text-current ${MONO_CLASS}`}>dangerously-bypass-approvals-and-sandbox</span>
                <span className="mt-0.5 block text-[11px] leading-4 opacity-80">
                  {CLIENT_DANGEROUS_MODE_ENABLED
                    ? '소스 개발 앱에서만 모든 로컬 파일·명령 접근을 허용합니다. 배포 빌드에는 포함되지 않으며 모바일 원격에는 이 권한을 전달하지 않습니다.'
                    : '현재 비활성화되어 있습니다. 분리된 백그라운드 프로세스까지 종료를 증명하는 OS 강제 격리를 구현한 뒤에만 열립니다. 기본 작업공간 모드를 포함한 새 실행 전체가 안정성 게이트에 의해 차단되며 원격 세션에도 이 권한을 전달하지 않습니다.'}
                </span>
              </span>
            </label>

            {unknownAdapters.length > 0 ? (
              <p className="text-[11px] leading-4 text-[var(--warn)]" role="status">
                상태 확인 중: {unknownAdapters.map(adapter => adapter.label).join(', ')}
              </p>
            ) : null}
            {containmentHeldAdapterLabels.length > 0 ? (
              <p className="text-[11px] leading-4 text-[var(--warn)]" role="status">
                OS 격리 검증 대기: {containmentHeldAdapterLabels.join(', ')}
              </p>
            ) : null}
            {notImplementedAdapterLabels.length > 0 ? (
              <p className="text-[11px] leading-4 text-[var(--ink-3)]">
                구조화 실행기 구현 전: {notImplementedAdapterLabels.join(', ')}
              </p>
            ) : null}

            <label className={FIELD_LABEL_CLASS}>
              요청
              <textarea
                ref={taskPromptRef}
                value={prompt}
                onChange={event => setPrompt(event.target.value)}
                disabled={!selectedModel || starting}
                rows={6}
                maxLength={maxPromptBytes || undefined}
                placeholder="예: 현재 변경을 검토하고 관련 테스트를 실행한 뒤 결과를 정리해줘."
                className={FIELD_TEXTAREA_CLASS}
              />
            </label>
            <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
              <span className={`${MONO_CLASS} ${bytes > maxPromptBytes && maxPromptBytes > 0 ? 'text-[var(--danger)]' : 'text-[var(--ink-3)]'}`}>
                {bytes.toLocaleString()} / {maxPromptBytes.toLocaleString()} bytes
              </span>
              {atConcurrencyLimit && capabilities ? (
                <span className="text-[var(--warn)]">
                  {hasUnknownTaskStatus
                    ? '작업 상태를 확인한 뒤 새 작업을 시작할 수 있습니다.'
                    : '동시 작업 한도에 도달했습니다.'}
                </span>
              ) : null}
            </div>
            <button
              type="submit"
              disabled={!canStart}
              className={PRIMARY_CTA_CLASS}
            >
              {starting ? '접수 중…' : '작업 시작'}
            </button>
          </form>

          <div className="flex flex-col gap-3 border-t border-[var(--line)] pt-4">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-[13px] font-bold text-[var(--ink)]">작업 함</h3>
              <span className={`${MONO_CLASS} text-xs text-[var(--ink-3)]`}>{tasks.length}개</span>
            </div>
            {tasks.length === 0 ? (
              <div className={`${EMPTY_STATE_CLASS} px-4 py-6`}>
                {loading ? '작업을 불러오는 중입니다.' : '아직 작업이 없습니다.'}
              </div>
            ) : (
              <ul className="flex max-h-[28rem] flex-col gap-2 overflow-y-auto pr-1" aria-label="에이전트 작업 목록">
                {tasks.map(task => {
                  const projection = projections.get(task.taskId);
                  const status = statusFor(task, projection);
                  const selected = task.taskId === activeTaskId;
                  const taskCapability = capabilityById.get(task.adapterId);
                  const taskModelLabel = task.modelId === null
                    ? '기존 기본 모델'
                    : taskCapability?.models.find(model => model.modelId === task.modelId)?.label ?? task.modelId;
                  return (
                    <li key={task.taskId}>
                      <button
                        type="button"
                        onClick={() => selectTask(task.taskId)}
                        aria-pressed={selected}
                        aria-controls="agent-runtime-task-detail"
                        className={`w-full min-w-0 rounded-[10px] border p-3 text-left transition focus:outline-none focus-visible:shadow-[0_0_0_3px_var(--accent-soft)] ${selected
                          ? 'border-[var(--accent-line)] bg-[var(--accent-soft)]'
                          : 'border-[var(--line)] bg-[var(--bg)] hover:border-[var(--line-2)]'}`}
                      >
                        <span className="flex min-w-0 items-start justify-between gap-2">
                          <span className="min-w-0">
                            <span className="block truncate text-xs font-semibold text-[var(--ink)]">{task.projectLabel}</span>
                            <span className="mt-1 block text-[11px] leading-4 text-[var(--ink-3)]">
                              {taskCapability?.label ?? task.adapterId}{' · '}{taskModelLabel}
                              {task.executionMode === 'dangerously-bypass-approvals-and-sandbox' ? ' · 전체 접근' : ''}
                              {' · '}{formatTime(task.updatedAt)}
                            </span>
                          </span>
                          <span className={`${BADGE_CLASS} ${STATUS_STYLES[status]}`}>
                            {STATUS_LABELS[status]}
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>

        <div
          id="agent-runtime-task-detail"
          ref={taskDetailRef}
          tabIndex={-1}
          className="flex min-w-0 scroll-mt-3 flex-col gap-3.5 p-4 outline-none sm:p-6"
        >
          <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="text-sm font-bold text-[var(--ink)]">작업 타임라인</h3>
              {activeTask ? (
                <>
                  <p className="mt-1 truncate text-xs text-[var(--ink-3)]">
                    {activeTask.projectLabel} · {activeCapability?.label ?? activeTask.adapterId}
                    {' · '}{activeTask.modelId === null
                      ? '기존 기본 모델'
                      : activeCapability?.models.find(model => model.modelId === activeTask.modelId)?.label
                        ?? activeTask.modelId}
                  </p>
                  <div className="mt-2 flex min-w-0 flex-wrap items-center gap-2 text-[11px] text-[var(--ink-3)]">
                    <span>진단 ID</span>
                    <code
                      data-testid="agent-runtime-diagnostic-id"
                      className={`${MONO_CLASS} min-w-0 break-all rounded-md border border-[var(--line)] bg-[var(--bg)] px-1.5 py-0.5 text-[11px] text-[var(--ink-2)]`}
                    >
                      {activeTask.taskId}
                    </code>
                    <button
                      type="button"
                      onClick={() => void copyDiagnosticId(activeTask.taskId)}
                      className="inline-flex h-6 items-center rounded-md border border-[var(--line)] bg-transparent px-2 text-[11px] font-semibold text-[var(--ink-2)] transition hover:border-[var(--line-2)] hover:text-[var(--ink)] focus:outline-none focus-visible:shadow-[0_0_0_3px_var(--accent-soft)]"
                    >
                      ID 복사
                    </button>
                  </div>
                </>
              ) : (
                <p className="mt-1 text-xs text-[var(--ink-3)]">확인할 작업을 선택하세요.</p>
              )}
            </div>
            {activeTask ? (
              <div className="flex items-center gap-2">
                <span className={`${BADGE_CLASS} ${STATUS_STYLES[activeStatus]}`}>
                  {STATUS_LABELS[activeStatus]}
                </span>
                {activeCapability?.features.cancellation && isTaskActive(activeStatus) ? (
                  <button
                    type="button"
                    onClick={() => void cancelTask(activeTask)}
                    disabled={cancellingTaskId === activeTask.taskId}
                    className={DANGER_BUTTON_CLASS}
                  >
                    {cancellingTaskId === activeTask.taskId ? '취소 접수 중…' : '작업 취소'}
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>

          {activeTask && activeStatus === 'failed' && activeFailureRecovery ? (
            <section
              data-testid="agent-runtime-failure-recovery"
              className="flex flex-col gap-1 rounded-[9px] bg-[var(--danger-soft)] p-3"
              aria-labelledby="agent-runtime-failure-recovery-title"
            >
              <p className={`${OVERLINE_CLASS} ${MONO_CLASS} text-[var(--danger)]`}>
                {activeFailureRecovery.code}
              </p>
              <h4 id="agent-runtime-failure-recovery-title" className="text-xs font-bold text-[var(--danger)]">
                {activeFailureRecovery.title}
              </h4>
              <p className="text-[11.5px] leading-5 text-[var(--ink-2)]">{activeFailureRecovery.guidance}</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => void refreshReadiness()}
                  disabled={readinessLoading}
                  className={SECONDARY_BUTTON_CLASS}
                >
                  {readinessLoading ? '확인 중…' : '준비 상태 다시 확인'}
                </button>
                <button
                  type="button"
                  onClick={() => prepareNewTaskFromFailure(activeTask)}
                  className={SOLID_BUTTON_CLASS}
                >
                  새 작업으로 준비
                </button>
              </div>
            </section>
          ) : null}

          {activeProjection?.sync === 'gap' ? (
            <FeedbackBanner tone="warn" role="status">
              이벤트 {activeProjection.expectedSeq}번부터 다시 동기화하고 있습니다.
            </FeedbackBanner>
          ) : null}

          {!activeTask ? (
            <div className={`${EMPTY_STATE_CLASS} grid min-h-[320px] flex-1 place-items-center px-6 py-6`}>
              새 작업을 시작하거나 작업 함에서 하나를 선택하세요.
            </div>
          ) : activeProjection?.events.length ? (
            <ol className="flex flex-col gap-3.5" aria-live="polite" aria-relevant="additions text">
              {activeProjection.events.map(event => (
                <TimelineEvent key={`${event.taskId}-${event.seq}`} event={event} capability={activeCapability} />
              ))}
            </ol>
          ) : (
            <div className={`${EMPTY_STATE_CLASS} grid min-h-[320px] flex-1 place-items-center px-6 py-6`} role="status">
              작업의 첫 상태 이벤트를 기다리고 있습니다.
            </div>
          )}
        </div>
      </div>
      </div>
      <div
        id="agent-runtime-conversations-panel"
        role="tabpanel"
        aria-labelledby="agent-runtime-conversations-tab"
        hidden={surfaceMode !== 'conversations'}
      >
        <AgentRuntimeConversationView
          visible={observing && surfaceMode === 'conversations'}
          client={client}
          capabilities={conversationCapabilities}
          targets={runtimeTargets}
          codexAdapterVerified={codexAdapterVerified}
          preferredTargetId={entryRequest?.surface === 'conversations' ? entryRequest.targetId : null}
          preferredTargetNonce={entryRequest?.surface === 'conversations' ? entryRequest.nonce : null}
          onManageProject={onManageProject}
          onOpenMemory={onOpenMemory}
          onOpenWhatISaid={onOpenWhatISaid}
          onActiveCountChange={setActiveConversationCount}
        />
      </div>
    </section>
  );
}

export default AgentRuntimePanel;
