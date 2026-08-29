import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  Link2,
  Loader2,
  MessageSquarePlus,
  RefreshCw,
  Unlink,
  X,
} from "lucide-react";
import { isTauri } from "./lib/env";
import { DEFAULT_BUZZ_RELAY_URL, isBuzzChannelId } from "./buzzProjectContract";

type BuzzBinding = {
  relayUrl: string;
  channelId: string;
  channelName: string | null;
  verified: boolean;
  verifiedAt: string | null;
  boundAt: string;
  updatedAt: string;
};

type BuzzStatus = {
  success: true;
  project: {
    projectId: string;
    projectName: string;
    canonicalPath: string;
    memoryId: string;
  };
  binding: BuzzBinding | null;
  settings: {
    version: 1;
    relayUrl: string;
    updatedAt: string | null;
  };
  runtime: {
    appInstalled: boolean;
    appPath: string | null;
    cliInstalled: boolean;
    cliPath: string | null;
    relayUrl: string;
    relayReachable: boolean;
    cliAuthenticated: boolean | null;
    channelCount: number | null;
    problemCode: string | null;
    problem: string | null;
  };
  projectContext: {
    memorySkillsReady: boolean;
  };
};

type BuzzApiResult = {
  success?: boolean;
  code?: string;
  error?: string;
  message?: string;
  verified?: boolean;
  verificationProblem?: { code: string; message: string } | null;
  created?: boolean;
  reused?: boolean;
  settings?: BuzzStatus["settings"];
};

export interface BuzzProjectDialogProps {
  portId: string;
  projectName: string;
  onOpenUseSetup: () => void;
  onClose: () => void;
  onToast: (message: string, type?: "success" | "error" | "warning") => void;
}

const apiBase = () => isTauri() ? "http://127.0.0.1:3001" : "";

async function buzzPost<T extends BuzzApiResult | BuzzStatus>(action: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${apiBase()}/api/buzz-project/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({})) as T;
  if (!response.ok || result.success !== true) {
    const error = new Error((result as BuzzApiResult).error || `Buzz ${action} 요청 실패`) as Error & { code?: string };
    error.code = (result as BuzzApiResult).code;
    throw error;
  }
  return result;
}

function StatusDot({ ok, label }: { ok: boolean | null; label: string }) {
  const color = ok === true ? "text-emerald-300 border-emerald-400/25 bg-emerald-400/8"
    : ok === false ? "text-amber-300 border-amber-400/25 bg-amber-400/8"
      : "text-zinc-400 border-white/10 bg-white/[0.03]";
  return (
    <span className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[10px] ${color}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${ok === true ? "bg-emerald-300" : ok === false ? "bg-amber-300" : "bg-zinc-500"}`} />
      {label}
    </span>
  );
}

export function BuzzProjectDialog({ portId, projectName, onOpenUseSetup, onClose, onToast }: BuzzProjectDialogProps) {
  const [status, setStatus] = useState<BuzzStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<"create" | "link">("create");
  const [channelPurpose, setChannelPurpose] = useState<"dev" | "use">("dev");
  const [relayUrl, setRelayUrl] = useState(DEFAULT_BUZZ_RELAY_URL);
  const [channelName, setChannelName] = useState(projectName);
  const [channelId, setChannelId] = useState("");
  const [allowUnverified, setAllowUnverified] = useState(false);
  const [confirmUnlink, setConfirmUnlink] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const channelIdValid = useMemo(() => isBuzzChannelId(channelId), [channelId]);

  const refresh = useCallback(async (relayOverride?: string) => {
    setLoading(true);
    setError(null);
    try {
      const next = await buzzPost<BuzzStatus>("status", {
        portId,
        ...(relayOverride ? { relayUrl: relayOverride } : {}),
      });
      setStatus(next);
      setRelayUrl(current => next.binding?.relayUrl ?? next.settings.relayUrl ?? next.runtime.relayUrl ?? current);
      setChannelName(current => next.binding?.channelName ?? (current || projectName));
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setLoading(false);
    }
  }, [portId, projectName]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusTimer = window.setTimeout(() => closeButtonRef.current?.focus(), 0);
    return () => {
      window.clearTimeout(focusTimer);
      previousFocusRef.current?.focus();
    };
  }, []);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
      )).filter(element => !element.hasAttribute("hidden"));
      if (focusable.length === 0) return;
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
  }, [busy, onClose]);
  useEffect(() => {
    if (error) errorRef.current?.scrollIntoView({ block: "nearest" });
  }, [error]);

  const run = async (action: "create" | "link" | "open" | "unlink") => {
    setBusy(action);
    setError(null);
    try {
      if (action === "create") {
        const result = await buzzPost<BuzzApiResult>("create", { portId, relayUrl, channelName });
        onToast(result.reused ? "기존 Buzz 채널을 프로젝트에 연결했습니다." : "Buzz 채널을 만들고 프로젝트에 연결했습니다.", "success");
      } else if (action === "link") {
        const result = await buzzPost<BuzzApiResult>("link", {
          portId,
          relayUrl,
          channelId,
          channelName,
          allowUnverified,
        });
        onToast(
          result.verified
            ? "Buzz 채널을 확인하고 프로젝트에 연결했습니다."
            : `Buzz 채널을 미검증 상태로 연결했습니다.${result.verificationProblem?.message ? ` ${result.verificationProblem.message}` : ""}`,
          result.verified ? "success" : "warning",
        );
      } else if (action === "open") {
        const result = await buzzPost<BuzzApiResult>("open", { portId });
        onToast(result.message || "Buzz 앱을 열었습니다.", "success");
      } else {
        const result = await buzzPost<BuzzApiResult>("unlink", { portId });
        onToast(result.message || "Buzz 연결을 해제했습니다.", "success");
      }
      if (action !== "open") await refresh(relayUrl);
    } catch (nextError) {
      const message = nextError instanceof Error ? nextError.message : String(nextError);
      setError(message);
      onToast(message, "error");
    } finally {
      setBusy(null);
    }
  };

  const saveRelay = async () => {
    setBusy("settings");
    setError(null);
    try {
      const result = await buzzPost<BuzzApiResult>("settings", { portId, relayUrl });
      if (result.settings) setRelayUrl(result.settings.relayUrl);
      onToast("이 단말의 Buzz relay 기본값을 저장했습니다.", "success");
      await refresh(result.settings?.relayUrl ?? relayUrl);
    } catch (nextError) {
      const message = nextError instanceof Error ? nextError.message : String(nextError);
      setError(message);
      onToast(message, "error");
    } finally {
      setBusy(null);
    }
  };

  const content = (
    <div className="fixed inset-0 z-[10080] flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label={`${projectName} Buzz 채널 연결`} className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-cyan-300/15 bg-[#101014] shadow-2xl shadow-black/60">
        <div className="sticky top-0 z-10 flex items-start justify-between border-b border-white/[0.07] bg-[#101014]/95 px-5 py-4 backdrop-blur">
          <div className="flex min-w-0 items-start gap-3">
            <div className="rounded-xl border border-cyan-300/20 bg-cyan-300/10 p-2.5 text-cyan-200"><MessageSquarePlus className="h-5 w-5" /></div>
            <div className="min-w-0">
              <h2 className="m-0 truncate text-base font-semibold text-zinc-100">Buzz 채널로 열기</h2>
              <p className="mt-1 truncate text-xs text-zinc-400">{projectName}</p>
            </div>
          </div>
          <button ref={closeButtonRef} type="button" onClick={onClose} disabled={!!busy} aria-label="닫기" className="min-h-11 min-w-11 rounded-lg p-2 text-zinc-400 hover:bg-white/5 hover:text-zinc-200 disabled:opacity-40"><X className="h-4 w-4" /></button>
        </div>

        <div className="space-y-4 p-5">
          <div className="rounded-xl border border-cyan-300/15 bg-cyan-300/[0.045] px-4 py-3 text-xs leading-5 text-zinc-300">
            <strong className="text-cyan-200">로컬 앱 연동</strong> · Hostinger 없이 로컬 Buzz 앱을 쓰되, 이 단말의 localhost relay 또는 Buzz hosted community와 프로젝트 장기기억을 연결합니다. 채널은 대화 공간이고, 실제 작업 기준은 아래 프로젝트 폴더와 memory ID입니다.
          </div>

          <div role="radiogroup" aria-label="Buzz 채널 목적" className="grid grid-cols-2 gap-1 rounded-xl border border-white/[0.07] bg-black/25 p-1">
            <button data-testid="buzz-purpose-dev" role="radio" aria-checked={channelPurpose === "dev"} type="button" onClick={() => setChannelPurpose("dev")} className={`min-h-11 rounded-lg px-3 py-2 text-xs ${channelPurpose === "dev" ? "bg-cyan-300/12 text-cyan-100" : "text-zinc-400 hover:text-zinc-200"}`}>DEV · 프로젝트 개선</button>
            <button data-testid="buzz-purpose-use" role="radio" aria-checked={channelPurpose === "use"} type="button" onClick={() => setChannelPurpose("use")} className={`min-h-11 rounded-lg px-3 py-2 text-xs ${channelPurpose === "use" ? "bg-violet-300/12 text-violet-100" : "text-zinc-400 hover:text-zinc-200"}`}>USE · 앱 기능 사용</button>
          </div>

          {channelPurpose === "use" ? (
            <div className="space-y-3 rounded-xl border border-violet-300/15 bg-violet-300/[0.035] p-4">
              <div>
                <p className="m-0 text-sm font-medium text-violet-100">USE 운영 채널 준비</p>
                <p className="mb-0 mt-2 text-[11px] leading-5 text-zinc-400">소스 개선이 아니라 장기기억 조회·앱 실행·프로젝트 추가·등록 프로젝트 GitHub 연결처럼 이미 만들어진 AgentsToZ 기능을 대화로 사용합니다. DEV 프로젝트 기억은 계보 기준으로만 읽고, 운영 대화는 별도 USE 기억에 저장합니다.</p>
              </div>
              <button data-testid="buzz-open-use-setup" type="button" onClick={onOpenUseSetup} className="inline-flex min-h-11 w-full items-center justify-center gap-1.5 rounded-lg border border-violet-300/25 bg-violet-300/10 px-3 py-2.5 text-xs font-semibold text-violet-100 hover:bg-violet-300/15"><ExternalLink className="h-4 w-4" />USE Agent·운영기억 준비</button>
              <p className="m-0 text-[10px] leading-4 text-zinc-500">프로젝트 자체를 DEV/USE 중 하나로 고정하지 않습니다. 같은 프로젝트도 채널 목적에 따라 DEV와 USE를 각각 만들 수 있습니다.</p>
            </div>
          ) : <>

          {loading && !status ? (
            <div className="flex items-center justify-center gap-2 py-12 text-sm text-zinc-400"><Loader2 className="h-4 w-4 animate-spin" />로컬 Buzz 상태 확인 중…</div>
          ) : (
            <>
              {status && (
                <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-3">
                  <div className="flex flex-wrap gap-2">
                    <StatusDot ok={status.runtime.appInstalled} label={status.runtime.appInstalled ? "Buzz 앱 감지" : "Buzz 앱 없음"} />
                    <StatusDot ok={status.runtime.relayReachable} label={status.runtime.relayReachable ? "relay 연결됨" : "relay 꺼짐"} />
                    <StatusDot ok={status.runtime.cliInstalled} label={status.runtime.cliInstalled ? "CLI 감지" : "CLI 없음"} />
                    <StatusDot ok={status.runtime.cliAuthenticated} label={status.runtime.cliAuthenticated === true ? "CLI 인증됨" : status.runtime.cliAuthenticated === false ? "CLI 인증 필요" : "CLI 인증 미확인"} />
                    <button type="button" onClick={() => void refresh(relayUrl)} disabled={loading || !!busy} className="ml-auto inline-flex items-center gap-1 rounded-md border border-white/10 px-2 py-1 text-[10px] text-zinc-400 hover:text-zinc-100 disabled:opacity-40"><RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} />다시 확인</button>
                  </div>
                  {status.runtime.problem && <p className="mb-0 mt-2 text-[10px] leading-4 text-amber-300/90">{status.runtime.problem}</p>}
                  {!status.runtime.appInstalled && (
                    <a href="https://github.com/block/buzz/releases" target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 text-[11px] text-cyan-300 hover:text-cyan-200">Buzz 공식 릴리스 열기 <ExternalLink className="h-3 w-3" /></a>
                  )}
                </div>
              )}

              {status?.binding ? (
                <div className="space-y-3 rounded-xl border border-emerald-300/15 bg-emerald-300/[0.035] p-4">
                  <div className="flex items-start gap-2">
                    {status.binding.verified ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-300" /> : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />}
                    <div className="min-w-0">
                      <p className="m-0 text-sm font-medium text-zinc-100">{status.binding.channelName ? `#${status.binding.channelName}` : "연결된 Buzz 채널"}</p>
                      <p className="mt-1 break-all font-mono text-[10px] text-zinc-500">{status.binding.channelId}</p>
                      <p className="mt-1 break-all font-mono text-[10px] text-zinc-500">{status.binding.relayUrl}</p>
                      {!status.binding.verified && <p className="mt-2 text-[10px] text-amber-300/90">이 연결은 CLI로 채널 존재를 확인하지 못한 미검증 상태입니다.</p>}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button data-testid="buzz-open-app" type="button" onClick={() => void run("open")} disabled={!!busy} className="inline-flex items-center gap-1.5 rounded-lg border border-cyan-300/25 bg-cyan-300/10 px-3 py-2 text-xs font-medium text-cyan-200 hover:bg-cyan-300/15 disabled:opacity-40"><ExternalLink className="h-3.5 w-3.5" />{busy === "open" ? "여는 중…" : "Buzz 열기"}</button>
                    <button
                      data-testid="buzz-unlink-channel"
                      type="button"
                      onClick={() => {
                        if (!confirmUnlink) setConfirmUnlink(true);
                        else void run("unlink");
                      }}
                      disabled={!!busy}
                      className={`inline-flex min-h-11 items-center gap-1.5 rounded-lg border px-3 py-2 text-xs disabled:opacity-40 ${confirmUnlink ? "border-red-300/30 bg-red-300/[0.07] text-red-200" : "border-white/10 text-zinc-400 hover:border-red-300/20 hover:text-red-300"}`}
                    >
                      <Unlink className="h-3.5 w-3.5" />{confirmUnlink ? "다시 눌러 연결 해제" : "연결만 해제"}
                    </button>
                  </div>
                  <p className="m-0 text-[10px] leading-4 text-zinc-500">정확한 채널 화면으로 이동하는 공식 링크는 아직 없어 Buzz 앱을 연 뒤 위 채널을 선택합니다. 연결 해제는 Buzz 채널을 삭제하지 않습니다.</p>
                </div>
              ) : (
                <div className="space-y-3 rounded-xl border border-white/[0.07] bg-white/[0.02] p-4">
                  <div role="tablist" aria-label="Buzz 채널 연결 방식" className="grid grid-cols-2 gap-1 rounded-lg bg-black/25 p-1">
                    <button role="tab" aria-selected={mode === "create"} type="button" onClick={() => setMode("create")} className={`min-h-11 rounded-md px-3 py-2 text-xs ${mode === "create" ? "bg-cyan-300/12 text-cyan-200" : "text-zinc-400 hover:text-zinc-200"}`}>새 채널</button>
                    <button role="tab" aria-selected={mode === "link"} type="button" onClick={() => setMode("link")} className={`min-h-11 rounded-md px-3 py-2 text-xs ${mode === "link" ? "bg-cyan-300/12 text-cyan-200" : "text-zinc-400 hover:text-zinc-200"}`}>기존 채널 연결</button>
                  </div>
                  <div>
                    <label className="block text-[11px] text-zinc-300" htmlFor="buzz-relay-url">Buzz relay URL</label>
                    <div className="mt-1 flex gap-2">
                      <input id="buzz-relay-url" value={relayUrl} onChange={event => setRelayUrl(event.target.value)} spellCheck={false} className="min-h-11 min-w-0 flex-1 rounded-lg border border-white/10 bg-black/25 px-3 py-2 font-mono text-xs text-zinc-200 outline-none focus:border-cyan-300/35" />
                      <button type="button" onClick={() => void saveRelay()} disabled={!!busy || !relayUrl.trim()} className="min-h-11 shrink-0 rounded-lg border border-white/10 px-3 text-xs text-zinc-300 hover:text-white disabled:opacity-40">기본값 저장</button>
                    </div>
                    <p className="mb-0 mt-1 text-[10px] leading-4 text-zinc-400">localhost와 hosted community를 모두 지원합니다. 비밀키는 URL에 넣지 않습니다.</p>
                  </div>
                  {mode === "create" ? (
                    <>
                      <label className="block text-[11px] text-zinc-400">채널 이름
                        <input value={channelName} onChange={event => setChannelName(event.target.value)} maxLength={64} className="mt-1 w-full rounded-lg border border-white/10 bg-black/25 px-3 py-2 text-xs text-zinc-200 outline-none focus:border-cyan-300/35" />
                      </label>
                      <p className="m-0 text-[10px] leading-4 text-zinc-500">새 채널 생성·동명이면 재사용하려면 로컬 relay와 인증된 Buzz CLI가 필요합니다. 비밀키는 이 화면에서 받거나 저장하지 않습니다.</p>
                      <button data-testid="buzz-create-channel" type="button" onClick={() => void run("create")} disabled={!!busy || !channelName.trim()} className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-cyan-300/25 bg-cyan-300/10 px-3 py-2.5 text-xs font-semibold text-cyan-100 hover:bg-cyan-300/15 disabled:opacity-40"><MessageSquarePlus className="h-4 w-4" />{busy === "create" ? "채널 확인 중…" : "새 채널 만들고 연결"}</button>
                    </>
                  ) : (
                    <>
                      <label className="block text-[11px] text-zinc-300">Buzz channel UUID
                        <input value={channelId} onChange={event => setChannelId(event.target.value)} placeholder="00000000-0000-4000-8000-000000000000" spellCheck={false} aria-invalid={channelId.length > 0 && !channelIdValid} aria-describedby="buzz-channel-id-help" className="mt-1 min-h-11 w-full rounded-lg border border-white/10 bg-black/25 px-3 py-2 font-mono text-xs text-zinc-200 outline-none focus:border-cyan-300/35" />
                      </label>
                      <p id="buzz-channel-id-help" className={`m-0 text-[10px] leading-4 ${channelId.length > 0 && !channelIdValid ? "text-red-200" : "text-zinc-400"}`} aria-live="polite">{channelId.length > 0 && !channelIdValid ? "유효한 Buzz channel UUID를 입력하세요." : "Buzz 채널 정보에서 UUID를 복사해 입력합니다."}</p>
                      <label className="block text-[11px] text-zinc-400">표시 이름 <span className="text-zinc-600">(선택)</span>
                        <input value={channelName} onChange={event => setChannelName(event.target.value)} maxLength={64} className="mt-1 w-full rounded-lg border border-white/10 bg-black/25 px-3 py-2 text-xs text-zinc-200 outline-none focus:border-cyan-300/35" />
                      </label>
                      <p className="m-0 text-[10px] leading-4 text-zinc-400">CLI 인증이 있으면 실제 채널을 확인합니다. 인증이 없거나 relay가 꺼져 있으면 아래 확인 없이는 연결하지 않습니다.</p>
                      <label className="flex min-h-11 items-center gap-2 rounded-lg border border-amber-300/15 bg-amber-300/[0.04] px-3 py-2 text-[10px] leading-4 text-amber-100">
                        <input type="checkbox" checked={allowUnverified} onChange={event => setAllowUnverified(event.target.checked)} className="h-4 w-4 shrink-0" />
                        확인할 수 없는 경우에도 이 UUID를 미검증 상태로 연결 허용
                      </label>
                      <button data-testid="buzz-link-channel" type="button" onClick={() => void run("link")} disabled={!!busy || !channelIdValid} className="inline-flex min-h-11 w-full items-center justify-center gap-1.5 rounded-lg border border-cyan-300/25 bg-cyan-300/10 px-3 py-2.5 text-xs font-semibold text-cyan-100 hover:bg-cyan-300/15 disabled:opacity-40"><Link2 className="h-4 w-4" />{busy === "link" ? "채널 연결 중…" : "기존 채널 연결"}</button>
                    </>
                  )}
                  <button data-testid="buzz-open-app" type="button" onClick={() => void run("open")} disabled={!!busy} className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-white/10 px-3 py-2 text-xs text-zinc-400 hover:text-zinc-100 disabled:opacity-40"><ExternalLink className="h-3.5 w-3.5" />Buzz 앱 먼저 열기</button>
                </div>
              )}

              {status && (
                <div className="rounded-xl border border-violet-300/10 bg-violet-300/[0.025] p-3 text-[10px] leading-4 text-zinc-500">
                  <div className="flex items-center gap-1.5 text-violet-200"><CheckCircle2 className="h-3.5 w-3.5" />프로젝트 컨텍스트</div>
                  <p className="mb-0 mt-2 break-all font-mono">working directory: {status.project.canonicalPath}</p>
                  <p className="mb-0 mt-1 break-all font-mono">memory ID: {status.project.memoryId}</p>
                  <p className="mb-0 mt-2">{status.projectContext.memorySkillsReady ? "프로젝트 장기기억·remember-session 스킬이 준비되어 있습니다." : "프로젝트 로컬 장기기억 스킬을 먼저 업데이트해야 합니다."} 이 채널에 추가된 범용 CS-CEO는 현재 channel UUID로 이 단말의 연결을 조회해 위 폴더를 작업 대상으로 사용합니다.</p>
                </div>
              )}
            </>
          )}
          </>}

          {error && <div ref={errorRef} role="alert" aria-live="assertive" className="flex items-start gap-2 rounded-lg border border-red-300/15 bg-red-300/[0.05] px-3 py-2 text-[11px] leading-4 text-red-200"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />{error}</div>}
        </div>
      </div>
    </div>
  );

  return createPortal(content, document.body);
}

export default BuzzProjectDialog;
