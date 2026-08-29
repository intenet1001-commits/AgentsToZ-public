import contract from '../context-api-contract.json';

/**
 * The desktop app adopts any healthy local API already listening on its port
 * rather than killing a process it does not own. That is the right default —
 * the occupant may be a dev server the user started deliberately — but it means
 * a sidecar left running by an earlier version keeps answering under a newer UI.
 *
 * The result is a screen that looks broken for reasons the user cannot see:
 * new columns render, while the session list is judged by old rules. Comparing
 * one number turns that into a sentence.
 */
export const CONTEXT_API_SCHEMA_VERSION = contract.schemaVersion;
export const REQUIRED_CONTEXT_API_CAPABILITIES = Object.freeze([
  ...contract.requiredCapabilities,
]);

export const PROJECT_MEMORY_FEEDBACK_CAPABILITY = contract.optionalCapabilities[0]!;
export const WINDOWS_JOB_SUPERVISOR_CAPABILITY = 'process.windows-job-supervisor';

export function contextApiCapabilities(
  feedbackEnabled: boolean,
  platform: NodeJS.Platform = process.platform,
  windowsSupervisorAvailable: boolean = false,
): string[] {
  return [
    ...REQUIRED_CONTEXT_API_CAPABILITIES,
    ...(feedbackEnabled ? [PROJECT_MEMORY_FEEDBACK_CAPABILITY] : []),
    ...(platform === 'win32' && windowsSupervisorAvailable ? [WINDOWS_JOB_SUPERVISOR_CAPABILITY] : []),
  ];
}

export function disabledContextApiCapabilities(
  feedbackEnabled: boolean,
  platform: NodeJS.Platform = process.platform,
  windowsSupervisorAvailable: boolean = false,
): string[] {
  return [
    ...(!feedbackEnabled ? [PROJECT_MEMORY_FEEDBACK_CAPABILITY] : []),
    ...(platform !== 'win32' || !windowsSupervisorAvailable ? [WINDOWS_JOB_SUPERVISOR_CAPABILITY] : []),
  ];
}

export type ContextApiVersionState = 'current' | 'outdated' | 'unknown';

export interface ContextApiVersionReport {
  state: ContextApiVersionState;
  /** What the running API reported, when it reported anything. */
  detected: number | null;
  required: number;
}

/** `unknown` deliberately produces no warning: an unreachable or unrecognized
 * health response is not evidence that the API is out of date. */
export function classifyContextApiVersion(
  health: unknown,
  required: number = CONTEXT_API_SCHEMA_VERSION,
): ContextApiVersionReport {
  if (!health || typeof health !== 'object' || Array.isArray(health)) {
    return { state: 'unknown', detected: null, required };
  }
  const record = health as Record<string, unknown>;
  if (record.service !== 'agentstoz-api') return { state: 'unknown', detected: null, required };
  const detected = typeof record.schemaVersion === 'number' && Number.isFinite(record.schemaVersion)
    ? record.schemaVersion
    : null;
  // A build old enough to omit the field entirely still identifies itself as
  // this service, and is by definition older than the first version that had one.
  if (detected === null) return { state: 'outdated', detected: null, required };
  const capabilities = Array.isArray(record.capabilities) ? record.capabilities : [];
  const compatible = REQUIRED_CONTEXT_API_CAPABILITIES.every(capability => capabilities.includes(capability));
  return { state: detected >= required && compatible ? 'current' : 'outdated', detected, required };
}

export function contextApiOutdatedMessage(report: ContextApiVersionReport): string {
  const detected = report.detected === null ? '이전 버전' : `v${report.detected}`;
  return `로컬 API가 ${detected}으로 실행 중입니다 (이 화면은 v${report.required} 필요).`
    + ' 앱을 완전히 종료한 뒤 다시 열면 새 API가 뜹니다. 직접 실행한 개발 서버가 3001 포트를 쓰고 있다면 그쪽을 재시작하세요.';
}
