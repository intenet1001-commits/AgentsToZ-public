import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  AlertTriangle,
  Bot,
  Check,
  Copy,
  ExternalLink,
  FolderCheck,
  Loader2,
  RefreshCw,
  ShieldCheck,
  X,
} from "lucide-react";
import {
  buildBuzzAgentSetupClipboard,
  buildGenericBuzzCsCeoInstructions,
  buildServiceBuzzAgentInstructions,
  defaultBuzzCsCeoAgentName,
  defaultBuzzServiceAgentName,
  type BuzzAgentScope,
  type BuzzAgentRuntime,
  type BuzzProjectAgentTarget,
  type BuzzServiceMemoryTarget,
  type AgentsToZUseControlTarget,
} from "./buzzAgentBootstrapContract";
import { isTauri } from "./lib/env";

type RuntimeStatus = {
  id: BuzzAgentRuntime;
  label: string;
  installed: boolean;
  executablePath: string | null;
  configurationState: "ready" | "needs-model" | "unknown";
  configurationProblem: string | null;
};

type BootstrapStatus = {
  success: true;
  scope: BuzzAgentScope;
  ready: boolean;
  appInstalled: boolean;
  appPath: string | null;
  canonicalRoot: string | null;
  skillPath: string | null;
  canonicalRootReady: boolean;
  canonicalProblem: string | null;
  runtimes: RuntimeStatus[];
  defaultRuntime: BuzzAgentRuntime;
  agentName: string;
  instructions: string | null;
  project: BuzzProjectAgentTarget | null;
  serviceMemory: BuzzServiceMemoryTarget | null;
  control: AgentsToZUseControlTarget | null;
  serviceMemoryStatus: ServiceMemoryStatus;
  directCreateSupported: false;
  ownerApprovalRequired: true;
};

type ServiceMemoryStatus = {
  exists: boolean;
  ready: boolean;
  record: BuzzServiceMemoryTarget | null;
  problem: string | null;
};

type EnsureServiceMemoryResponse = ApiError & {
  success: true;
  created: boolean;
  project: BuzzProjectAgentTarget;
  serviceMemory: ServiceMemoryStatus;
};

type ApiError = { success?: boolean; error?: string; message?: string };

export interface BuzzAgentSetupDialogProps {
  deviceName?: string;
  scope?: BuzzAgentScope;
  projects?: Array<{ id: string; name: string; folderPath?: string }>;
  initialProjectId?: string;
  onClose: () => void;
  onToast: (message: string, type: "success" | "error") => void;
}

const apiBase = () => isTauri() ? "http://127.0.0.1:3001" : "";

async function bootstrapPost<T extends ApiError>(action: "status" | "open" | "install-codex-control", body: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${apiBase()}/api/buzz-agent-bootstrap/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({})) as T;
  if (!response.ok || result.success !== true) throw new Error(result.error || `Buzz Agent ${action} 요청 실패`);
  return result;
}

async function serviceMemoryPost<T extends ApiError>(action: "status" | "ensure", body: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${apiBase()}/api/service-memory/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({})) as T;
  if (!response.ok || result.success !== true) throw new Error(result.error || `USE 운영기억 ${action} 요청 실패`);
  return result;
}

function ReadyBadge({ ready, children }: { ready: boolean; children: React.ReactNode }) {
  return (
    <span className={`inline-flex min-h-7 items-center gap-1 rounded-md border px-2 py-1 text-[10px] ${ready ? "border-emerald-300/20 bg-emerald-300/[0.06] text-emerald-200" : "border-amber-300/20 bg-amber-300/[0.06] text-amber-200"}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${ready ? "bg-emerald-300" : "bg-amber-300"}`} />
      {children}
    </span>
  );
}

export function BuzzAgentSetupDialog({
  deviceName,
  scope = "global",
  projects = [],
  initialProjectId,
  onClose,
  onToast,
}: BuzzAgentSetupDialogProps) {
  const [status, setStatus] = useState<BootstrapStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [opening, setOpening] = useState(false);
  const [ensuringServiceMemory, setEnsuringServiceMemory] = useState(false);
  const [installingCodexControl, setInstallingCodexControl] = useState(false);
  const [error, setError] = useState("");
  const [agentName, setAgentName] = useState("");
  const [runtime, setRuntime] = useState<BuzzAgentRuntime>("codex");
  const [selectedProjectId, setSelectedProjectId] = useState(
    initialProjectId ?? projects.find(project => !!project.folderPath)?.id ?? projects[0]?.id ?? "",
  );
  const [copied, setCopied] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const agentNameTouchedRef = useRef(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const next = await bootstrapPost<BootstrapStatus>("status", {
        deviceName,
        scope,
        ...(scope === "service" && selectedProjectId ? { portId: selectedProjectId } : {}),
      });
      setStatus(next);
      if (!agentNameTouchedRef.current) setAgentName(next.agentName);
      setRuntime(current => next.runtimes.some(candidate => candidate.id === current && candidate.installed)
        ? current
        : next.defaultRuntime);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setLoading(false);
    }
  }, [deviceName, scope, selectedProjectId]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (scope !== "service" || selectedProjectId) return;
    const firstProject = projects.find(project => !!project.folderPath);
    if (firstProject) setSelectedProjectId(firstProject.id);
  }, [projects, scope, selectedProjectId]);
  useEffect(() => {
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const timer = window.setTimeout(() => closeButtonRef.current?.focus(), 0);
    return () => {
      window.clearTimeout(timer);
      previousFocusRef.current?.focus();
    };
  }, []);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !opening && !ensuringServiceMemory && !installingCodexControl) {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ));
      if (!focusable.length) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [ensuringServiceMemory, installingCodexControl, onClose, opening]);

  const instructions = useMemo(() => {
    if (scope === "service") {
      if (!status?.project || !status.serviceMemory) return "";
      return buildServiceBuzzAgentInstructions({
        deviceName,
        project: status.project,
        serviceMemory: status.serviceMemory,
        runtime,
        control: status.control,
      });
    }
    if (!status?.canonicalRoot || !status.skillPath) return "";
    return buildGenericBuzzCsCeoInstructions({
      deviceName,
      canonicalRoot: status.canonicalRoot,
      skillPath: status.skillPath,
      runtime,
    });
  }, [deviceName, runtime, scope, status?.canonicalRoot, status?.control, status?.project, status?.serviceMemory, status?.skillPath]);

  useEffect(() => {
    if (agentNameTouchedRef.current) return;
    if (scope === "service" && status?.project) {
      setAgentName(defaultBuzzServiceAgentName({
        projectName: status.project.projectName,
        deviceName,
        agentsToZControl: status.control !== null,
      }));
      return;
    }
    if (scope === "global") setAgentName(defaultBuzzCsCeoAgentName(deviceName));
  }, [deviceName, scope, status?.control, status?.project]);

  const ensureUseMemory = async () => {
    if (!selectedProjectId || !status?.project) return;
    setEnsuringServiceMemory(true);
    setError("");
    try {
      const result = await serviceMemoryPost<EnsureServiceMemoryResponse>("ensure", {
        portId: selectedProjectId,
        serviceKey: "default",
        displayName: status.project.projectName,
      });
      setStatus(current => current ? {
        ...current,
        project: result.project,
        serviceMemory: result.serviceMemory.record,
        serviceMemoryStatus: result.serviceMemory,
        ready: current.appInstalled
          && current.runtimes.some(candidate => candidate.installed)
          && result.serviceMemory.ready,
      } : current);
      onToast(result.created ? "USE 운영기억을 만들었습니다." : "기존 USE 운영기억을 확인했습니다.", "success");
    } catch (nextError) {
      const message = nextError instanceof Error ? nextError.message : String(nextError);
      setError(message);
      onToast(message, "error");
    } finally {
      setEnsuringServiceMemory(false);
    }
  };

  const copySettings = async () => {
    const targetPath = scope === "service" ? status?.project?.canonicalPath : status?.canonicalRoot;
    if (!targetPath || !instructions) return;
    try {
      await navigator.clipboard.writeText(buildBuzzAgentSetupClipboard({
        agentName,
        canonicalRoot: status?.canonicalRoot,
        runtime,
        instructions,
        scope,
        project: status?.project,
        serviceMemory: status?.serviceMemory,
      }));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_000);
      onToast(scope === "service" ? "Buzz USE 서비스 Agent 생성 설정을 복사했습니다." : "Buzz 범용 CS-CEO 생성 설정을 복사했습니다.", "success");
    } catch (nextError) {
      onToast(nextError instanceof Error ? nextError.message : "설정을 복사하지 못했습니다.", "error");
    }
  };

  const openBuzzDesktop = async () => {
    setOpening(true);
    setError("");
    try {
      const result = await bootstrapPost<ApiError>("open", {});
      onToast(result.message || "Buzz Desktop을 열었습니다.", "success");
    } catch (nextError) {
      const message = nextError instanceof Error ? nextError.message : String(nextError);
      setError(message);
      onToast(message, "error");
    } finally {
      setOpening(false);
    }
  };

  const installCodexControl = async () => {
    if (!status?.project || !status.control) return;
    setInstallingCodexControl(true);
    setError("");
    try {
      const result = await bootstrapPost<ApiError & {
        success: true;
        codexMcp: AgentsToZUseControlTarget["codexMcp"];
      }>("install-codex-control", { portId: status.project.projectId });
      setStatus(current => current?.control ? {
        ...current,
        control: { ...current.control, codexMcp: result.codexMcp },
      } : current);
      onToast(result.message || "Codex에 AgentsToZ 제한형 제어 도구를 연결했습니다.", "success");
    } catch (nextError) {
      const message = nextError instanceof Error ? nextError.message : String(nextError);
      setError(message);
      onToast(message, "error");
    } finally {
      setInstallingCodexControl(false);
    }
  };

  const selectedRuntime = status?.runtimes.find(candidate => candidate.id === runtime) ?? null;
  const runtimeReady = selectedRuntime?.installed === true;
  const targetReady = scope === "service"
    ? !!status?.project && !!status.serviceMemoryStatus.ready && !!status.serviceMemory
    : !!status?.canonicalRootReady;
  const controlReady = !status?.control || (runtime === "codex" && status.control.codexMcp.ready);
  const canPrepare = targetReady && runtimeReady && controlReady && !!agentName.trim() && !!instructions;

  return createPortal(
    <div className="fixed inset-0 z-[10090] flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm" onMouseDown={event => { if (event.target === event.currentTarget && !opening && !ensuringServiceMemory && !installingCodexControl) onClose(); }}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="buzz-agent-setup-title" className="max-h-[calc(100vh-2rem)] w-full max-w-2xl overflow-y-auto rounded-2xl border border-teal-300/20 bg-[#101014] shadow-2xl shadow-black/60">
        <div className="sticky top-0 z-10 flex items-start gap-3 border-b border-white/[0.07] bg-[#101014]/95 px-5 py-4 backdrop-blur">
          <div className="rounded-xl border border-teal-300/20 bg-teal-300/10 p-2.5 text-teal-200"><Bot className="h-5 w-5" /></div>
          <div className="min-w-0">
            <div className="mb-1 flex flex-wrap items-center gap-2">
              <h2 id="buzz-agent-setup-title" className="m-0 text-base font-semibold text-zinc-100">{scope === "service" ? "프로젝트 → USE 서비스 Agent 만들기" : "Buzz 범용 Agent 생성·연결"}</h2>
              <span className="rounded-full border border-violet-300/20 bg-violet-300/[0.06] px-2 py-0.5 text-[10px] text-violet-200">{scope === "service" ? "USE 전용" : "한 번만 생성"}</span>
            </div>
            <p className="m-0 text-xs leading-5 text-zinc-400">{scope === "service"
              ? "프로젝트를 직접 개발하는 Agent가 아니라, 제품을 사용하는 사람과 대화하는 USE 서비스 Agent입니다. DEV 프로젝트 기억은 읽기 전용이며 운영지식은 별도 USE 기억에 보관합니다."
              : "CS-CEO 정본을 기준으로 실행하고, 현재 채널 UUID를 이 단말의 AgentsToZ 연결표에서 해석하는 범용 Agent입니다. 프로젝트 채널 연결은 별도이며 필요한 채널마다 반복할 수 있습니다."}</p>
          </div>
          <button ref={closeButtonRef} type="button" aria-label="Buzz Agent 설정 닫기" onClick={onClose} disabled={opening || ensuringServiceMemory || installingCodexControl} className="ml-auto min-h-11 min-w-11 shrink-0 rounded-lg p-2 text-zinc-400 hover:bg-white/5 hover:text-zinc-100 disabled:opacity-40"><X className="h-4 w-4" /></button>
        </div>

        <div className="space-y-4 p-5">
          <div className="rounded-xl border border-teal-300/15 bg-teal-300/[0.04] p-3 text-[11px] leading-5 text-zinc-300">
            <strong className="text-teal-200">역할 분리</strong> · {scope === "service"
              ? <>이 화면은 USE 서비스 Agent와 운영기억을 준비합니다. <span className="text-cyan-200">Buzz로 열기</span>는 별도의 DEV 채널·프로젝트 기억 연결이며, USE Agent는 USE 채널에만 추가합니다.</>
              : <>이 화면은 재사용 Agent를 준비합니다. 각 프로젝트의 <span className="text-cyan-200">Buzz로 열기</span>는 프로젝트 폴더·채널·장기기억 연결만 담당하고, 범용 Agent는 메시지를 받은 채널 UUID로 그 연결을 조회합니다.</>} GitHub 저장소는 Agent 생성의 전제가 아니며 나중에 추가되어도 현재 Git 상태를 사용합니다.
          </div>

          {scope === "service" && (
            <label className="block text-[11px] text-zinc-300">서비스 Agent로 만들 프로젝트
              <select
                data-testid="buzz-agent-project"
                value={selectedProjectId}
                onChange={event => {
                  agentNameTouchedRef.current = false;
                  setAgentName("");
                  setStatus(null);
                  setError("");
                  setSelectedProjectId(event.target.value);
                }}
                className="mt-1 min-h-11 w-full rounded-lg border border-white/10 bg-black/25 px-3 py-2 text-xs text-zinc-100 outline-none focus:border-teal-300/40"
              >
                <option value="">프로젝트 선택</option>
                {projects.filter(project => !!project.folderPath).map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
              </select>
              {!projects.some(project => !!project.folderPath) && <span className="mt-1 block text-[10px] text-amber-300">이 단말에 폴더가 등록된 프로젝트가 없습니다.</span>}
            </label>
          )}

          {loading && !status ? (
            <div className="flex items-center justify-center gap-2 py-12 text-sm text-zinc-400"><Loader2 className="h-4 w-4 animate-spin" />{scope === "service" ? "DEV 프로젝트와 USE 운영기억 확인 중…" : "Buzz와 CS-CEO 정본 확인 중…"}</div>
          ) : status && (
            <>
              <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <ReadyBadge ready={status.appInstalled}>{status.appInstalled ? "Buzz 앱 감지" : "Buzz 앱 없음"}</ReadyBadge>
                  {scope === "global"
                    ? <ReadyBadge ready={status.canonicalRootReady}>{status.canonicalRootReady ? "CS-CEO 정본 감지" : "CS-CEO 정본 없음"}</ReadyBadge>
                    : <>
                      <ReadyBadge ready={!!status.project}>{status.project ? "DEV 프로젝트 기억 검증" : "프로젝트 선택 필요"}</ReadyBadge>
                      <ReadyBadge ready={status.serviceMemoryStatus.ready}>{status.serviceMemoryStatus.ready ? "USE 운영기억 준비" : "USE 운영기억 미생성"}</ReadyBadge>
                    </>}
                  {status.runtimes.map(candidate => <ReadyBadge key={candidate.id} ready={candidate.installed && candidate.configurationState !== "needs-model"}>{candidate.label} {!candidate.installed ? "미감지" : candidate.configurationState === "needs-model" ? "모델 설정 필요" : "사용 가능"}</ReadyBadge>)}
                  <button type="button" onClick={() => void refresh()} disabled={loading || opening} className="ml-auto inline-flex min-h-9 items-center gap-1 rounded-md border border-white/10 px-2 text-[10px] text-zinc-400 hover:text-zinc-100 disabled:opacity-40"><RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} />다시 확인</button>
                </div>
                {status.canonicalProblem && <p className="mb-0 mt-2 text-[10px] text-amber-300">{status.canonicalProblem}</p>}
                {scope === "service" && status.serviceMemoryStatus.problem && <p className="mb-0 mt-2 text-[10px] text-amber-300">{status.serviceMemoryStatus.problem}</p>}
                {selectedRuntime?.configurationProblem && <p className="mb-0 mt-2 text-[10px] text-amber-300">{selectedRuntime.configurationProblem}</p>}
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block text-[11px] text-zinc-300">Agent 이름 · 단말명 포함
                  <input value={agentName} onChange={event => { agentNameTouchedRef.current = true; setAgentName(event.target.value); }} maxLength={64} className="mt-1 min-h-11 w-full rounded-lg border border-white/10 bg-black/25 px-3 py-2 text-xs text-zinc-100 outline-none focus:border-teal-300/40" />
                </label>
                <label className="block text-[11px] text-zinc-300">첫 실행기
                  <select data-testid="buzz-agent-runtime" value={runtime} onChange={event => { agentNameTouchedRef.current = false; setRuntime(event.target.value as BuzzAgentRuntime); }} className="mt-1 min-h-11 w-full rounded-lg border border-white/10 bg-black/25 px-3 py-2 text-xs text-zinc-100 outline-none focus:border-teal-300/40">
                    {status.runtimes.map(candidate => <option key={candidate.id} value={candidate.id} disabled={!candidate.installed}>{candidate.label}{candidate.installed ? "" : " · 미감지"}</option>)}
                  </select>
                </label>
              </div>

              {scope === "service" ? (
                <div className="space-y-3 rounded-xl border border-violet-300/15 bg-violet-300/[0.035] p-3">
                  <div>
                    <div className="flex items-center gap-1.5 text-[11px] font-semibold text-violet-200"><FolderCheck className="h-3.5 w-3.5" />DEV 프로젝트 기억 · 기존 계보 보존</div>
                    <code className={`mt-2 block break-all text-[10px] ${status.project?.canonicalPath ? "text-zinc-300" : "text-amber-300"}`}>{status.project?.canonicalPath || "프로젝트 확인 필요"}</code>
                    {status.project && <div className="mt-1 break-all text-[10px] text-zinc-500">DEV memory ID: {status.project.memoryId}</div>}
                    <p className="mb-0 mt-1 text-[10px] leading-4 text-zinc-500">소스·Git·배포·제품 개선은 DEV 채널의 CS-CEO가 담당합니다. USE Agent는 이 영역을 수정하지 않습니다.</p>
                  </div>

                  <div className="border-t border-white/[0.07] pt-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <div className="text-[11px] font-semibold text-teal-200">USE 운영기억 · 플랫폼 공용</div>
                      <span className={`rounded-full border px-2 py-0.5 text-[10px] ${status.serviceMemoryStatus.ready ? "border-emerald-300/20 text-emerald-200" : "border-amber-300/20 text-amber-200"}`}>{status.serviceMemoryStatus.ready ? "준비됨" : "아직 없음"}</span>
                    </div>
                    {status.serviceMemory ? <>
                      <code className="mt-2 block break-all text-[10px] text-zinc-300">{status.serviceMemory.sourcePath}</code>
                      <div className="mt-1 break-all text-[10px] text-zinc-500">USE memory ID: {status.serviceMemory.serviceMemoryId}</div>
                    </> : <p className="mb-0 mt-2 text-[10px] leading-4 text-zinc-400">서비스 Agent를 실제로 만들 때만 별도 운영기억을 생성합니다. 기존 DEV 기억 ID는 바꾸지 않습니다.</p>}
                    <p className="mb-0 mt-2 text-[10px] leading-4 text-zinc-500">Buzz·Hermes·Telegram의 같은 서비스 페르소나는 이 기억 하나를 공유합니다. ID는 DEV 기억 기준이라 단말이 달라도 같지만, 현재 내용은 각 단말의 로컬 정본이며 원격 동기화는 아직 지원하지 않습니다.</p>
                    <button
                      data-testid="buzz-service-memory-ensure"
                      type="button"
                      onClick={() => void ensureUseMemory()}
                      disabled={!status.project || status.serviceMemoryStatus.ready || ensuringServiceMemory}
                      className="mt-3 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-lg border border-teal-300/25 bg-teal-300/[0.08] px-3 py-2 text-xs font-semibold text-teal-100 hover:bg-teal-300/15 disabled:opacity-50"
                    >
                      {ensuringServiceMemory ? <Loader2 className="h-4 w-4 animate-spin" /> : status.serviceMemoryStatus.ready ? <Check className="h-4 w-4" /> : <FolderCheck className="h-4 w-4" />}
                      {ensuringServiceMemory ? "USE 운영기억 만드는 중…" : status.serviceMemoryStatus.ready ? "USE 운영기억 준비됨" : "USE 운영기억 만들기"}
                    </button>
                  </div>

                  {status.control && (
                    <div data-testid="agentstoz-use-control-capabilities" className="border-t border-white/[0.07] pt-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <div className="text-[11px] font-semibold text-cyan-200">AgentsToZ 로컬 제어 · 안전한 앱 작업</div>
                        <span className="rounded-full border border-cyan-300/20 bg-cyan-300/[0.05] px-2 py-0.5 text-[10px] text-cyan-200">USE control</span>
                      </div>
                      <p className="mb-0 mt-2 text-[10px] leading-4 text-zinc-400">Buzz 대화에서 작업 루트를 고른 새 프로젝트 생성·등록, 현재 수동 채널과 등록 프로젝트 연결, GitHub 생성, 등록 프로젝트 조회, AgentsToZ 화면 열기, Codex·Claude·Hermes로 프로젝트 열기, 연결된 DEV 채널의 Buzz 앱 열기를 요청할 수 있습니다. 새 프로젝트를 만들 때는 GitHub도 만들지와 Private/Public을 먼저 확인합니다.</p>
                      <p className="mb-0 mt-1 text-[10px] leading-4 text-zinc-500">폴더 경로·셸 명령은 받지 않습니다. 새 프로젝트의 Git·장기기억 초기화, 현재 Buzz 채널의 등록 프로젝트 연결, 사용자가 Private/Public을 명시한 GitHub 저장소 생성은 앱의 제한형 절차로 수행하지만, 임의 Git 작업·채널 생성·해제·삭제·빌드·배포·소스 수정은 허용하지 않습니다. Codex의 전체 접근 권한을 켜지 않고, 고정된 9개 MCP 도구만 이 단말의 로컬 sidecar에 연결합니다.</p>
                      <div className="mt-2 flex items-center justify-between gap-2 rounded-lg border border-white/[0.07] bg-black/20 px-3 py-2">
                        <span className="text-[10px] text-zinc-400">Codex 제한형 제어 도구</span>
                        <span className={`rounded-full border px-2 py-0.5 text-[10px] ${status.control.codexMcp.ready ? "border-emerald-300/20 text-emerald-200" : "border-amber-300/20 text-amber-200"}`}>{status.control.codexMcp.ready ? "연결됨" : "연결 필요"}</span>
                      </div>
                      {status.control.codexMcp.problem && <p className="mb-0 mt-1 text-[10px] leading-4 text-amber-200/80">{status.control.codexMcp.problem}</p>}
                      <button
                        data-testid="agentstoz-use-install-codex-control"
                        type="button"
                        onClick={() => void installCodexControl()}
                        disabled={status.control.codexMcp.ready || installingCodexControl || !status.control.codexMcp.executablePath}
                        className="mt-2 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-lg border border-cyan-300/25 bg-cyan-300/[0.08] px-3 py-2 text-xs font-semibold text-cyan-100 hover:bg-cyan-300/15 disabled:opacity-50"
                      >
                        {installingCodexControl ? <Loader2 className="h-4 w-4 animate-spin" /> : status.control.codexMcp.ready ? <Check className="h-4 w-4" /> : <ShieldCheck className="h-4 w-4" />}
                        {installingCodexControl ? "Codex 제어 도구 연결 중…" : status.control.codexMcp.ready ? "Codex 제어 도구 연결됨" : "Codex 제어 도구 연결"}
                      </button>
                    </div>
                  )}

                  <div className="border-t border-white/[0.07] pt-3">
                    <div className="text-[11px] font-semibold text-violet-200">System prompt</div>
                    <textarea readOnly value={instructions} aria-label="Buzz USE 서비스 Agent system prompt" placeholder="USE 운영기억을 만든 뒤 안전 경계가 포함된 설정이 준비됩니다." className="mt-2 h-44 w-full resize-y rounded-lg border border-white/10 bg-black/30 p-3 font-mono text-[10px] leading-4 text-zinc-300 outline-none placeholder:text-zinc-600" />
                  </div>
                </div>
              ) : (
                <div className="rounded-xl border border-violet-300/15 bg-violet-300/[0.035] p-3">
                  <div className="flex items-center gap-1.5 text-[11px] font-semibold text-violet-200"><FolderCheck className="h-3.5 w-3.5" />정본 CS-CEO bootstrap repository</div>
                  <code className={`mt-2 block break-all text-[10px] ${status.canonicalRoot ? "text-zinc-300" : "text-amber-300"}`}>{status.canonicalRoot || "정본 폴더 확인 필요"}</code>
                  <div className="mt-3 text-[11px] font-semibold text-violet-200">System prompt</div>
                  <textarea readOnly value={instructions} aria-label="Buzz 범용 CS-CEO system prompt" className="mt-2 h-44 w-full resize-y rounded-lg border border-white/10 bg-black/30 p-3 font-mono text-[10px] leading-4 text-zinc-300 outline-none" />
                </div>
              )}

              <div className="rounded-xl border border-amber-300/15 bg-amber-300/[0.035] p-3 text-[10px] leading-4 text-amber-100/90">
                Buzz CLI는 최초 Agent를 직접 저장하지 않습니다. 아래 버튼은 Buzz 앱을 열고 설정을 복사하며, Agents → New agent에서 이름·실행기·Agent instructions를 붙여 넣은 뒤 <strong>Buzz Desktop에서 최종 생성 승인</strong>해야 합니다. Buzz에는 현재 Agent별 working-directory 입력란이 없으므로 경로는 instructions가 절대경로와 로컬 연결표로 검증합니다. {scope === "service" ? "같은 서비스 Agent가 이미 있으면 중복 생성하지 마세요." : "기존 CS-CEO가 있으면 중복 생성하지 마세요."}
              </div>

              <div className="grid gap-2 sm:grid-cols-2">
                <button data-testid="buzz-agent-copy-settings" type="button" onClick={() => void copySettings()} disabled={!canPrepare} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-violet-300/25 bg-violet-300/[0.07] px-3 py-2 text-xs font-medium text-violet-100 hover:bg-violet-300/10 disabled:opacity-40">{copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}{copied ? "설정 복사됨" : "생성 설정 복사"}</button>
                <button data-testid="buzz-agent-open-desktop" type="button" onClick={() => void openBuzzDesktop()} disabled={!status.appInstalled || opening} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-teal-300/25 bg-teal-300/10 px-3 py-2 text-xs font-semibold text-teal-100 hover:bg-teal-300/15 disabled:opacity-40">{opening ? <Loader2 className="h-4 w-4 animate-spin" /> : <ExternalLink className="h-4 w-4" />}{opening ? "Buzz 여는 중…" : "Buzz Agent 생성 화면 열기"}</button>
              </div>

              <div className="flex items-start gap-2 rounded-lg border border-emerald-300/10 bg-emerald-300/[0.025] px-3 py-2 text-[10px] leading-4 text-zinc-400"><ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-300" />AgentsToZ는 Buzz 비밀키나 Agent 인증정보를 받거나 저장하지 않습니다. 생성 후 채널에서 이 Agent를 추가·제거하는 작업은 Buzz가 관리합니다.</div>
            </>
          )}

          {error && <div role="alert" aria-live="assertive" className="flex items-start gap-2 rounded-lg border border-red-300/15 bg-red-300/[0.05] px-3 py-2 text-[11px] text-red-200"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />{error}</div>}
        </div>
      </div>
    </div>,
    document.body,
  );
}

export default BuzzAgentSetupDialog;
