import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Brain, Check, CloudDownload, Copy, History, Info, RefreshCw, Save } from 'lucide-react';
import { isDeployedWeb, isTauri } from './lib/env';
import { CURRENT_PROJECT_MEMORY_VERSION, standaloneMemoryVersionMarker } from './projectMemoryVersion';
import { buildAwsUbuntuMemorySetupPrompt } from './awsUbuntuMemorySetup';
import { hermesPendingWork } from './hermesProjectMemoryAdapter';
import {
  HERMES_COMMAND_HOSTS,
  HERMES_COMMAND_HOST_LABELS,
  HERMES_COMMAND_HOST_STORAGE_KEY,
  hermesCommandHostNotes,
  isHermesCommandAvailable,
  parseHermesCommandHost,
  type HermesCommandHost,
} from './hermesCommandHost';
import {
  resolveProjectMemorySyncDirection,
  type ProjectMemoryRemoteState,
} from './projectMemorySyncState';
import { projectMemoryBackupFailure } from './projectMemoryBackupResult';
import { joinMemoryIdProblem } from './projectMemoryJoin';
import {
  projectMemoryConflictFromResult,
  projectMemoryConflictMergePrompt,
  projectMemoryConflictSummary,
  projectMemoryContentPreview,
  type ProjectMemoryConflict,
} from './projectMemoryConflict';

export type ProjectMemoryAgent = 'claude' | 'codex';

export interface ProjectMemoryConfig {
  schemaVersion: 1;
  memoryId: string;
  sourcePath: string;
  agent: ProjectMemoryAgent;
  autoBackup: boolean;
  lastPulledRevisionId: string | null;
  lastSyncedHash: string | null;
  lastUpdatedAt: string | null;
  lastBackedUpAt: string | null;
  lastRememberedActivityFingerprint: string | null;
  lastRememberedAt: string | null;
}

export interface ProjectMemoryStatus {
  exists: boolean;
  projectRoot: string;
  memoryPath: string | null;
  sourcePath: string | null;
  kind: 'native' | 'legacy' | 'root-memory' | 'none';
  size: number;
  modifiedAt: string | null;
  contentHash: string | null;
  config: ProjectMemoryConfig | null;
  adapters: { claude: boolean; codex: boolean };
  memoryAgent: {
    installedVersion: number;
    currentVersion: number;
    updateAvailable: boolean;
  };
  activity: {
    needsRemember: boolean;
    reasons: Array<'project-changes' | 'session-activity'>;
    currentFingerprint: string | null;
    lastRememberedFingerprint: string | null;
    lastActivityAt: string | null;
    lastRememberedAt: string | null;
    lastAgent: ProjectMemoryAgent | null;
    worktreeCount: number;
    hooks: { claude: boolean; codex: boolean };
  };
}

/** 기기당 하나인 Hermes 게이트웨이 스킬 설치 상태. */
export interface HermesAdapterStatus {
  hermesPresent: boolean;
  /** 설정 폴더만의 존재 여부 — 「폴더는 있는데 CLI가 없다」를 구분해 말하기 위해 필요하다. */
  hermesHomePresent?: boolean;
  hermesHome: string;
  skillsDir: string;
  configPath: string;
  available: string[];
  installed: string[];
  externalDirRegistered: boolean;
  /** 옛 설치기가 남긴 `/remember` 별칭. 남은 작업이 이것뿐일 때가 있어 라벨에 필요하다. */
  legacyAliasPresent?: boolean;
  installedVersion: number;
  currentVersion: number;
  updateAvailable: boolean;
}

type MemoryResult = Record<string, any>;
type ProjectMemoryConflictResolution = 'keep-local' | 'use-remote' | 'merged';

const apiBase = () => isTauri() ? 'http://127.0.0.1:3001' : '';

async function memoryRequest<T = MemoryResult>(path: string, body: Record<string, unknown>): Promise<T> {
  // The browser needs no sidecar-startup retries, but it still needs one spare
  // attempt for a body the server failed to read under load.
  const attempts = isTauri() ? 12 : 2;
  let lastNetworkError: unknown = null;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(`${apiBase()}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await response.json().catch(() => ({}));
      // The local API does blocking filesystem work per request, and under a
      // burst it can fail to read one request's body. Nothing about the request
      // is wrong, so retrying it once is the honest response — surfacing it
      // would put "다시 확인하세요" on a random row.
      if (data.code === 'REQUEST_BODY_UNREADABLE' && attempt + 1 < attempts) {
        await new Promise(resolve => setTimeout(resolve, 120));
        continue;
      }
      if (!response.ok && !data.conflict) {
        const failure = new Error(data.error || `요청 실패 (${response.status})`);
        // Carry the server's machine-readable code so callers can tell a
        // permanent condition from one that is worth retrying.
        if (typeof data.code === 'string') (failure as Error & { code?: string }).code = data.code;
        throw failure;
      }
      return data as T;
    } catch (error) {
      // 설치 앱 시작 직후 사이드카가 준비되는 짧은 구간만 재시도한다.
      // 서버가 반환한 업무 오류(충돌·검증 실패 등)는 숨기거나 재시도하지 않는다.
      if (error instanceof Error && !/Failed to fetch|Load failed|NetworkError|fetch/i.test(error.message)) {
        throw error;
      }
      lastNetworkError = error;
      if (attempt + 1 < attempts) {
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    }
  }

  throw new Error(
    isTauri()
      ? '설치 앱의 로컬 서비스에 연결하지 못했습니다. 앱을 다시 열어주세요.'
      : lastNetworkError instanceof Error ? lastNetworkError.message : '로컬 서비스에 연결하지 못했습니다.',
  );
}

export const projectMemoryApi = {
  detect(folderPath: string) {
    return memoryRequest<ProjectMemoryStatus>('/api/project-memory/detect', { folderPath });
  },
  initialize(input: {
    folderPath: string;
    projectName?: string;
    agent: ProjectMemoryAgent;
    autoBackup: boolean;
    /** 다른 기기의 기억에 합류할 때만 채운다. */
    memoryId?: string;
  }) {
    return memoryRequest<ProjectMemoryStatus>('/api/project-memory/init', input);
  },
  update(input: { folderPath: string; projectName?: string; agent: ProjectMemoryAgent }) {
    return memoryRequest<ProjectMemoryStatus & { updated: true }>('/api/project-memory/update', input);
  },
  upgradeAgent(input: { folderPath: string }) {
    return memoryRequest<ProjectMemoryStatus & { upgraded: true; entryIdsStabilized: boolean }>('/api/project-memory/upgrade-agent', input);
  },
  setPreferredAgent(input: { folderPath: string; agent: ProjectMemoryAgent }) {
    return memoryRequest<{ success: true; tracked: boolean; agent: ProjectMemoryAgent }>('/api/project-memory/preferred-agent', input);
  },
  push(input: { folderPath: string; projectName?: string; githubUrl?: string; force?: boolean }) {
    return memoryRequest<MemoryResult>('/api/project-memory/push', input);
  },
  pull(input: { folderPath: string; projectName?: string; githubUrl?: string; force?: boolean }) {
    return memoryRequest<MemoryResult>('/api/project-memory/pull', input);
  },
  sync(input: { folderPath: string; projectName?: string; githubUrl?: string }) {
    return memoryRequest<MemoryResult>('/api/project-memory/sync', input);
  },
  remoteStatus(input: { folderPath: string; githubUrl?: string }) {
    return memoryRequest<MemoryResult>('/api/project-memory/remote-status', input);
  },
  sessionEnd(input: {
    folderPath: string;
    projectName?: string;
    githubUrl?: string;
    agent: ProjectMemoryAgent;
    autoBackup: boolean;
    // A context-session action can follow its own Claude/Codex session without
    // overwriting the agent selected in the project-memory panel.
    preservePreferredAgent?: boolean;
  }) {
    return memoryRequest<MemoryResult>('/api/project-memory/session-end', input);
  },
  history(input: { folderPath: string; githubUrl?: string }) {
    return memoryRequest<{ revisions: MemoryResult[] }>('/api/project-memory/history', input);
  },
  restoreRevision(input: { folderPath: string; projectName?: string; revisionId: string }) {
    return memoryRequest<MemoryResult>('/api/project-memory/restore-revision', input);
  },
  hermesAdapter() {
    return memoryRequest<HermesAdapterStatus>('/api/project-memory/hermes-adapter', {});
  },
  installHermesAdapter() {
    return memoryRequest<HermesAdapterStatus>('/api/project-memory/install-hermes-adapter', {});
  },
  resolveConflict(input: {
    folderPath: string;
    projectName?: string;
    githubUrl?: string;
    strategy: ProjectMemoryConflictResolution;
    /** Required when strategy is `merged`; this is a user-reviewed draft. */
    mergedContent?: string;
    expectedLocalHash: string;
    expectedRemoteRevisionId: string;
    expectedRemoteContentHash?: string | null;
  }) {
    return memoryRequest<MemoryResult>('/api/project-memory/resolve-conflict', input);
  },
};

interface Props {
  folderPath?: string;
  projectName?: string;
  githubUrl?: string;
  compact?: boolean;
  onToast?: (message: string, type: 'success' | 'error') => void;
}

const formatBytes = (value: number) => value < 1024 ? `${value} B` : `${(value / 1024).toFixed(1)} KB`;

const formatDateTimeSeconds = (value?: string | null) => {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}.${pad(date.getMonth() + 1)}.${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
};

const shortHash = (value?: string | null) => value ? `${value.slice(0, 10)}…` : '—';

// 버전은 '프로젝트 장기기억' 기능 전체가 하나로 쓴다 (src/projectMemoryVersion.ts).
// 앱이 설치하는 스킬·훅과 이 복사 프롬프트가 같은 번호를 공유하므로, 기능을 개선해 번호를
// 올리면 앱 없는 PC용 프롬프트도 같이 새 버전이 된다.
const STANDALONE_MEMORY_PROMPT_VERSION = CURRENT_PROJECT_MEMORY_VERSION;
const STANDALONE_MEMORY_PROMPT_MARKER = standaloneMemoryVersionMarker();

export function ProjectMemoryPanel({
  folderPath,
  projectName,
  githubUrl,
  compact = false,
  onToast,
}: Props) {
  const [status, setStatus] = useState<ProjectMemoryStatus | null>(null);
  const [remoteState, setRemoteState] = useState<ProjectMemoryRemoteState>({ kind: 'checking' });
  const remote = remoteState.kind === 'ready' ? remoteState.status : null;
  const [agent, setAgent] = useState<ProjectMemoryAgent>('claude');
  const [autoBackup, setAutoBackup] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [revisions, setRevisions] = useState<MemoryResult[]>([]);
  const [copiedChatCommand, setCopiedChatCommand] = useState<string | null>(null);
  // 어느 호스트의 Hermes에 붙여넣는지. 기기마다 답이 고정이라(이 Mac에만 있거나 AWS에만
  // 있거나) 매번 고르게 하지 않고 기기별 localStorage에 남긴다. 읽기 실패는 로컬로 떨어진다.
  const [hermesHost, setHermesHost] = useState<HermesCommandHost>(() => {
    try { return parseHermesCommandHost(localStorage.getItem(HERMES_COMMAND_HOST_STORAGE_KEY)); }
    catch { return 'local'; }
  });
  const chooseHermesHost = useCallback((next: HermesCommandHost) => {
    setHermesHost(next);
    try { localStorage.setItem(HERMES_COMMAND_HOST_STORAGE_KEY, next); } catch {}
  }, []);
  const [memoryConflict, setMemoryConflict] = useState<ProjectMemoryConflict | null>(null);
  const [pendingConflictResolution, setPendingConflictResolution] = useState<ProjectMemoryConflictResolution | null>(null);
  const [mergeDraft, setMergeDraft] = useState('');
  const [joinMemoryIdInput, setJoinMemoryIdInput] = useState('');
  const activityPollBusyRef = useRef(false);
  const copyResetTimerRef = useRef<number | null>(null);

  const notify = useCallback((message: string, type: 'success' | 'error') => {
    onToast?.(message, type);
    if (type === 'error') setError(message);
  }, [onToast]);

  const manualInitPrompt = [
    'AgentsToZ_byCS 프로젝트 장기기억을 이 폴더에 새로 설정해줘.',
    '1. 프로젝트 루트를 구해: PROJECT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)" (Windows PowerShell은 $PROJECT_ROOT = (git rev-parse --show-toplevel 2>$null); if (-not $PROJECT_ROOT) { $PROJECT_ROOT = (Get-Location).Path }).',
    '2. 아래 API를 호출해 초기화해 (macOS/Linux/Git Bash는 curl, Windows PowerShell은 curl.exe 사용):',
    '   curl -fsS -X POST http://127.0.0.1:3001/api/project-memory/init -H "Content-Type: application/json" -d "{\\"folderPath\\":\\"$PROJECT_ROOT\\",\\"projectName\\":\\"$(basename \\"$PROJECT_ROOT\\")\\",\\"agent\\":\\"claude\\",\\"autoBackup\\":true}"',
    '3. 응답에서 .agent-memory/CORE.md가 생성됐는지 확인하고 결과를 요약해줘.',
    '(AgentsToZ_byCS 앱의 로컬 API 서버가 http://127.0.0.1:3001 에서 실행 중이어야 합니다. 실행 중이 아니면 앱을 먼저 열어달라고 알려줘.)',
  ].join('\n');

  // 이 앱을 모르는 PC용. 외부 앱/서버 참조 없이, 파일만으로 같은 구조 + /remember-session 실행 경로를 만든다.
  const standaloneInitPrompt = [
    '이 폴더에 프로젝트 장기기억(long-term memory)을 만들어줘. 외부 앱이나 서버, 네트워크는 쓰지 않고 이 저장소 안의 파일만으로 동작해야 한다.',
    '저장 실행은 앞으로 `/remember-session` 하나로 처리되게 만든다.',
    `이 설정 절차의 버전은 ${STANDALONE_MEMORY_PROMPT_VERSION} 이다. 마커 문자열: ${STANDALONE_MEMORY_PROMPT_MARKER}`,
    '',
    '0. 프로젝트 루트: PROJECT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"',
    '   (Windows PowerShell: $PROJECT_ROOT = (git rev-parse --show-toplevel 2>$null); if (-not $PROJECT_ROOT) { $PROJECT_ROOT = (Get-Location).Path })',
    '   먼저 설치 버전을 확인한다: .agent-memory/config.json 의 memoryVersion 과',
    '   .claude/skills/remember-session/SKILL.md 안의 project-memory 마커를 읽는다.',
    '   버전이 같아도 ID 완전성 검증을 한다: fenced code 밖의 모든 실제 ### 항목 바로 뒤에',
    '   유효한 24자리 소문자 16진수 memory-entry-id가 하나씩 있고 전체에서 고유한지 센다.',
    '     - 아무것도 없으면: 신규 설치. 아래를 전부 만든다.',
    `     - 설치 버전이 ${STANDALONE_MEMORY_PROMPT_VERSION} 보다 낮거나 ID 검증이 불완전하면: 아래 순서로 1회 업그레이드한다.`,
    '       (a) 수정 전에 .agent-memory/backups/standalone-v<이전버전>-<UTC시각>/ 디렉터리를 만들고',
    '           config.json, CORE.md, notes/ 전체, manifest.json, 기존 remember-session 스킬을 바이트 그대로 백업한다.',
    '           journal/ 은 append-only 원본이므로 수정하거나 백업본으로 덮어쓰지 않는다.',
    '       (b) 기존의 유효하고 고유한 ID는 보존한다. 누락된 항목에만 새 ID를 넣고, 복사된 중복 ID는 첫 항목만 보존해 나머지만 새 ID로 교체한다.',
    '           제목·섹션·본문의 사용자 내용은 바꾸지 않는다.',
    '       (c) manifest.json 의 entries·bytes와 CORE.md 색인을 노트에서 다시 생성하되, 변경할 각 파일은 원본을 건드리지 않고 같은 디렉터리의 임시 파일에 먼저 쓴다.',
    '       (d) 임시 파일들로 구성한 staged 문서에서 모든 실제 ### 항목 수와 유효하고 고유한 memory-entry-id 수가 같은지 검증하고, manifest 순서로 재구성한 문서가 모든 기존 본문을 포함하는지 확인한다.',
    '       (e) 검증 성공 후 본문·색인·manifest 임시 파일을 원자적 rename으로 교체하고, config.json과 스킬 버전 마커 파일은 마지막에 교체한다.',
    `           검증이 모두 성공한 마지막 단계에서만 memoryVersion·promptVersion과 스킬 마커를 ${STANDALONE_MEMORY_PROMPT_VERSION} 으로 올린다.`,
    '           어느 rename이나 검증이 실패하면 백업에서 원상 복구하고 버전 마커를 올리지 않는다. 남은 임시 파일을 지우고 무엇을 복구했는지 보고한다.',
    '       (버전이 건너뛰어 올라갔을 수 있다. 중간 단계를 찾지 말고 위 절차로 현재 버전에 맞춘다.)',
    `     - 설치 버전이 ${STANDALONE_MEMORY_PROMPT_VERSION} 이고 ID 검증도 완전하면: 이미 최신이다. 파일을 고치지 말고 그 사실만 보고한다.`,
    `     - 설치 버전이 ${STANDALONE_MEMORY_PROMPT_VERSION} 보다 높으면: 다운그레이드하지 말고 그대로 두고 알린다.`,
    '',
    '1. 저장소 구조 (모두 PROJECT_ROOT 기준)',
    '   .agent-memory/config.json',
    `     {"schemaVersion":1,"memoryVersion":${STANDALONE_MEMORY_PROMPT_VERSION},"sourcePath":".agent-memory/CORE.md","lastRememberedAt":null,"lastRememberedHead":null}`,
    '   .agent-memory/notes/00-header.md — 프로젝트명·생성일 + "지속되는 결정만 담는다"는 머리말',
    '   .agent-memory/notes/01-project-identity.md, 02-key-decisions.md, 03-strategic-patterns.md,',
    '   04-recurring-issues.md, 05-active-constraints.md, 06-contested-entries.md',
    '     — 각 노트는 "## <섹션명>" 으로 시작하고, 항목은 "### <항목 제목>" 으로 쓴다. 처음엔 비어 있어도 된다.',
    '       각 항목 제목 바로 다음 줄에 <!-- memory-entry-id:<24자리 소문자 16진수> --> 를 둔다.',
    '   .agent-memory/notes/manifest.json',
    '     {"version":1,"parts":[{"file":"00-header.md","title":null,"entries":[],"bytes":0}, ...]} — parts 순서가 문서의 정본 순서다',
    '   .agent-memory/CORE.md — 생성물. 머리말 + 목차(섹션마다 노트 경로·항목 수·크기·항목 제목 목록)',
    '   .agent-memory/journal/<YYYY-MM>.md — append-only 세션 일지',
    '   .agent-memory/.gitignore — backups/ 와 *.tmp-* 만 제외. journal/ 과 notes/ 는 커밋한다.',
    '',
    '2. 지켜야 할 규칙 (이 규칙들을 아래 3번 스킬 본문에도 그대로 적는다)',
    '   - 에이전트는 평소 CORE.md(색인)만 읽고, 필요한 섹션의 노트 하나만 열어 읽는다.',
    '   - CORE.md 는 노트에서 다시 생성되는 색인이다. 손으로 고치지 말고 노트를 고친 뒤 색인을 재생성한다.',
    '   - manifest.json 의 parts 를 순서대로 이어 붙이면 전체 문서가 된다. 노트 파일을 지우거나 순서를 바꾸면 manifest 도 같이 고친다.',
    '   - 기존 memory-entry-id 는 제목을 바꾸거나 섹션을 옮겨도 보존한다. 관계없는 새 항목만 새 ID를 쓴다.',
    '   - 노트 하나는 12,000바이트를 넘기지 않는다. 넘치면 그 노트 안에서 오래된 항목을 통합·압축한다.',
    '     대체된 결정은 그것을 대체한 항목 안으로 합치되, 지속되는 결정을 통째로 지우지는 않는다.',
    '   - 비밀키·토큰·환경값·원본 대화 로그·임시 상태는 넣지 않는다. 기존 결정과 모순되는 내용은 Contested Entries 에 남긴다.',
    '',
    '3. 실행 경로: `/remember-session` 스킬을 만든다.',
    '   .claude/skills/remember-session/SKILL.md 를 만들고, frontmatter 에',
    '     name: remember-session',
    '     description: 이 프로젝트의 지속되는 결정·패턴을 .agent-memory 에 저장한다. "세션 기억하기", "작업 내용 기억해줘", "세션 종료" 에도 사용.',
    `   frontmatter 바로 아래 첫 줄에 버전 마커를 그대로 적는다: ${STANDALONE_MEMORY_PROMPT_MARKER}`,
    '   (이 마커가 설치 버전의 정본이다. 나중에 같은 설정 프롬프트를 다시 받았을 때 갱신이 필요한지 이 줄로 판단한다.)',
    '   본문에는 아래 절차를 적는다.',
    '     (1) PROJECT_ROOT 를 구하고 .agent-memory/config.json 과 CORE.md 색인을 읽는다.',
    '     (2) 이번 세션 대화 + `git status --short`, `git diff --stat`, `git log`(config 의 lastRememberedHead 이후)를 근거로 삼는다.',
    '     (3) 지속되는 것만 해당 노트에 반영한다: 결정과 근거 / 안정적인 제약 / 원인과 우회법이 있는 반복 이슈 / 검증된 이 프로젝트 전용 절차.',
    '         변경 파일 목록 같은 일회성 내용은 노트에 넣지 않는다.',
    '     (4) manifest.json 의 entries·bytes 를 갱신하고 CORE.md 색인을 재생성한다.',
    '     (5) journal/<YYYY-MM>.md 에 "## <UTC 시각> · <에이전트> · <HEAD 짧은 해시>" 항목을 append 한다.',
    '         첫 줄에는 이번 세션에서 배우거나 정한 것을 사용자 언어로 한두 문장 쓴다(파일 목록이 아니라).',
    '     (6) config.json 의 lastRememberedAt(현재 UTC)과 lastRememberedHead(현재 HEAD)를 갱신한다.',
    '     (7) 저장한 섹션과 각 노트 크기를 보고한다.',
    '   Codex 등 다른 CLI 를 쓰면 같은 내용을 그 도구의 프롬프트/커맨드 위치에도 같이 둔다.',
    '',
    '4. 에이전트가 이 기억을 실제로 읽게 만든다.',
    '   AGENTS.md(없으면 CLAUDE.md)에 짧은 절을 추가한다: 중요한 작업 전에 .agent-memory/CORE.md 색인을 읽고 관련 노트만 열 것,',
    '   사용자가 세션을 기억해 달라고 하면 `/remember-session` 절차를 따를 것. 이미 같은 절이 있으면 새로 만들지 말고 그 안을 갱신한다.',
    '',
    `5. 끝나면 설치/업그레이드 여부와 설치 버전(${STANDALONE_MEMORY_PROMPT_VERSION}), 만든 파일 목록과 각 노트 크기를 표로 요약하고,`,
    '   `/remember-session` 을 어떻게 쓰는지 한 줄로 알려줘.',
  ].join('\n');

  const copyChatCommand = useCallback(async (id: string, text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedChatCommand(id);
      if (copyResetTimerRef.current != null) window.clearTimeout(copyResetTimerRef.current);
      copyResetTimerRef.current = window.setTimeout(() => {
        setCopiedChatCommand(null);
        copyResetTimerRef.current = null;
      }, 1800);
      notify(`${label} 복사됨`, 'success');
    } catch {
      notify('클립보드에 복사하지 못했습니다.', 'error');
    }
  }, [notify]);

  const copyAwsUbuntuSetupPrompt = useCallback(async () => {
    const target = folderPath?.trim();
    if (!target) {
      notify('AWS Ubuntu 설정에 사용할 프로젝트 경로가 없습니다.', 'error');
      return;
    }
    try {
      const response = await fetch(`${apiBase()}/api/portal`);
      const portal = await response.json().catch(() => ({})) as Record<string, unknown>;
      if (!response.ok || typeof portal.supabaseUrl !== 'string' || typeof portal.supabaseAnonKey !== 'string') {
        throw new Error('로컬 앱의 Supabase URL/Anon Key 설정을 찾지 못했습니다.');
      }
      const projectRef = githubUrl?.trim() || '';
      const prompt = buildAwsUbuntuMemorySetupPrompt({
        supabaseUrl: portal.supabaseUrl,
        supabaseAnonKey: portal.supabaseAnonKey,
        projectReference: projectRef,
      });
      await copyChatCommand('aws-ubuntu', prompt, 'AWS Ubuntu 설정 프롬프트');
    } catch (error: any) {
      notify(error?.message || 'AWS Ubuntu 연결 프롬프트 생성 실패', 'error');
    }
  }, [copyChatCommand, folderPath, githubUrl, notify, projectName]);

  useEffect(() => () => {
    if (copyResetTimerRef.current != null) window.clearTimeout(copyResetTimerRef.current);
  }, []);

  useEffect(() => {
    setMemoryConflict(null);
    setPendingConflictResolution(null);
    setMergeDraft('');
  }, [folderPath]);

  const refresh = useCallback(async () => {
    const target = folderPath?.trim();
    if (!target || isDeployedWeb()) {
      setStatus(null);
      setRemoteState({ kind: 'not-required' });
      return;
    }
    setRemoteState({ kind: 'checking' });
    try {
      const next = await projectMemoryApi.detect(target);
      setStatus(next);
      if (next.config) {
        setAgent(next.config.agent);
        setAutoBackup(next.config.autoBackup);
      }
      try {
        const remoteStatus = await projectMemoryApi.remoteStatus({ folderPath: target, githubUrl });
        setRemoteState({
          kind: 'ready',
          status: {
            exists: remoteStatus.exists === true,
            createdAt: typeof remoteStatus.createdAt === 'string' ? remoteStatus.createdAt : null,
            contentHash: typeof remoteStatus.contentHash === 'string' ? remoteStatus.contentHash : null,
            inSync: remoteStatus.inSync === true,
          },
        });
      } catch (remoteError: any) {
        setRemoteState({ kind: 'error', message: remoteError?.message || String(remoteError) });
      }
      setError('');
      setErrorCode(null);
    } catch (e: any) {
      setStatus(null);
      setRemoteState({ kind: 'error', message: e?.message || String(e) });
      setError(e.message);
      setErrorCode(typeof e?.code === 'string' ? e.code : null);
    }
  }, [folderPath, githubUrl]);

  const refreshLocalActivity = useCallback(async () => {
    const target = folderPath?.trim();
    if (!target || isDeployedWeb() || activityPollBusyRef.current) return;
    activityPollBusyRef.current = true;
    try {
      const next = await projectMemoryApi.detect(target);
      setStatus(next);
      if (next.config) {
        setAgent(next.config.agent);
        setAutoBackup(next.config.autoBackup);
      }
      setError('');
      setErrorCode(null);
    } catch (e: any) {
      setError(e.message);
      setErrorCode(typeof e?.code === 'string' ? e.code : null);
    } finally {
      activityPollBusyRef.current = false;
    }
  }, [folderPath]);

  useEffect(() => {
    setRemoteState({ kind: 'checking' });
    const timer = setTimeout(() => { void refresh(); }, 300);
    return () => clearTimeout(timer);
  }, [refresh]);

  useEffect(() => {
    if (!folderPath?.trim() || isDeployedWeb()) return;
    const poll = () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      void refreshLocalActivity();
    };
    // 패널이 이미 열린 상태에서 외부 에디터/에이전트가 파일을 수정해도
    // 다음 30초 주기까지 기다리지 않고 이 effect 진입 시 즉시 판정한다.
    poll();
    const interval = setInterval(poll, 30_000);
    const onFocus = () => poll();
    const onVisibilityChange = () => {
      if (!document.hidden) poll();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      clearInterval(interval);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [folderPath, refreshLocalActivity]);

  useEffect(() => {
    const onAgentChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ folderPath?: string; agent?: ProjectMemoryAgent }>).detail;
      if (detail?.folderPath === folderPath?.trim() && (detail.agent === 'claude' || detail.agent === 'codex')) {
        setAgent(detail.agent);
      }
    };
    window.addEventListener('project-memory-agent-changed', onAgentChanged);
    return () => window.removeEventListener('project-memory-agent-changed', onAgentChanged);
  }, [folderPath]);

  const run = async (label: string, action: () => Promise<any>, success: (result: any) => string) => {
    if (busy) return;
    setBusy(label);
    setError('');
    try {
      const result = await action();
      const conflictSource = label === 'push'
        ? 'push'
        : label === 'pull' || label === 'sync'
          ? 'pull'
          : label === 'session-end'
            ? 'session'
            : 'resolve';
      const conflict = projectMemoryConflictFromResult(result, conflictSource);
      if (conflict) {
        // Do not auto-force a direction.  Both source versions stay available
        // in the panel until the user reviews and explicitly confirms one.
        setMemoryConflict(conflict);
        setPendingConflictResolution(null);
        setMergeDraft('');
        return result;
      }
      const backupFailure = projectMemoryBackupFailure(result);
      notify(backupFailure ?? success(result), backupFailure ? 'error' : 'success');
      if (!backupFailure) {
        setMemoryConflict(null);
        setPendingConflictResolution(null);
        setMergeDraft('');
      }
      await refresh();
      return result;
    } catch (e: any) {
      notify(e.message || String(e), 'error');
      return null;
    } finally {
      setBusy(null);
    }
  };

  const initialize = async (allowRemoteBranch = false) => {
    if (remoteState.kind === 'checking') {
      notify('Supabase 백업을 확인하는 중입니다. 확인이 끝난 뒤 진행해주세요.', 'error');
      return null;
    }
    if (remoteState.kind === 'error') {
      notify('Supabase 상태를 확인하지 못했습니다. 먼저 다시 확인해주세요.', 'error');
      return null;
    }
    if (remote?.exists) {
      if (!allowRemoteBranch) return null;
      const confirmed = window.confirm(
        'Supabase에 기존 장기기억 백업이 있습니다.\n새 로컬 기억을 만들면 기존 원격 기억과 별도 흐름으로 분기되어 나중에 충돌할 수 있습니다.\n\n원격 백업은 변경하거나 Push하지 않고 새 로컬 기억만 만들까요?',
      );
      if (!confirmed) return null;
    }
    const backupAfterInitialize = remote?.exists ? false : autoBackup;
    return run(
      'init',
      async () => {
        const initialized = await projectMemoryApi.initialize({
          folderPath: folderPath!,
          projectName,
          agent,
          autoBackup: backupAfterInitialize,
        });
        if (backupAfterInitialize) {
          try {
            const backup = await projectMemoryApi.push({ folderPath: folderPath!, projectName, githubUrl });
            const backupFailure = projectMemoryBackupFailure(backup);
            if (backupFailure) notify(`로컬 기억은 생성됐지만 ${backupFailure}`, 'error');
          } catch (e: any) {
            notify(`로컬 기억은 생성됐지만 Supabase 백업 실패: ${e.message}`, 'error');
          }
        }
        return initialized;
      },
      () => remote?.exists
        ? '새 로컬 기억을 만들었습니다. 기존 Supabase 백업은 변경하지 않았습니다.'
        : status?.exists ? '기존 장기기억을 연결했습니다.' : '프로젝트 장기기억을 만들었습니다.',
    );
  };

  /**
   * 다른 기기가 쓰던 기억에 합류한다.
   *
   * 순서가 중요하다 — init은 빈 템플릿을 만들 뿐이므로 **먼저 Pull**로 원격 내용을
   * 내려받아야 한다. 이 경로에서 push를 하지 않는 이유도 같다: 갓 만든 빈 문서를
   * 남의 기억 위로 올리는 실수를 아예 만들지 않는다.
   */
  const joinExistingMemory = async () => {
    const problem = joinMemoryIdProblem(joinMemoryIdInput);
    if (problem) { notify(problem, 'error'); return null; }
    if (!joinMemoryIdInput.trim()) {
      notify('합류할 장기기억 ID를 입력하세요.', 'error');
      return null;
    }
    return run(
      'join',
      async () => {
        const initialized = await projectMemoryApi.initialize({
          folderPath: folderPath!,
          projectName,
          agent,
          autoBackup,
          memoryId: joinMemoryIdInput,
        });
        const pulled = await projectMemoryApi.pull({ folderPath: folderPath!, projectName, githubUrl });
        setJoinMemoryIdInput('');
        return { ...initialized, ...pulled };
      },
      result => result?.alreadySynced
        ? '기존 기억에 합류했습니다. 원격과 동일한 내용입니다.'
        : '기존 기억에 합류하고 원격 내용을 내려받았습니다.',
    );
  };

  // 기기당 하나뿐이고 앱을 새로 깔 때만 바뀐다 — 폴링하지 않고 마운트마다 한 번만 읽는다.
  const [hermesAdapter, setHermesAdapter] = useState<HermesAdapterStatus | null>(null);
  useEffect(() => {
    if (isDeployedWeb()) return;
    let cancelled = false;
    projectMemoryApi.hermesAdapter()
      .then(status => { if (!cancelled) setHermesAdapter(status); })
      // Hermes가 없는 기기가 정상이다. 실패를 사용자에게 알리지 않는다.
      .catch(() => { if (!cancelled) setHermesAdapter(null); });
    return () => { cancelled = true; };
  }, []);

  const installHermesAdapter = async () => {
    if (busy) return;
    setBusy('hermes-adapter');
    try {
      const result = await projectMemoryApi.installHermesAdapter();
      setHermesAdapter(result);
      notify(
        `Hermes 명령 ${result.installed.length}개를 설치했습니다. Hermes를 다시 시작하면 나타납니다.`,
        'success',
      );
    } catch (e: any) {
      notify(e?.message || String(e), 'error');
    } finally {
      setBusy(null);
    }
  };

  const checkSupabase = async () => {
    const target = folderPath?.trim();
    if (!target || busy) return;
    setBusy('remote-status');
    setError('');
    setErrorCode(null);
    setRemoteState({ kind: 'checking' });
    try {
      const next = await projectMemoryApi.detect(target);
      setStatus(next);
      if (next.config) {
        setAgent(next.config.agent);
        setAutoBackup(next.config.autoBackup);
      }
      // 원격 조회 실패는 로컬 기억의 존재와 무관하다. 이 catch를 바깥과 합치면
      // Supabase가 안 될 때 setStatus(null)까지 실행되어, 멀쩡히 있는 장기기억이
      // 패널에서 사라지고 "새로 만들기" 화면이 뜬다 (refresh()는 이미 이렇게 분리돼 있다).
      try {
        const nextRemote = await projectMemoryApi.remoteStatus({ folderPath: target, githubUrl });
        setRemoteState({
          kind: 'ready',
          status: {
            exists: nextRemote.exists === true,
            createdAt: typeof nextRemote.createdAt === 'string' ? nextRemote.createdAt : null,
            contentHash: typeof nextRemote.contentHash === 'string' ? nextRemote.contentHash : null,
            inSync: nextRemote.inSync === true,
          },
        });
        notify(
          nextRemote.exists ? 'Supabase에서 기존 장기기억 백업을 찾았습니다.' : 'Supabase에 이 프로젝트의 장기기억 백업이 없습니다.',
          'success',
        );
      } catch (remoteError: any) {
        setRemoteState({ kind: 'error', message: remoteError?.message || String(remoteError) });
        notify(remoteError?.message || String(remoteError), 'error');
      }
    } catch (e: any) {
      setStatus(null);
      setRemoteState({ kind: 'error', message: e?.message || String(e) });
      setErrorCode(typeof e?.code === 'string' ? e.code : null);
      notify(e.message || String(e), 'error');
    } finally {
      setBusy(null);
    }
  };

  const pull = () => run(
    'pull',
    () => projectMemoryApi.pull({ folderPath: folderPath!, projectName, githubUrl }),
    result => result.alreadySynced ? '로컬과 Supabase 기억이 동일합니다.' : 'Supabase 장기기억을 로컬에 복원했습니다.',
  );

  const sync = () => run(
    'sync',
    () => projectMemoryApi.sync({ folderPath: folderPath!, projectName, githubUrl }),
    result => result.action === 'push'
      ? '로컬 장기기억을 Supabase에 동기화했습니다.'
      : result.action === 'pull'
        ? 'Supabase 장기기억을 로컬에 동기화했습니다.'
        : '로컬과 Supabase 장기기억이 이미 동일합니다.',
  );

  const update = () => run(
    'update',
    () => projectMemoryApi.update({ folderPath: folderPath!, projectName, agent }),
    () => '로컬 장기기억을 업데이트했습니다.',
  );

  const upgradeMemoryAgent = () => run(
    'upgrade-agent',
    () => projectMemoryApi.upgradeAgent({ folderPath: folderPath! }),
    result => result.entryIdsStabilized
      ? `장기기억 에이전트를 v${result.memoryAgent.currentVersion}로 업데이트하고 항목 ID를 안정화했습니다. 로컬 기억이 변경되어 Supabase Push가 필요합니다.`
      : `장기기억 에이전트를 v${result.memoryAgent.currentVersion}로 업데이트했습니다.`,
  );

  const changePreferredAgent = async (nextAgent: ProjectMemoryAgent) => {
    setAgent(nextAgent);
    try {
      const result = await projectMemoryApi.setPreferredAgent({ folderPath: folderPath!, agent: nextAgent });
      if (result.tracked) {
        window.dispatchEvent(new CustomEvent('project-memory-agent-changed', {
          detail: { folderPath: folderPath!.trim(), agent: result.agent },
        }));
      }
    } catch (e: any) {
      notify(e.message || String(e), 'error');
      await refresh();
    }
  };

  const sessionEnd = () => run(
    'session-end',
    () => projectMemoryApi.sessionEnd({ folderPath: folderPath!, projectName, githubUrl, agent, autoBackup }),
    result => result.remoteBackedUp
      ? '세션 기억 완료: 로컬 기억 갱신 및 Supabase 백업 완료'
      : result.backupSkipped
        ? '세션 기억 완료: 로컬 기억 갱신 완료'
        : `로컬 기억은 저장됐지만 원격 백업 실패: ${result.backupError || '재시도 필요'}`,
  );

  const resolveMemoryConflict = (strategy: ProjectMemoryConflictResolution) => {
    const conflict = memoryConflict;
    if (!conflict?.localContentHash || !conflict.remoteRevisionId) {
      notify('충돌 비교 정보가 부족합니다. “다시 비교”로 최신 상태를 불러오세요.', 'error');
      return Promise.resolve(null);
    }
    if (strategy === 'merged' && !mergeDraft.trim()) {
      notify('병합할 장기기억 본문을 붙여넣거나 작성해주세요.', 'error');
      return Promise.resolve(null);
    }
    return run(
      'resolve-conflict',
      () => projectMemoryApi.resolveConflict({
        folderPath: folderPath!,
        projectName,
        githubUrl,
        strategy,
        expectedLocalHash: conflict.localContentHash!,
        expectedRemoteRevisionId: conflict.remoteRevisionId!,
        expectedRemoteContentHash: conflict.remoteContentHash,
        ...(strategy === 'merged' ? { mergedContent: mergeDraft } : {}),
      }),
      result => strategy === 'keep-local'
        ? `로컬 기억을 새 Supabase 리비전으로 저장했습니다. 이전 원격 리비전 ${result.preservedRemoteRevisionId || ''}은 이력에 보존됩니다.`
        : strategy === 'merged'
          ? `검토한 병합본을 새 Supabase 리비전으로 저장했습니다. 기존 로컬 기억은 ${result.backupPath || '.agent-memory/backups'}에 보존되며, 이전 원격 리비전도 이력에 남습니다.`
          : `Supabase 기억으로 복원했습니다. 기존 로컬 기억은 ${result.backupPath || '.agent-memory/backups'}에 보존되었습니다.`,
    );
  };

  const toggleHistory = async () => {
    if (showHistory) {
      setShowHistory(false);
      return;
    }
    setBusy('history');
    try {
      const result = await projectMemoryApi.history({ folderPath: folderPath!, githubUrl });
      setRevisions(result.revisions);
      setShowHistory(true);
    } catch (e: any) {
      notify(e.message || String(e), 'error');
    } finally {
      setBusy(null);
    }
  };

  const restoreRevision = async (revision: MemoryResult) => {
    const when = revision.created_at ? new Date(revision.created_at).toLocaleString() : '선택한 시점';
    if (!window.confirm(`${when} 장기기억으로 복원할까요?\n현재 로컬 기억은 backups 폴더에 보존됩니다.`)) return;
    await run(
      'restore',
      () => projectMemoryApi.restoreRevision({
        folderPath: folderPath!,
        projectName,
        revisionId: revision.id,
      }),
      () => '선택한 장기기억 리비전으로 복원했습니다.',
    );
    setShowHistory(false);
  };

  if (isDeployedWeb()) {
    return compact ? null : (
      <div className="rounded-lg border border-stone-800 bg-stone-950/40 p-3 text-xs text-zinc-500">
        장기기억 파일 관리는 데스크톱 앱에서 사용할 수 있습니다.
      </div>
    );
  }
  if (!folderPath?.trim()) {
    return compact ? null : (
      <div className="rounded-lg border border-stone-800 bg-stone-950/40 p-3 text-xs text-zinc-500">
        프로젝트 폴더를 지정하면 기존 장기기억을 자동 감지합니다.
      </div>
    );
  }

  const buttonClass = 'px-2.5 py-1.5 rounded-md border border-stone-700 bg-stone-900 hover:bg-stone-800 text-[11px] text-zinc-300 disabled:opacity-40 disabled:cursor-not-allowed transition-colors';
  const primaryButtonClass = 'px-3 py-2 rounded-md border border-teal-400/40 bg-teal-500/15 hover:bg-teal-500/25 text-[11px] font-semibold text-teal-100 disabled:opacity-40 disabled:cursor-wait transition-colors';
  const busyLabel = busy === 'session-end'
    ? '세션 기억 중…'
    : busy === 'upgrade-agent'
      ? '에이전트 업데이트 중…'
      : busy
        ? '처리 중…'
        : null;
  const localUpdatedAt = status?.modifiedAt || status?.config?.lastUpdatedAt || null;
  const supabaseUpdatedAt = remote
    ? remote.createdAt || null
    : status?.config?.lastBackedUpAt || null;
  const syncDirection = resolveProjectMemorySyncDirection({
    localExists: status?.exists === true,
    localUpdatedAt,
    localContentHash: status?.contentHash ?? null,
    lastSyncedHash: status?.config?.lastSyncedHash ?? null,
    autoBackup,
    remote: remoteState,
  });
  const sessionNeedsRemember = status?.activity?.needsRemember === true;
  const missingProjectRoot = errorCode === 'PROJECT_ROOT_MISSING';
  const syncStatusLabel = status?.exists
    ? syncDirection === 'synced'
      ? '로컬 · Supabase 동기화됨'
      : syncDirection === 'not-required'
        ? '로컬 기억만 사용'
        : syncDirection === 'checking'
          ? 'Supabase 확인 중'
          : syncDirection === 'push'
            ? 'Supabase 백업 필요'
            : syncDirection === 'pull'
              ? '원격 변경 확인 필요'
              : syncDirection === 'conflict'
                ? '동기화 방향 확인 필요'
                : syncDirection === 'error'
                  ? 'Supabase 확인 실패'
                  : '로컬 기억 감지됨'
    : missingProjectRoot
      ? '프로젝트 폴더 없음'
      : remote?.exists
      ? 'Supabase 백업 발견'
      : '사용 안 함';
  const panelStatusLabel = memoryConflict
    ? '장기기억 충돌 검토'
    : sessionNeedsRemember ? '세션 기억 필요' : syncStatusLabel;
  const sessionActivityReason = status?.activity?.reasons?.includes('session-activity');
  const projectActivityReason = status?.activity?.reasons?.includes('project-changes');
  const conflictHasVersionGuards = !!memoryConflict?.localContentHash && !!memoryConflict?.remoteRevisionId;
  // A running Tauri sidecar may predate the UI bundle (the app deliberately
  // adopts an already-listening local API). Never let that stale response make
  // the UI claim that the current feature version is older than the bundle.
  const memoryAgentInstalledVersion = status?.memoryAgent?.installedVersion ?? 0;
  const memoryAgentCurrentVersion = Math.max(
    CURRENT_PROJECT_MEMORY_VERSION,
    status?.memoryAgent?.currentVersion ?? 0,
  );
  const memoryAgentUpdateAvailable = memoryAgentInstalledVersion < memoryAgentCurrentVersion
    || status?.memoryAgent?.updateAvailable === true;
  // Hermes 명령이 갈리는 축은 호스트(로컬/AWS)가 아니라 **인자 유무**다. 인자가 있으면
  // resolve-project로 그 프로젝트만 일회성 저장하고, 없으면 현재 topic 바인딩을 따른다.
  // 인자는 그 명령을 받는 Hermes가 도는 호스트의 경로여야 한다 — 이 앱이 아니라.
  const hermesRememberSessionPathCommand = folderPath?.trim()
    ? `/remember_session ${folderPath.trim()}`
    : projectName?.trim()
      ? `/remember_session ${projectName.trim()}`
      : '/remember_session';
  const hermesMemoryLinkCommand = status?.config?.memoryId
    ? `/memory_link ${status.config.memoryId}`
    : '/memory_link <memoryId>';
  const hermesOpenCommand = status?.config?.memoryId
    ? `/hermes_open ${status.config.memoryId}`
    : '/hermes_open <memoryId>';
  // 이 표는 설치되는 스킬(templates/hermes/*)과 1:1이어야 한다. 예전에는 다섯 개만
  // 버튼이었고 `/memory_start`·`/memory_stop`은 각주 한 줄, `/hermes_open`은 아예 없었는데,
  // 정작 Hermes는 그 스킬들을 전부 로드한다. 그래서 Telegram 메뉴에 뜨는 목록과 이 패널이
  // 어긋났고, 사용자는 "앱이 모르는 명령"을 본 셈이 됐다. 새 스킬 템플릿을 추가하면
  // 반드시 여기에도 함께 추가할 것 — 목록의 정본은 `templates/hermes/` 폴더다.
  //
  // ⚠️ 순서는 **사용 빈도가 아니라 실행 순서**다. 이 명령들은 topic 바인딩을 전제로
  // 하므로, 바인딩 전에는 `/remember_session`을 포함한 나머지가 전부 "연결되지 않음"으로
  // 거절된다. 빈도순으로 `/remember_session`을 맨 위에 뒀더니 새 topic에서 가장 먼저
  // 보이는 명령이 곧 가장 먼저 실패하는 명령이 됐다. 연결 → 사용 → 해제 순으로 둔다.
  //
  // `aliasOf`가 붙은 항목은 자기 버튼을 갖지 않고 대상 행의 꼬리말이 된다. 같은 일을
  // 하는 버튼을 둘 두면 "무엇이 다른가"를 사용자가 계속 되묻게 된다 — 그러면서도
  // 표에는 남겨야 한다. Hermes가 그 스킬을 실제로 로드하므로 목록에서 사라지면
  // Telegram 메뉴에는 있는데 앱에는 없는, 처음 고쳤던 그 어긋남으로 되돌아간다.
  const hermesTopicCommands: Array<{ testId: string; skill: string; label: string; command: string; desc: string; step: string; aliasOf?: string; desktopOnly?: boolean }> = [
    {
      testId: 'copy-hermes-memory-start', skill: 'memory-start', step: '연결',
      label: '/memory_start [이름]', command: '/memory_start',
      desc: '새 독립 기억을 만들어 이 topic에 바인딩합니다. 이 topic에서 처음 쓰는 명령입니다.',
    },
    {
      testId: 'copy-hermes-memory-link', skill: 'memory-link', step: '연결',
      label: '/memory_link <memoryId>', command: hermesMemoryLinkCommand,
      desc: '새로 만드는 대신 이미 등록된 기억에 연결합니다. 복사하면 이 프로젝트의 memoryId가 함께 붙습니다.',
    },
    {
      testId: 'copy-hermes-remember-session', skill: 'remember-session', step: '사용',
      label: '/remember_session', command: '/remember_session',
      desc: '이 topic의 대화를 바인딩된 프로젝트 기억에 저장합니다.',
    },
    {
      testId: 'copy-hermes-memory-sync', skill: 'memory-sync', step: '사용',
      label: '/memory_sync', command: '/memory_sync',
      desc: '이미 저장된 기억을 원격과 대조·정합합니다. 대화를 저장하지는 않습니다.',
    },
    {
      testId: 'copy-hermes-memory-status', skill: 'memory-status', step: '사용',
      label: '/memory_status', command: '/memory_status',
      desc: '이 topic이 어느 기억에 묶여 있는지 확인합니다.',
    },
    {
      testId: 'copy-hermes-open', skill: 'hermes-open', step: '사용', desktopOnly: true,
      label: '/hermes_open <memoryId>', command: hermesOpenCommand,
      desc: '바인딩된 프로젝트 폴더를 그 호스트의 Hermes Desktop에서 엽니다.',
    },
    {
      testId: 'copy-hermes-memory-unlink', skill: 'memory-unlink', step: '해제',
      label: '/memory_unlink', command: '/memory_unlink',
      desc: '이 topic의 바인딩을 해제합니다. 기억 자체는 지우지 않습니다.',
    },
    {
      testId: 'copy-hermes-memory-stop', skill: 'memory-stop', step: '해제', aliasOf: 'memory-unlink',
      label: '/memory_stop', command: '/memory_stop',
      desc: '호환 별칭 — 같은 동작입니다.',
    },
  ];
  const hermesCommandRows = hermesTopicCommands.filter(item => !item.aliasOf);
  const hermesStepNote: Record<string, string> = {
    '연결': '먼저 한 번 — 둘 중 하나만 (이게 되어 있어야 나머지가 동작합니다)',
    '사용': '연결된 뒤에',
    '해제': '더 이상 이 topic에서 쓰지 않을 때',
  };
  // 「이 PC 미설치」 표시는 설치 상태를 실제로 읽을 수 있을 때만 낸다. AWS에만 Hermes가
  // 있는 사용자에게 전 목록을 "미설치"로 칠하면, 정작 잘 도는 명령을 못 쓰는 것으로 읽는다.
  // 원격 호스트의 설치 상태는 이 앱이 읽을 수 없다. 그 상태를 로컬 판정으로 칠하면
  // 잘 도는 원격 명령이 "이 PC에 없음"으로 보여 못 쓰는 것으로 읽힌다.
  const hermesInstalledSkills = new Set(hermesAdapter?.installed ?? []);
  const hermesTracksInstalls = hermesHost === 'local'
    && hermesAdapter?.hermesPresent === true
    && (hermesAdapter?.available?.length ?? 0) > 0;
  const hermesHostNotes = hermesCommandHostNotes(hermesHost);
  // 설치는 프로젝트별이 아니라 기기당 하나다 — 이 값은 선택 프로젝트와 무관하다.
  const hermesInstallPending = hermesAdapter ? hermesPendingWork(hermesAdapter) : null;
  // 이 프로젝트 기억의 Supabase 계보 식별자. 이름·경로는 바뀌어도 이 값은 고정이라
  // 다른 기기·다른 대화(`/memory_link`)에서 "어느 기억인지"를 가리킬 때 붙여넣는다.
  const memoryId = status?.config?.memoryId?.trim() || '';

  // 저장소를 공유하지 않는 프로젝트(예: 내용은 Obsidian이 동기화하고 GitHub에는 구조만
  // 올려두는 볼트)는 저장소 키로 서로를 찾을 수 없다. 한쪽 기기에는 clone이 아예 없기도
  // 하다. 그때 다른 기기의 ID를 직접 건네는 것이 두 기억을 하나로 잇는 유일한 방법이다.
  const joinMemoryProblem = joinMemoryIdProblem(joinMemoryIdInput);
  const joinMemorySection = (
    <details data-testid="project-memory-join" className="rounded-md border border-stone-800 bg-stone-950/30 px-2.5 py-2">
      <summary className="cursor-pointer text-[11px] text-zinc-400">
        다른 기기에서 쓰던 기억에 합류
      </summary>
      <p className="m-0 mt-2 text-[10.5px] leading-relaxed text-zinc-500">
        소스를 공유하지 않아도 됩니다. 기억이 이미 있는 기기의 「프로젝트 장기기억」 옆
        ID 배지를 클릭해 전체 값을 복사한 뒤 여기에 붙여넣으세요. 새로 만들지 않고 그
        기억을 그대로 내려받아 이어서 씁니다.
      </p>
      <input
        data-testid="project-memory-join-id"
        value={joinMemoryIdInput}
        onChange={e => setJoinMemoryIdInput(e.target.value)}
        placeholder="884575df-63c4-407c-8b43-860d1295e663"
        spellCheck={false}
        className="mt-2 w-full rounded border border-stone-700 bg-stone-900 px-2 py-1 text-[10.5px] text-zinc-200 placeholder:text-zinc-600"
        style={{ fontFamily: "'JetBrains Mono', ui-monospace, monospace" }}
      />
      {joinMemoryProblem && (
        <p data-testid="project-memory-join-problem" className="m-0 mt-1 text-[10px] text-amber-300/90">
          {joinMemoryProblem}
        </p>
      )}
      <button
        data-testid="project-memory-join-submit"
        className={`${buttonClass} mt-2`}
        disabled={!!busy || !joinMemoryIdInput.trim() || !!joinMemoryProblem}
        onClick={() => void joinExistingMemory()}
      >
        <CloudDownload style={{ width: 11, height: 11, display: 'inline', marginRight: 4 }} />
        {busy === 'join' ? '합류하는 중…' : '이 기억에 합류'}
      </button>
    </details>
  );

  return (
    <section
      style={{
        border: '1px solid rgba(94,234,212,0.16)',
        background: 'rgba(10,10,11,0.65)',
        borderRadius: 8,
        padding: compact ? 10 : 12,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: compact ? 7 : 10 }}>
        <Brain style={{ width: 14, height: 14, color: '#5eead4' }} />
        <span style={{ fontSize: 12, fontWeight: 600, color: '#d4d4d8' }}>프로젝트 장기기억</span>
        <span
          data-testid="project-memory-feature-version"
          title={
            memoryAgentUpdateAvailable
              ? `이 폴더에 설치된 버전 v${memoryAgentInstalledVersion} · 현재 v${memoryAgentCurrentVersion}. 아래 업데이트 버튼으로 올릴 수 있습니다.`
              : `프로젝트 장기기억 기능 버전. 앱이 설치하는 스킬·훅과 "앱 없는 PC용" 복사 프롬프트가 이 번호를 함께 씁니다.`
          }
          style={{
            fontSize: 9.5,
            color: memoryAgentUpdateAvailable ? '#fbbf24' : '#71717a',
            border: '1px solid rgba(161,161,170,0.2)',
            borderRadius: 4,
            padding: '0 4px',
            cursor: 'help',
          }}
        >
          {memoryAgentUpdateAvailable
            ? `v${memoryAgentInstalledVersion} → v${memoryAgentCurrentVersion}`
            : `v${memoryAgentCurrentVersion}`}
        </span>
        {memoryId ? (
          <button
            type="button"
            data-testid="project-memory-id-copy"
            data-memory-id={memoryId}
            onClick={() => void copyChatCommand('memory-id', memoryId, '장기기억 ID')}
            title={[
              `장기기억 ID (memoryId): ${memoryId}`,
              '클릭하면 전체 값이 클립보드에 복사됩니다.',
              'Supabase 백업에서 이 프로젝트의 기억을 가리키는 고정 식별자입니다.',
              '다른 기기의 합류 입력칸이나 Hermes `/memory_link` 에 그대로 붙여넣습니다.',
            ].join('\n')}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 3,
              fontSize: 9.5,
              lineHeight: 1.6,
              fontFamily: "'JetBrains Mono', ui-monospace, monospace",
              color: copiedChatCommand === 'memory-id' ? '#5eead4' : '#71717a',
              border: '1px solid rgba(161,161,170,0.2)',
              borderRadius: 4,
              padding: '0 4px',
              background: 'transparent',
              cursor: 'pointer',
            }}
          >
            {copiedChatCommand === 'memory-id'
              ? <Check style={{ width: 9, height: 9 }} />
              : <Copy style={{ width: 9, height: 9 }} />}
            {memoryId.slice(0, 8)}
          </button>
        ) : null}
        <span
          data-testid="project-memory-init-info"
          title={[
            '이 폴더에 생성/관리되는 항목:',
            '· .agent-memory/CORE.md — 누적되는 장기기억 본문',
            '· .agent-memory/config.json — 동기화 상태·선호 AI 설정',
            '· .agent-memory/activity.json, activity-hook.sh — 세션 기억 필요 여부 자동 감지',
            '· .claude/skills, .codex 대응 스킬 — 채팅에서 /remember-session 등으로 실행 가능하게 연결',
            '· CLAUDE.md, AGENTS.md — 위 스킬을 안내하는 짧은 블록 추가(기존 내용은 보존)',
            '기억 내용은 자동 백업이 켜져 있으면 Supabase에도 저장됩니다.',
          ].join('\n')}
          style={{ display: 'inline-flex', color: '#71717a', cursor: 'help' }}
        >
          <Info style={{ width: 12, height: 12 }} />
        </span>
        <span
          data-testid="project-memory-sync-status"
          style={{
            marginLeft: 'auto',
            fontSize: 10,
            color: missingProjectRoot
              ? '#fca5a5'
              : memoryConflict
                ? '#fca5a5'
                : sessionNeedsRemember
                ? '#fbbf24'
              : syncDirection === 'push'
              ? '#fbbf24'
              : syncDirection === 'pull'
                ? '#93c5fd'
                : syncDirection === 'conflict'
                  ? '#fca5a5'
                  : status?.exists
                    ? '#4ade80'
                    : '#71717a',
          }}
        >
          {panelStatusLabel}
        </span>
      </div>

      {missingProjectRoot ? (
        <div
          data-testid="project-memory-missing-root"
          style={{
            padding: '9px 10px', borderRadius: 6,
            border: '1px solid rgba(248,113,113,0.24)',
            background: 'rgba(127,29,29,0.12)', color: '#fca5a5',
            fontSize: 10.5, lineHeight: 1.55,
          }}
        >
          <strong style={{ display: 'block', color: '#fecaca', marginBottom: 2 }}>저장된 프로젝트 폴더를 찾을 수 없습니다.</strong>
          프로젝트의 <b>수정</b> 버튼에서 현재 실제 폴더 경로를 다시 지정하면 워크트리와 장기기억 기능이 함께 복구됩니다.
          <div style={{ marginTop: 4, color: '#a1a1aa', overflowWrap: 'anywhere' }}>{folderPath}</div>
        </div>
      ) : !status?.exists ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {remoteState.kind === 'checking' ? (
            <p className="m-0 text-[11px] leading-relaxed text-zinc-400">
              Supabase에서 이 프로젝트의 기존 장기기억 백업을 확인하는 중입니다.
            </p>
          ) : remoteState.kind === 'error' ? (
            <>
              <p className="m-0 text-[11px] leading-relaxed text-amber-200/90">
                Supabase 백업을 확인하지 못했습니다. 새 로컬 기억을 만들기 전에 다시 확인해주세요.
              </p>
              <button
                data-testid="project-memory-check-remote"
                className={primaryButtonClass}
                disabled={!!busy}
                onClick={() => void checkSupabase()}
              >
                <RefreshCw style={{ width: 11, height: 11, display: 'inline', marginRight: 4 }} />
                Supabase 다시 확인
              </button>
            </>
          ) : remoteState.kind === 'ready' && remote?.exists ? (
            <>
              <div className="rounded-md border border-teal-400/20 bg-teal-500/10 px-2.5 py-2 text-[11px] leading-relaxed text-teal-100">
                기존 장기기억 백업을 찾았습니다. 새 PC에서는 이 백업을 먼저 복원하세요.
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <button
                  data-testid="project-memory-restore-primary"
                  className={primaryButtonClass}
                  disabled={!!busy}
                  onClick={() => void pull()}
                >
                  <CloudDownload style={{ width: 11, height: 11, display: 'inline', marginRight: 4 }} />
                  Supabase에서 기존 기억 복원
                </button>
                <button className={buttonClass} disabled={!!busy} onClick={() => void checkSupabase()}>
                  <RefreshCw style={{ width: 11, height: 11, display: 'inline', marginRight: 4 }} />
                  Supabase에서 확인
                </button>
              </div>
              <details data-testid="project-memory-advanced-local-create" className="rounded-md border border-stone-800 bg-stone-950/30 px-2.5 py-2">
                <summary className="cursor-pointer text-[10px] text-zinc-500 hover:text-zinc-300">
                  고급: 기존 백업을 사용하지 않고 새 로컬 기억 만들기
                </summary>
                <div className="mt-2 flex flex-col gap-2">
                  <p className="m-0 text-[10px] leading-relaxed text-amber-300/90">
                    새 기억은 기존 Supabase 기억과 분기되어 나중에 충돌할 수 있습니다. 이 작업에서는 원격 백업이나 Git 원격을 변경하지 않습니다.
                  </p>
                  <label className="flex items-center gap-2 text-[10px] text-zinc-500">
                    <span>세션 기억 실행 AI</span>
                    <select
                      value={agent}
                      aria-label="장기기억 최초 실행 AI"
                      onChange={e => setAgent(e.target.value as ProjectMemoryAgent)}
                      className="px-2 py-1 rounded border border-stone-700 bg-stone-900 text-[10px] text-zinc-300"
                    >
                      <option value="claude">Claude</option>
                      <option value="codex">Codex</option>
                    </select>
                  </label>
                  <button className={buttonClass} disabled={!!busy} onClick={() => void initialize(true)}>
                    새 로컬 기억만 만들기
                  </button>
                </div>
              </details>
              {/* 이 저장소의 백업을 찾았더라도, 사용자가 이으려는 기억이 그것이 아닐 수
                  있다(저장소를 공유하지 않는 기기끼리 손으로 잇는 경우). 복원 옆에 함께 둔다. */}
              {joinMemorySection}
            </>
          ) : remoteState.kind === 'ready' ? (
            <>
              <div className="rounded-md border border-stone-800 bg-stone-950/40 px-2.5 py-2 text-[11px] leading-relaxed text-zinc-400">
                Supabase에서 기존 백업을 찾지 못했습니다. 이 PC에서 새 로컬 기억을 시작할 수 있습니다.
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <label className="flex flex-1 items-center gap-2 text-[11px] text-zinc-500">
                  <span>세션 기억 실행 AI</span>
                  <select
                    value={agent}
                    aria-label="장기기억 최초 실행 AI"
                    onChange={e => setAgent(e.target.value as ProjectMemoryAgent)}
                    className="px-2 py-1 rounded border border-stone-700 bg-stone-900 text-[10px] text-zinc-300"
                  >
                    <option value="claude">Claude</option>
                    <option value="codex">Codex</option>
                  </select>
                </label>
                {!compact && (
                  <label className="flex items-center gap-1.5 text-[11px] text-zinc-400">
                    <input type="checkbox" checked={autoBackup} onChange={e => setAutoBackup(e.target.checked)} className="accent-teal-400" />
                    생성 후 백업
                  </label>
                )}
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <button
                  data-testid="project-memory-create-primary"
                  className={primaryButtonClass}
                  disabled={!!busy}
                  onClick={() => void initialize()}
                >
                  로컬 기억 만들기
                </button>
                <button className={buttonClass} disabled={!!busy} onClick={() => void checkSupabase()}>
                  <RefreshCw style={{ width: 11, height: 11, display: 'inline', marginRight: 4 }} />
                  Supabase에서 확인
                </button>
              </div>
              {joinMemorySection}
              <button
                type="button"
                data-testid="copy-manual-init-prompt"
                onClick={() => void copyChatCommand('manual-init', manualInitPrompt, '다른 폴더용 장기기억 설정 프롬프트')}
                title="이 앱을 거치지 않고, 다른 프로젝트 폴더의 Claude/Codex 채팅에 붙여넣어 장기기억을 수동으로 설정할 프롬프트를 복사합니다. (로컬 API 서버가 실행 중이어야 합니다.)"
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 6px',
                  borderRadius: 4, border: '1px solid rgba(161,161,170,0.18)',
                  background: 'rgba(161,161,170,0.045)', color: '#a1a1aa',
                  cursor: 'pointer', fontSize: 10, fontFamily: 'inherit',
                }}
              >
                <span>다른 폴더에서 수동 실행 프롬프트</span>
                {copiedChatCommand === 'manual-init' ? <Check style={{ width: 9, height: 9 }} /> : <Copy style={{ width: 9, height: 9 }} />}
              </button>
              <button
                type="button"
                data-testid="copy-standalone-init-prompt"
                onClick={() => void copyChatCommand('standalone-init', standaloneInitPrompt, '앱 없는 PC용 장기기억 설정 프롬프트')}
                title="이 앱이 설치되지 않은 PC에서, 로컬 API 서버 없이 파일만으로 같은 장기기억 구조를 만들게 하는 프롬프트를 복사합니다."
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 6px',
                  borderRadius: 4, border: '1px solid rgba(161,161,170,0.18)',
                  background: 'rgba(161,161,170,0.045)', color: '#a1a1aa',
                  cursor: 'pointer', fontSize: 10, fontFamily: 'inherit',
                }}
              >
                <span>{`앱 없는 PC용 프롬프트 v${STANDALONE_MEMORY_PROMPT_VERSION}`}</span>
                {copiedChatCommand === 'standalone-init' ? <Check style={{ width: 9, height: 9 }} /> : <Copy style={{ width: 9, height: 9 }} />}
              </button>
              <button
                type="button"
                data-testid="copy-aws-ubuntu-memory-setup"
                onClick={() => void copyAwsUbuntuSetupPrompt()}
                title="AWS Ubuntu 연결에 필요한 설정 프롬프트를 복사합니다. Supabase 프로젝트 전체 권한의 service-role key는 포함되지 않으며 Ubuntu에서 직접 입력해야 합니다."
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 6px',
                  borderRadius: 4, border: '1px solid rgba(125,211,252,0.22)',
                  background: 'rgba(14,116,144,0.08)', color: '#7dd3fc',
                  cursor: 'pointer', fontSize: 10, fontFamily: 'inherit',
                }}
              >
                <span>AWS Ubuntu 설정 프롬프트</span>
                {copiedChatCommand === 'aws-ubuntu' ? <Check style={{ width: 9, height: 9 }} /> : <Copy style={{ width: 9, height: 9 }} />}
              </button>
            </>
          ) : (
            <button
              data-testid="project-memory-check-remote"
              className={primaryButtonClass}
              disabled={!!busy}
              onClick={() => void checkSupabase()}
            >
              <RefreshCw style={{ width: 11, height: 11, display: 'inline', marginRight: 4 }} />
              Supabase에서 확인
            </button>
          )}
        </div>
      ) : (
        <>
          {memoryAgentUpdateAvailable && (
            <button
              data-testid="project-memory-agent-update"
              disabled={!!busy}
              onClick={() => void upgradeMemoryAgent()}
              title="기억 내용과 Supabase 연결 정보는 유지하고 Claude/Codex용 세션 기억 스킬과 연결 지침만 최신 버전으로 교체합니다."
              style={{
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 8,
                marginBottom: 8,
                padding: '7px 9px',
                borderRadius: 6,
                border: '1px solid rgba(251,191,36,0.5)',
                background: 'rgba(120,53,15,0.2)',
                color: '#fde68a',
                fontSize: 10.5,
                cursor: busy ? 'wait' : 'pointer',
                opacity: busy ? 0.5 : 1,
              }}
            >
              <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontWeight: 600 }}>
                <RefreshCw style={{ width: 11, height: 11 }} />
                장기기억 에이전트 업데이트
              </span>
              <span style={{ color: '#d6a85f', fontVariantNumeric: 'tabular-nums' }}>
                v{memoryAgentInstalledVersion} → v{memoryAgentCurrentVersion}
              </span>
            </button>
          )}
          <div
            data-testid="project-memory-timestamps"
            style={{
              display: 'grid',
              gridTemplateColumns: compact ? '1fr' : 'repeat(2, minmax(0, 1fr))',
              gap: compact ? 4 : 7,
              marginBottom: 8,
            }}
          >
            <div style={{ padding: '6px 8px', borderRadius: 6, background: 'rgba(94,234,212,0.055)' }}>
              <div style={{ marginBottom: 2, fontSize: 9.5, color: '#71717a' }}>로컬 기억 업데이트</div>
              <time
                data-testid="project-memory-local-updated"
                dateTime={localUpdatedAt || undefined}
                style={{ display: 'block', fontSize: 10.5, color: '#99f6e4', fontVariantNumeric: 'tabular-nums' }}
              >
                {formatDateTimeSeconds(localUpdatedAt)}
              </time>
            </div>
            <div style={{ padding: '6px 8px', borderRadius: 6, background: 'rgba(96,165,250,0.055)' }}>
              <div style={{ marginBottom: 2, fontSize: 9.5, color: '#71717a' }}>Supabase 백업</div>
              <time
                data-testid="project-memory-supabase-updated"
                dateTime={supabaseUpdatedAt || undefined}
                style={{ display: 'block', fontSize: 10.5, color: supabaseUpdatedAt ? '#93c5fd' : '#52525b', fontVariantNumeric: 'tabular-nums' }}
              >
                {formatDateTimeSeconds(supabaseUpdatedAt)}
              </time>
            </div>
          </div>
          {memoryConflict && (
            <div
              data-testid="project-memory-conflict-resolver"
              style={{
                marginBottom: 8,
                padding: compact ? 8 : 10,
                borderRadius: 7,
                border: '1px solid rgba(248,113,113,0.45)',
                background: 'rgba(127,29,29,0.14)',
                color: '#fecaca',
              }}
            >
              <strong style={{ display: 'block', marginBottom: 4, fontSize: 11 }}>
                장기기억 충돌 — 아직 자동으로 덮어쓰지 않았습니다
              </strong>
              <p style={{ margin: '0 0 7px', fontSize: 10.5, lineHeight: 1.5, color: '#fecaca' }}>
                {projectMemoryConflictSummary(memoryConflict)} 해결한 뒤에는 세션 기억을 자동 재실행하지 않으므로,
                필요한 경우 사용자가 다시 실행합니다.
              </p>
              <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', marginBottom: 7, fontSize: 9.5, color: '#fda4af' }}>
                <span>로컬 {shortHash(memoryConflict.localContentHash)}</span>
                <span>·</span>
                <span>원격 {shortHash(memoryConflict.remoteContentHash)}</span>
                <span>·</span>
                <span title={memoryConflict.remoteRevisionId || undefined}>원격 리비전 {memoryConflict.remoteRevisionId?.slice(0, 8) || '—'}</span>
                {memoryConflict.remoteCreatedAt && <span>· {formatDateTimeSeconds(memoryConflict.remoteCreatedAt)}</span>}
                {memoryConflict.remoteDeviceName && <span>· {memoryConflict.remoteDeviceName}</span>}
              </div>
              <div style={{
                display: 'grid', gridTemplateColumns: compact ? '1fr' : 'repeat(2, minmax(0, 1fr))',
                gap: 6, marginBottom: 7,
              }}>
                {[
                  { label: '로컬 장기기억', content: memoryConflict.localContent, color: '#99f6e4' },
                  { label: 'Supabase 장기기억', content: memoryConflict.remoteContent, color: '#bfdbfe' },
                ].map(version => (
                  <div key={version.label} style={{ minWidth: 0, borderRadius: 5, background: 'rgba(9,9,11,0.52)', padding: 6 }}>
                    <div style={{ marginBottom: 4, fontSize: 9.5, color: version.color, fontWeight: 600 }}>{version.label}</div>
                    <pre style={{
                      margin: 0, maxHeight: compact ? 96 : 150, overflow: 'auto', whiteSpace: 'pre-wrap',
                      fontSize: 9.5, lineHeight: 1.45, color: '#d4d4d8', fontFamily: "'JetBrains Mono', ui-monospace, monospace",
                    }}>
                      {projectMemoryContentPreview(version.content)}
                    </pre>
                  </div>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                <button
                  type="button"
                  className={buttonClass}
                  disabled={!!busy}
                  onClick={() => {
                    if (!window.confirm('로컬·Supabase 장기기억 전문이 클립보드에 복사됩니다. 외부 AI 채팅에 붙여넣으면 프로젝트 정보가 외부 서비스로 전송될 수 있습니다. 계속할까요?')) return;
                    void copyChatCommand(
                      'memory-conflict-merge',
                      projectMemoryConflictMergePrompt(memoryConflict),
                      'AI 병합용 장기기억 전문',
                    );
                  }}
                  title="로컬·원격 장기기억 전문을 복사합니다. 외부 AI 채팅에 붙여넣기 전에 민감정보와 반출 정책을 확인하세요."
                >
                  <Copy style={{ width: 10, height: 10, display: 'inline', marginRight: 4 }} />
                  {copiedChatCommand === 'memory-conflict-merge' ? 'AI 병합용 전문 복사됨' : 'AI 병합용 전문 복사'}
                </button>
                {!compact && (
                  <button className={buttonClass} disabled={!!busy} onClick={() => void toggleHistory()}>
                    <History style={{ width: 10, height: 10, display: 'inline', marginRight: 4 }} />
                    원격 이력 보기
                  </button>
                )}
                <button
                  type="button"
                  className={buttonClass}
                  disabled={!!busy}
                  onClick={() => {
                    setPendingConflictResolution(null);
                    setMergeDraft('');
                    void pull();
                  }}
                  title="파일을 직접 병합·수정한 뒤 최신 로컬과 원격 본문을 다시 비교합니다."
                >
                  <RefreshCw style={{ width: 10, height: 10, display: 'inline', marginRight: 4 }} />
                  다시 비교
                </button>
              </div>
              {!conflictHasVersionGuards ? (
                <p style={{ margin: '7px 0 0', fontSize: 10, lineHeight: 1.45, color: '#fda4af' }}>
                  이전 앱 또는 네트워크 응답에는 안전 검증용 해시가 없습니다. “다시 비교”를 눌러 최신 충돌 정보를 불러오세요.
                </p>
              ) : pendingConflictResolution ? (
                <div
                  data-testid="project-memory-conflict-confirm"
                  style={{ marginTop: 8, paddingTop: 7, borderTop: '1px solid rgba(248,113,113,0.22)' }}
                >
                  <p style={{ margin: '0 0 6px', fontSize: 10.5, lineHeight: 1.5, color: '#ffe4e6' }}>
                    {pendingConflictResolution === 'keep-local'
                      ? '로컬 기억을 원격 최신 리비전 뒤의 새 Supabase 리비전으로 저장합니다. 기존 원격 리비전은 삭제되지 않고 이력에 남습니다.'
                      : pendingConflictResolution === 'merged'
                        ? '아래에 검토한 병합본을 붙여넣거나 직접 편집하세요. 저장하면 현재 로컬 기억을 먼저 .agent-memory/backups/에 보존하고, 병합본을 원격 최신 리비전 뒤에 새 리비전으로 추가합니다.'
                        : 'Supabase 기억으로 로컬 파일을 교체합니다. 현재 로컬 파일은 먼저 .agent-memory/backups/에 보존됩니다.'}
                  </p>
                  {pendingConflictResolution === 'merged' && (
                    <div style={{ marginBottom: 7 }}>
                      <label
                        htmlFor="project-memory-conflict-merge-draft"
                        style={{ display: 'block', marginBottom: 4, fontSize: 10, color: '#fde68a' }}
                      >
                        병합본 (자동 저장되지 않음)
                      </label>
                      <textarea
                        id="project-memory-conflict-merge-draft"
                        data-testid="project-memory-conflict-merge-draft"
                        value={mergeDraft}
                        onChange={event => setMergeDraft(event.target.value)}
                        placeholder="병합 프롬프트의 결과를 붙여넣거나 여기서 직접 병합본을 작성하세요."
                        disabled={!!busy}
                        spellCheck={false}
                        style={{
                          display: 'block', width: '100%', minHeight: compact ? 120 : 180, resize: 'vertical',
                          boxSizing: 'border-box', padding: 7, borderRadius: 5,
                          border: '1px solid rgba(250,204,21,0.35)', background: 'rgba(9,9,11,0.62)',
                          color: '#f4f4f5', fontSize: 10, lineHeight: 1.5,
                          fontFamily: "'JetBrains Mono', ui-monospace, monospace",
                        }}
                      />
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    <button
                      type="button"
                      data-testid={pendingConflictResolution === 'merged'
                        ? 'project-memory-conflict-confirm-merge'
                        : 'project-memory-conflict-confirm-apply'}
                      className={buttonClass}
                      disabled={!!busy || (pendingConflictResolution === 'merged' && !mergeDraft.trim())}
                      onClick={() => void resolveMemoryConflict(pendingConflictResolution)}
                      style={{ borderColor: 'rgba(248,113,113,0.7)', color: '#fecaca', background: 'rgba(127,29,29,0.35)' }}
                    >
                      {pendingConflictResolution === 'merged' ? '병합본 저장' : '계속'}
                    </button>
                    <button
                      type="button"
                      className={buttonClass}
                      disabled={!!busy}
                      onClick={() => {
                        setPendingConflictResolution(null);
                        setMergeDraft('');
                      }}
                    >
                      취소
                    </button>
                  </div>
                </div>
              ) : (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
                  <button
                    type="button"
                    data-testid="project-memory-conflict-keep-local"
                    className={buttonClass}
                    disabled={!!busy}
                    onClick={() => setPendingConflictResolution('keep-local')}
                    title="로컬 내용을 새 원격 리비전으로 추가합니다. 현재 원격 버전은 이력에 보존됩니다."
                    style={{ borderColor: 'rgba(94,234,212,0.45)', color: '#99f6e4', background: 'rgba(13,148,136,0.12)' }}
                  >
                    로컬을 새 Supabase 리비전으로 저장
                  </button>
                  <button
                    type="button"
                    data-testid="project-memory-conflict-merge"
                    className={buttonClass}
                    disabled={!!busy}
                    onClick={() => {
                      setMergeDraft('');
                      setPendingConflictResolution('merged');
                    }}
                    title="AI가 제안한 병합본을 붙여넣거나 직접 편집한 뒤, 두 번째 확인에서 저장합니다. 기존 로컬 파일과 원격 리비전은 보존됩니다."
                    style={{ borderColor: 'rgba(250,204,21,0.48)', color: '#fde68a', background: 'rgba(113,63,18,0.18)' }}
                  >
                    병합본 검토·입력
                  </button>
                  <button
                    type="button"
                    data-testid="project-memory-conflict-use-remote"
                    className={buttonClass}
                    disabled={!!busy}
                    onClick={() => setPendingConflictResolution('use-remote')}
                    title="로컬 파일은 .agent-memory/backups에 보존한 뒤 Supabase 버전으로 복원합니다."
                    style={{ borderColor: 'rgba(147,197,253,0.45)', color: '#bfdbfe', background: 'rgba(30,58,138,0.18)' }}
                  >
                    원격으로 복원 · 로컬 백업 생성
                  </button>
                </div>
              )}
            </div>
          )}
          <div
            data-testid="project-memory-preferred-agent"
            style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, fontSize: compact ? 10 : 10.5, color: '#71717a' }}
          >
            {!compact && (
              <>
                <span>{status.sourcePath}</span>
                <span>·</span>
                <span>{formatBytes(status.size)}</span>
                <span>·</span>
              </>
            )}
            <label className={`flex items-center gap-2 ${compact ? '' : 'ml-auto'}`}>
              <span>세션 기억 실행 AI</span>
              <select
                value={agent}
                aria-label="세션 기억 실행 AI"
                title="세션 기억하기를 실행할 프로젝트 기본 AI입니다. 여기서 직접 변경할 때만 저장됩니다."
                onChange={e => void changePreferredAgent(e.target.value as ProjectMemoryAgent)}
                className="px-2 py-1 rounded border border-stone-700 bg-stone-900 text-[10px] text-zinc-300"
              >
                <option value="claude">Claude</option>
                <option value="codex">Codex</option>
              </select>
            </label>
            {!compact && (
              <label className="flex items-center gap-1">
                <input type="checkbox" checked={autoBackup} onChange={e => setAutoBackup(e.target.checked)} className="accent-teal-400" />
                자동 백업
              </label>
            )}
          </div>
          <div
            data-testid="project-memory-local-terminal-commands"
            title="현재 PC의 프로젝트 폴더를 직접 읽는 로컬 터미널 AI 명령입니다."
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 5,
              flexWrap: 'wrap',
              marginBottom: 8,
              fontSize: compact ? 9.5 : 10,
              color: '#71717a',
            }}
          >
            <strong style={{ color: '#a1a1aa' }}>로컬 터미널 AI</strong>
            <button
              type="button"
              data-testid="copy-claude-remember-session"
              onClick={() => void copyChatCommand('claude', '/remember-session', 'Claude /remember-session')}
              title="Claude 명령 /remember-session 복사"
              style={{
                display:'inline-flex',alignItems:'center',gap:4,padding:'2px 5px',
                borderRadius:4,border:'1px solid rgba(196,181,253,0.2)',
                background:'rgba(196,181,253,0.05)',color:'#c4b5fd',
                cursor:'pointer',fontSize:'inherit',fontFamily:'inherit',
              }}
            >
              <code>Claude /remember-session</code>
              {copiedChatCommand === 'claude' ? <Check style={{width:9,height:9}}/> : <Copy style={{width:9,height:9}}/>}
            </button>
            <span>·</span>
            <button
              type="button"
              data-testid="copy-codex-remember-session"
              onClick={() => void copyChatCommand('codex', '$remember-session', 'Codex $remember-session')}
              title="Codex 명령 $remember-session 복사"
              style={{
                display:'inline-flex',alignItems:'center',gap:4,padding:'2px 5px',
                borderRadius:4,border:'1px solid rgba(153,246,228,0.2)',
                background:'rgba(153,246,228,0.05)',color:'#99f6e4',
                cursor:'pointer',fontSize:'inherit',fontFamily:'inherit',
              }}
            >
              <code>Codex $remember-session</code>
              {copiedChatCommand === 'codex' ? <Check style={{width:9,height:9}}/> : <Copy style={{width:9,height:9}}/>}
            </button>
            <span>·</span>
            {/* Hermes도 로컬 터미널에서 돈다. 여기 없던 이유는 "기기당 설치"라는 **설치**
                축으로 갈랐기 때문인데, 사용자가 찾는 축은 **어디서 실행하느냐**다.
                ⚠️ 인자가 붙은 형태여야 한다 — 스킬 규약상 인자 없는 `/remember_session`은
                현재 Telegram topic 바인딩을 따르므로, 로컬 터미널에서는 대상이 없어 멈춘다.
                인자가 있으면 "one-shot local-terminal selection"으로 처리된다. */}
            <button
              type="button"
              data-testid="copy-hermes-remember-session-local"
              onClick={() => void copyChatCommand('hermes-local', hermesRememberSessionPathCommand, 'Hermes /remember_session <경로>')}
              title={`로컬 터미널 Hermes용 · 인자가 붙어 Telegram topic에 바인딩하지 않습니다: ${hermesRememberSessionPathCommand}`}
              style={{
                display:'inline-flex',alignItems:'center',gap:4,padding:'2px 5px',
                borderRadius:4,border:'1px solid rgba(252,211,77,0.2)',
                background:'rgba(252,211,77,0.05)',color:'#fcd34d',
                cursor:'pointer',fontSize:'inherit',fontFamily:'inherit',
              }}
            >
              <code>Hermes /remember_session &lt;경로&gt;</code>
              {copiedChatCommand === 'hermes-local' ? <Check style={{width:9,height:9}}/> : <Copy style={{width:9,height:9}}/>}
            </button>
            <span title="Claude/Codex 스킬의 대체 호출이며 별도 저장 기능이 아닙니다.">· 자연어: “세션 기억하기”</span>
          </div>
          {/* 이 상자를 호스트(로컬/AWS)로 가르지 않는 이유: 스킬 본문이 전부
              `http://127.0.0.1:3001`을 부르므로 "AWS용 명령"이라는 것은 존재하지 않는다.
              같은 명령을 어느 호스트의 Hermes에 붙여넣느냐일 뿐이고, 실제로 갈리는 축은
              인자 유무(=topic 바인딩이냐 일회성이냐)다. */}
          <details
            data-testid="project-memory-hermes-commands"
            style={{ marginBottom: 8, padding: '7px 8px', borderRadius: 6, border: '1px solid rgba(125,211,252,0.13)', background: 'rgba(14,116,144,0.045)', fontSize: compact ? 9.5 : 10 }}
          >
            <summary style={{ cursor: 'pointer', color: '#7dd3fc', fontWeight: 600, listStyle: 'revert' }}>
              Hermes 명령 <span style={{ fontWeight: 400 }}>— Telegram 대화에 붙여넣는 것</span>
              <span style={{ color: '#52525b', fontWeight: 400, marginLeft: 5 }}>기기당 한 번 설치 · 필요할 때만 펼치기</span>
            </summary>
            {/* "어디에 쓰는 명령인지"를 먼저 못 박는다. 로컬 터미널 Hermes 버튼은 위
                「로컬 터미널 AI」 줄에 있고, 이 상자는 Telegram 대화용이다. 두 표면이
                같은 `/remember_session`을 쓰되 인자 유무로 갈리기 때문에, 구분해 두지
                않으면 사용자가 잘못된 쪽을 복사해 "대상 없음"으로 멈춘다. */}
            <p data-testid="project-memory-hermes-scope" style={{ margin: '0 0 5px', color: '#a1a1aa' }}>
              <span style={{ color: '#7dd3fc', fontWeight: 600 }}>여기 명령은 Telegram의 Hermes 대화에 붙여넣습니다.</span>{' '}
              이 PC의 터미널에서 Hermes를 쓰는 중이라면 위 <span style={{ color: '#fcd34d', fontWeight: 600 }}>로컬 터미널 AI</span> 줄의
              <code style={{ margin: '0 3px' }}>/remember_session &lt;경로&gt;</code>를 쓰세요.
            </p>
            <p style={{ margin: '0 0 5px', color: '#71717a' }}>
              같은 명령이지만 <span style={{ color: '#a1a1aa', fontWeight: 600 }}>그 대화를 받는 gateway가 도는 호스트</span>를 제어합니다 —
              그래서 <span style={{ color: '#a1a1aa', fontWeight: 600 }}>“Telegram으로 이 PC를 제어”</span>와
              <span style={{ color: '#a1a1aa', fontWeight: 600 }}> “Telegram으로 AWS를 제어”</span>가 갈립니다.
              gateway는 호스트마다 하나씩 띄웁니다.
            </p>
            {/* 호스트 스위치. 명령 목록을 두 벌로 복제하지 않는 이유는 7개 중 6개가 글자까지
                같기 때문이다 — 복제하면 방금 지운 중복이 6배로 돌아온다. 갈리는 것은
                `/hermes_open`(창을 연다) · 경로 인자 기준 · 무엇이 저장되는가 셋뿐이고,
                판정은 `src/hermesCommandHost.ts` 한 곳이다. */}
            <div data-testid="project-memory-hermes-host" style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap', marginBottom: 5 }}>
              {HERMES_COMMAND_HOSTS.map(host => (
                <button
                  key={host}
                  type="button"
                  data-testid={`project-memory-hermes-host-${host}`}
                  aria-pressed={hermesHost === host}
                  onClick={() => chooseHermesHost(host)}
                  title={host === 'local'
                    ? 'Telegram 대화로 이 Mac의 Hermes를 제어할 때. 이 Mac이 켜져 있어야 응답합니다.'
                    : 'Telegram 대화로 AWS의 Hermes를 제어할 때. 이 Mac이 꺼져 있어도 응답하고, 대상은 AWS의 폴더와 세션입니다.'}
                  style={{
                    display:'inline-flex',alignItems:'center',gap:4,padding:'2px 6px',borderRadius:4,
                    border:`1px solid ${hermesHost === host ? 'rgba(125,211,252,0.5)' : 'rgba(161,161,170,0.18)'}`,
                    background: hermesHost === host ? 'rgba(14,116,144,0.28)' : 'transparent',
                    color: hermesHost === host ? '#7dd3fc' : '#71717a',
                    cursor:'pointer',fontSize:'inherit',fontFamily:'inherit',
                    fontWeight: hermesHost === host ? 600 : 400,
                  }}
                >
                  {HERMES_COMMAND_HOST_LABELS[host]}
                </button>
              ))}
            </div>
            {/* 고른 뒤에 "그래서 무엇이 달라지는가"를 그 자리에서 읽을 수 있어야 한다.
                gateway(제어 대상) · 응답 시점 · 저장 대상 셋이 두 경로를 실제로 가른다. */}
            <div data-testid="project-memory-hermes-host-captures" style={{ marginBottom: 6, color: '#71717a' }}>
              <div>{hermesHostNotes.gateway} <span style={{ color: '#52525b' }}>{hermesHostNotes.uptime}</span></div>
              <div>{hermesHostNotes.captures}</div>
            </div>
            {/* 명령을 복사해 줘도 Hermes 쪽에 스킬이 없으면 Unknown command 로 거절된다.
                그 사실은 설치 상태와 무관하게 알려야 하므로 이 줄은 항상 렌더한다 —
                Hermes가 이 PC에 없는 경우(=AWS에만 있는 사용자)가 정확히 안내가 가장
                필요한 경우인데, 예전에는 그때 줄 전체가 사라졌다.
                ⚠️ 다만 이 줄이 말하는 것은 **이 PC의 설치 상태**뿐이다. 원격을 고른 동안
                로컬 설치 상태를 그대로 두면 "AWS에 설치됐다"로 읽히므로, 그때는 그 호스트에서
                설치해야 한다는 사실과 그 경로(AWS Ubuntu 설정 프롬프트)를 대신 말한다. */}
            {hermesHost === 'remote' && (
              <div data-testid="project-memory-hermes-remote-install-note" style={{ marginBottom: 6, color: '#a1a1aa' }}>
                이 앱은 로컬 Hermes 홈만 설치할 수 있습니다. 그 호스트의 Hermes에는 그 호스트에서 설치해야 합니다 —
                아래 <span style={{ color: '#a1a1aa', fontWeight: 600 }}>“다른 환경에 설치·연결 → AWS Ubuntu 설정 프롬프트”</span>.
                설치 여부는 그 대화에서 <code style={{ margin: '0 3px' }}>/commands</code>로 확인하세요.
              </div>
            )}
            {hermesHost === 'local' && hermesAdapter && (
              <div data-testid="project-memory-hermes-install-row" style={{ marginBottom: 6 }}>
                {hermesInstallPending ? (
                  <>
                    <button
                      type="button"
                      data-testid="project-memory-hermes-install"
                      className={buttonClass}
                      disabled={!!busy}
                      onClick={() => void installHermesAdapter()}
                      title={`${hermesAdapter.skillsDir} 에 스킬을 설치하고 Hermes config.yaml 의 skills.external_dirs 에 등록합니다. 이 앱은 로컬 Hermes 홈만 다룰 수 있습니다.`}
                      style={{ borderColor: 'rgba(251,146,60,0.45)', background: 'rgba(124,45,18,0.22)', color: '#fdba74' }}
                    >
                      {busy === 'hermes-adapter' ? '설치 중…' : `이 PC의 Hermes에 ${hermesInstallPending}`}
                    </button>
                    <span style={{ marginLeft: 6, color: '#a1a1aa' }}>
                      프로젝트마다가 아니라 이 PC에 한 번. 설치 전에는 Hermes가 이 명령들을 모릅니다.
                    </span>
                  </>
                ) : hermesAdapter.hermesPresent ? (
                  <span data-testid="project-memory-hermes-installed" style={{ color: '#52525b' }}>
                    이 PC의 Hermes에 설치됨 · 명령 {hermesAdapter.installed.length}개 · v{hermesAdapter.installedVersion} · {hermesAdapter.skillsDir}
                  </span>
                ) : hermesAdapter.hermesHomePresent ? (
                  /* 폴더는 있는데 CLI가 없는 상태를 「Hermes 없음」과 뭉뚱그리면, 사용자는
                     `~/.hermes`가 보이니 설치된 줄 알고 실행 버튼을 계속 누른다. 그 폴더를
                     누가 만들었는지까지 밝혀야 다음 행동이 정해진다. */
                  <span data-testid="project-memory-hermes-cli-missing" style={{ color: '#a1a1aa' }}>
                    이 PC에 Hermes 설정 폴더({hermesAdapter.hermesHome})는 있지만 실행 파일(`hermes`)이 없습니다. 그 폴더는 이 앱이 만든 것이라 설치 증거가 아닙니다 — Hermes를 설치하면 실행·설치 버튼이 나타납니다.
                  </span>
                ) : (
                  <span data-testid="project-memory-hermes-absent" style={{ color: '#a1a1aa' }}>
                    이 PC에는 Hermes가 없습니다. 이 앱은 로컬 Hermes 홈에만 설치할 수 있으므로, AWS 등 다른 호스트의 Hermes는 그 호스트에서 설치해야 합니다 — 아래 “다른 환경에 설치·연결 → AWS Ubuntu 설정 프롬프트”.
                  </span>
                )}
              </div>
            )}
            <div data-testid="project-memory-hermes-topic-commands" style={{ marginBottom: 6 }}>
              <div style={{ marginBottom: 3, color: '#a1a1aa' }}>
                이 topic 기준으로 실행 — Telegram topic 바인딩을 따릅니다
                <span style={{ color: '#52525b' }}> · 프로젝트 topic 안에서 실행하고, “모두/General”에서는 실행하지 마세요.</span>
              </div>
              {/* 명령만 늘어놓으면 어느 것을 눌러야 하는지 알 수 없어, 결국 아무거나
                  눌러 보게 된다. 한 줄 설명을 명령 옆에 붙여 그 자리에서 고르게 한다. */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                {hermesCommandRows.map((item, index) => {
                  const missing = hermesTracksInstalls && !hermesInstalledSkills.has(item.skill);
                  const stepStarts = index === 0 || hermesCommandRows[index - 1]?.step !== item.step;
                  const aliases = hermesTopicCommands.filter(other => other.aliasOf === item.skill);
                  const available = isHermesCommandAvailable(hermesHost, item);
                  return (
                    <div key={item.testId} style={{ display: 'flex', alignItems: 'baseline', gap: 5, flexWrap: 'wrap', opacity: available ? 1 : 0.55 }}>
                      {stepStarts && (
                        <div data-testid={`project-memory-hermes-step-${item.step}`} style={{ width: '100%', margin: index === 0 ? 0 : '3px 0 0', color: '#52525b' }}>
                          {item.step} <span style={{ color: '#3f3f46' }}>· {hermesStepNote[item.step]}</span>
                        </div>
                      )}
                      <button type="button" data-testid={item.testId} className={buttonClass}
                        title={`복사: ${item.command}`}
                        onClick={() => void copyChatCommand(item.testId, item.command, `Hermes ${item.label}`)}>
                        <code>{item.label}</code> {copiedChatCommand === item.testId ? <Check style={{width:9,height:9}}/> : <Copy style={{width:9,height:9}}/>}
                      </button>
                      <span style={{ color: '#71717a' }}>{item.desc}</span>
                      {!available && hermesHostNotes.desktopUnavailable && (
                        <span data-testid={`${item.testId}-unavailable`} style={{ color: '#fca5a5' }}>
                          · {hermesHostNotes.desktopUnavailable}
                        </span>
                      )}
                      {aliases.map(alias => (
                        <span key={alias.skill} data-testid={`project-memory-hermes-alias-${alias.skill}`} style={{ color: '#52525b' }}>
                          <code>{alias.label}</code> {alias.desc}
                        </span>
                      ))}
                      {missing && (
                        <span data-testid={`${item.testId}-missing`} style={{ color: '#fdba74' }}>
                          · 이 PC의 Hermes에는 아직 없음
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
            {/* 여기에도 같은 복사 버튼이 있었다 — 위 「로컬 터미널 AI」 줄의 것과 복사되는
                문자열까지 완전히 같아서, 한 패널에 똑같은 버튼이 둘이었다. 인자형의 주된
                자리는 항상 보이는 그 줄이고(로컬 터미널에서는 인자형만 동작한다), 이 상자는
                기본이 접힌 상태라 발견성도 낮다. 그래서 여기서는 버튼을 없애고 의미만 남긴다.
                ⚠️ 설명까지 지우지는 말 것 — Telegram에서 바인딩을 건드리지 않고 한 번만
                저장하는 방법이 이 문단 말고는 어디에도 적히지 않는다. */}
            <div data-testid="project-memory-hermes-path-commands" style={{ color: '#71717a' }}>
              <span style={{ color: '#a1a1aa' }}>경로 인자와 함께</span> — <code>/remember_session &lt;경로&gt;</code> 처럼 경로를 붙이면
              topic 바인딩을 건드리지 않고 그 프로젝트에만 한 번 저장합니다.
              <span style={{ color: '#52525b' }}> 복사 버튼은 위 <span style={{ color: '#fcd34d' }}>로컬 터미널 AI</span> 줄에 하나만 두었습니다 ·
                <span data-testid="project-memory-hermes-path-hint"> {hermesHostNotes.pathHint}</span>
                {hermesHost === 'local' && ' 그 경로는 이 PC 기준이라 다른 호스트의 Hermes에서는 그 호스트의 경로로 바꿔야 합니다.'}</span>
            </div>
          </details>
          {!compact && (
          <details data-testid="project-memory-setup-prompts" style={{ marginBottom: 8, padding: '5px 8px', borderRadius: 6, border: '1px solid rgba(161,161,170,0.12)' }}>
            <summary style={{ cursor: 'pointer', fontSize: 10, color: '#71717a' }}>다른 환경에 설치·연결</summary>
            <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap', marginTop: 6 }}>
            <button
              type="button"
              data-testid="copy-manual-init-prompt"
              onClick={() => void copyChatCommand('manual-init', manualInitPrompt, '다른 폴더용 장기기억 설정 프롬프트')}
              title="이 앱을 거치지 않고, 다른 프로젝트 폴더의 Claude/Codex 채팅에 붙여넣어 장기기억을 수동으로 설정할 프롬프트를 복사합니다. (로컬 API 서버가 실행 중이어야 합니다.)"
              style={{
                display:'inline-flex',alignItems:'center',gap:4,padding:'2px 5px',
                borderRadius:4,border:'1px solid rgba(161,161,170,0.18)',
                background:'rgba(161,161,170,0.045)',color:'#a1a1aa',
                cursor:'pointer',fontSize:'inherit',fontFamily:'inherit',
              }}
            >
              <span>다른 폴더에서 수동 실행</span>
              {copiedChatCommand === 'manual-init' ? <Check style={{width:9,height:9}}/> : <Copy style={{width:9,height:9}}/>}
            </button>
            <span>·</span>
            <button
              type="button"
              data-testid="copy-standalone-init-prompt"
              onClick={() => void copyChatCommand('standalone-init', standaloneInitPrompt, '앱 없는 PC용 장기기억 설정 프롬프트')}
              title="이 앱이 설치되지 않은 PC에서, 로컬 API 서버 없이 파일만으로 같은 장기기억 구조를 만들게 하는 프롬프트를 복사합니다."
              style={{
                display:'inline-flex',alignItems:'center',gap:4,padding:'2px 5px',
                borderRadius:4,border:'1px solid rgba(161,161,170,0.18)',
                background:'rgba(161,161,170,0.045)',color:'#a1a1aa',
                cursor:'pointer',fontSize:'inherit',fontFamily:'inherit',
              }}
            >
              <span>{`앱 없는 PC용 v${STANDALONE_MEMORY_PROMPT_VERSION}`}</span>
              {copiedChatCommand === 'standalone-init' ? <Check style={{width:9,height:9}}/> : <Copy style={{width:9,height:9}}/>}
            </button>
            <span>·</span>
            <button
              type="button"
              data-testid="copy-aws-ubuntu-memory-setup"
              onClick={() => void copyAwsUbuntuSetupPrompt()}
              title="AWS Ubuntu 연결에 필요한 설정 프롬프트를 복사합니다. Supabase 프로젝트 전체 권한의 service-role key는 포함되지 않으며 Ubuntu에서 직접 입력해야 합니다."
              style={{
                display:'inline-flex',alignItems:'center',gap:4,padding:'2px 5px',
                borderRadius:4,border:'1px solid rgba(125,211,252,0.22)',
                background:'rgba(14,116,144,0.08)',color:'#7dd3fc',
                cursor:'pointer',fontSize:'inherit',fontFamily:'inherit',
              }}
            >
              <span>AWS Ubuntu 설정 프롬프트</span>
              {copiedChatCommand === 'aws-ubuntu' ? <Check style={{width:9,height:9}}/> : <Copy style={{width:9,height:9}}/>}
            </button>
            </div>
          </details>
          )}
          <div data-testid="project-memory-remember-actions" style={{ marginBottom: 8 }}>
            <div style={{ marginBottom: 4, fontSize: 10, color: '#a1a1aa', fontWeight: 600 }}>대화·세션 기억 저장</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button
              data-testid="project-memory-session-end"
              className={buttonClass}
              disabled={!!busy || !sessionNeedsRemember}
              onClick={() => void sessionEnd()}
              title={sessionNeedsRemember
                ? `마지막 저장 이후 ${[
                  sessionActivityReason ? 'Claude/Codex 프롬프트 활동' : '',
                  projectActivityReason ? `프로젝트${status?.activity?.worktreeCount ? `·워크트리 ${status.activity.worktreeCount}개 포함` : ''} 변경` : '',
                ].filter(Boolean).join('과 ')}이 감지되었습니다.`
                : '새로 기억할 대화·프로젝트 활동이 없습니다.'}
              style={sessionNeedsRemember ? {
                border: '1px solid rgba(251,191,36,0.75)',
                background: 'rgba(120,53,15,0.22)',
                color: '#fde68a',
                fontWeight: 600,
              } : undefined}
            >
              <Save style={{ width: 10, height: 10, display: 'inline', marginRight: 4 }} />
              {sessionNeedsRemember ? '세션 기억하기 필요' : '세션 기억 완료'}
            </button>
            {!compact && (
              <button className={buttonClass} disabled={!!busy} onClick={() => void update()}>
                <RefreshCw style={{ width: 10, height: 10, display: 'inline', marginRight: 4 }} />
                기억 업데이트
              </button>
            )}
            </div>
          </div>
          <div data-testid="project-memory-sync-actions">
            <div style={{ marginBottom: 4, fontSize: 10, color: '#a1a1aa', fontWeight: 600 }}>클라우드 동기화</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button
              data-testid="project-memory-safe-sync"
              className={buttonClass}
              disabled={!!busy || syncDirection === 'checking'}
              onClick={() => void sync()}
              title="로컬·원격 해시를 비교해 안전한 방향으로만 동기화합니다. 양쪽이 바뀌었으면 덮어쓰지 않고 충돌 검토를 엽니다."
              style={syncDirection === 'conflict' ? {
                borderColor: 'rgba(248,113,113,0.55)',
                background: 'rgba(127,29,29,0.18)',
                color: '#fecaca',
              } : syncDirection === 'push' ? {
                borderColor: 'rgba(251,191,36,0.6)',
                background: 'rgba(120,53,15,0.22)',
                color: '#fde68a',
              } : syncDirection === 'pull' ? {
                borderColor: 'rgba(96,165,250,0.6)',
                background: 'rgba(30,58,138,0.2)',
                color: '#bfdbfe',
              } : undefined}
            >
              <RefreshCw style={{ width: 10, height: 10, display: 'inline', marginRight: 4 }} />
              {syncDirection === 'conflict' ? '동기화 충돌 검토' : 'Supabase 동기화'}
            </button>
            {!compact && (
              <button className={buttonClass} disabled={!!busy} onClick={() => void toggleHistory()}>
                <History style={{ width: 10, height: 10, display: 'inline', marginRight: 4 }} />
                이력
              </button>
            )}
            {busyLabel && <span style={{ fontSize: 10.5, color: '#5eead4', alignSelf: 'center' }}>{busyLabel}</span>}
            </div>
          </div>
          {showHistory && !compact && (
            <div style={{ marginTop: 8, borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: 7 }}>
              {revisions.length === 0 ? (
                <p style={{ margin: 0, fontSize: 10.5, color: '#71717a' }}>저장된 원격 리비전이 없습니다.</p>
              ) : revisions.map((revision, index) => (
                <button
                  key={revision.id}
                  onClick={() => void restoreRevision(revision)}
                  style={{
                    width: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '6px 4px',
                    background: 'transparent',
                    border: 'none',
                    borderBottom: '1px solid rgba(255,255,255,0.05)',
                    color: '#a1a1aa',
                    cursor: 'pointer',
                    fontSize: 10.5,
                    textAlign: 'left',
                  }}
                >
                  <span style={{ color: index === 0 ? '#5eead4' : '#71717a' }}>{index === 0 ? '최신' : `#${revisions.length - index}`}</span>
                  <span>{revision.created_at ? new Date(revision.created_at).toLocaleString() : revision.id}</span>
                  <span style={{ marginLeft: 'auto', color: '#52525b' }}>{revision.device_name || revision.device_id || ''}</span>
                </button>
              ))}
            </div>
          )}
        </>
      )}
      {error && !compact && !missingProjectRoot && <p style={{ fontSize: 10.5, color: '#f87171', margin: '8px 0 0' }}>{error}</p>}
    </section>
  );
}
