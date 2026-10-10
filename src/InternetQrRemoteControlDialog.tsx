import './InternetQrRemoteControlDialog.css';
import {RemoteConnectionLabel,connectionDisplayName,internetConnectionLabelKey} from './RemoteConnectionLabel';
import {terminalLocalRequest} from './aiTerminalClient';
import {AI_TERMINAL_PREFIX} from './aiTerminalProtocol';
import {AgentRuntimeClient} from './agentRuntimeClient';
import {approveInternetSessionWithWorkroom} from './internetRemoteWorkroomApproval';
import {ALL_WORKROOM_TARGETS,workroomApprovalScope,workroomApprovalOptions} from './workroomApprovalScope';
import {MOBILE_WORKSPACE_SCOPE_LABELS,type MobileWorkspaceScope} from './mobileWorkspaceProtocol';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CheckCircle2,
  Cloud,
  Globe2,
  KeyRound,
  Loader2,
  QrCode,
  RefreshCw,
  ShieldCheck,
  Smartphone,
  Unplug,
  X,
} from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import {
  formatInternetRemoteControlRemaining,
  isInternetRemoteControlExpired,
  normalizeInternetRemoteControllerOrigin,
  type InternetRemoteControlPairingIssue,
  type InternetRemoteControlSession,
  type InternetRemoteControlState,
  type InternetRemoteControlStatus,
} from './internetRemoteControlContract';
import { internetRemoteStatusView, isInternetRemotePairingClaimed } from './internetRemoteControlPairingState';
import { REMOTE_CONTROL_MAX_SESSIONS } from './remoteControlProtocol';
import { AGENT_RUNTIME_MANAGED_EXECUTION_ENABLED } from './agentRuntimeProtocol';
import { parseRemoteControlRelayPairingUrl } from './remoteControlRelayContract';
import { buildPhoneConnectLink, type PhoneConnectLinkText } from './phoneConnectLink';
import { PhoneConnectLinkBox } from './PhoneConnectLinkBox';
import { DEFAULT_REMOTE_CONTROLLER_ORIGIN, isDefaultRemoteControllerOrigin } from './defaultRemoteControllerOrigin';
import { WEB_APP_OPTIONAL_TITLE } from './appFirstOnboarding';
import {
  internetRemoteControlApi,
  type InternetRemoteControlApi,
} from './internetRemoteControlClient';

export interface InternetQrRemoteControlDialogProps {
  open: boolean;
  onClose: () => void;
  onOpenWorkroom?: () => void;
  api?: InternetRemoteControlApi;
  /** Previously verified personal Vercel origin. Never persisted by this dialog. */
  defaultControllerOrigin?: string | null;
  /** This Mac's display name, put in the phone connect link as a label only. */
  hostLabel?: string | null;
}

type BusyAction = 'refresh' | 'enable' | 'issue' | 'approve' | 'scopes' | 'revoke' | 'disable' | null;
type Notice = { kind: 'success' | 'error'; message: string } | null;
type SessionScopeDraft = { task: boolean; conversation: boolean };
type WorkroomConnection = { id: string; allowed: boolean; durable?: boolean; expiresAt?: string | null; workspaceScopes?:MobileWorkspaceScope[] };
type PendingWorkroomGrant = {scope:string;workspaceScopes:MobileWorkspaceScope[]};
const mobileFeatureScopes = ['voice.use','records.read','memory.save','duty.manage','worktree.manage'] as const satisfies readonly MobileWorkspaceScope[];

function MobileFeatureSelection({ selected, disabled, onChange, connectionLabel }: {
  selected: readonly MobileWorkspaceScope[];
  disabled: boolean;
  onChange: (scopes: MobileWorkspaceScope[]) => void;
  connectionLabel:string;
}) {
  const allSelected = mobileFeatureScopes.every(scope => selected.includes(scope));
  return <div className="internet-workroom-select-all">
    <button type="button" aria-label={`${connectionLabel} ${allSelected ? '기능 전체 선택 해제' : '기능 전체 선택'}`} disabled={disabled} onClick={() => onChange(allSelected ? [] : [...mobileFeatureScopes])}>
      {allSelected ? '전체 선택 해제' : '기능 전체 선택'}
    </button>
    <span>{mobileFeatureScopes.filter(scope => selected.includes(scope)).length}/{mobileFeatureScopes.length}개 선택 · 적용 전까지 저장되지 않습니다.</span>
  </div>;
}

const interactiveSelector = [
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'a[href]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

const readableError = (error: unknown): string => {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  if (typeof error === 'string' && error.trim()) return error.trim();
  if (error && typeof error === 'object') {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message.trim();
  }
  return '외부 인터넷 원격제어 요청을 완료하지 못했습니다.';
};

const readableTime = (value: string | null): string => {
  if (!value) return '아직 확인되지 않음';
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleString('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : '확인할 수 없음';
};

const stateLabels: Record<InternetRemoteControlState, string> = {
  disabled: '꺼짐',
  pairing: 'QR 연결 대기',
  'approval-required': 'Mac 승인 필요',
  online: '외부 인터넷 연결됨',
  degraded: '릴레이 연결 불안정',
  offline: '연결 대기',
};

const stateClasses: Record<InternetRemoteControlState, string> = {
  disabled: 'border-zinc-700 bg-zinc-900 text-zinc-400',
  pairing: 'border-sky-400/30 bg-sky-400/10 text-sky-200',
  'approval-required': 'border-amber-300/35 bg-amber-300/10 text-amber-100',
  online: 'border-teal-300/35 bg-teal-300/10 text-teal-100',
  degraded: 'border-red-300/35 bg-red-300/10 text-red-100',
  offline: 'border-zinc-600 bg-zinc-800/70 text-zinc-300',
};

function controllerOriginFromStatus(status: InternetRemoteControlStatus): string {
  if (!status.controllerUrl) return '';
  try {
    return new URL(status.controllerUrl).origin;
  } catch {
    return '';
  }
}

export function InternetQrRemoteControlDialog({
  open,
  onClose,
  onOpenWorkroom,
  api = internetRemoteControlApi,
  defaultControllerOrigin = null,
  hostLabel = null,
}: InternetQrRemoteControlDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  const busyRef = useRef<BusyAction>(null);
  const managementRevisionRef = useRef(0);
  const [status, setStatus] = useState<InternetRemoteControlStatus | null>(null);
  const [controllerOrigin, setControllerOrigin] = useState('');
  // The optional web-portal field opens by itself only when there is a portal to show.
  const [webAppOptionsOpen, setWebAppOptionsOpen] = useState(false);
  useEffect(() => { if (controllerOrigin.trim()) setWebAppOptionsOpen(true); }, [controllerOrigin]);
  const [pairing, setPairing] = useState<InternetRemoteControlPairingIssue | null>(null);
  // The URL fragment stays only in React memory. Its opaque pairing id lets a
  // status poll prove THIS QR was claimed; existing sessions and another still-
  // valid QR must not clear the newly issued one.
  const visiblePairingIdRef = useRef<string | null>(null);
  const [approvalCodes, setApprovalCodes] = useState<Record<string, string>>({});
  const [taskScopeApprovals, setTaskScopeApprovals] = useState<Record<string, boolean>>({});
  const [conversationScopeApprovals, setConversationScopeApprovals] = useState<Record<string, boolean>>({});
  const [workroomApprovals,setWorkroomApprovals]=useState<Record<string,boolean>>({});
  const [workroomScopes,setWorkroomScopes]=useState<Record<string,string>>({});
  const [workroomFeatureScopes,setWorkroomFeatureScopes]=useState<Record<string,MobileWorkspaceScope[]>>({});
  const [workroomOptions,setWorkroomOptions]=useState<{value:string;label:string}[]>([]);
  const [workroomOptionError,setWorkroomOptionError]=useState('');
  const [pendingWorkroom,setPendingWorkroom]=useState<Record<string,PendingWorkroomGrant>>({});
  const [workroomConnections, setWorkroomConnections] = useState<WorkroomConnection[] | null>(null);
  useEffect(()=>{
    if(!open){setWorkroomApprovals({});setWorkroomScopes({});setWorkroomFeatureScopes({});setWorkroomConnections(null);return;}
    setWorkroomOptions([]);
    let stopped=false;
    Promise.all([terminalLocalRequest(AI_TERMINAL_PREFIX+'/access',{}).then(access=>{if(!stopped)setWorkroomConnections(access.connections??[]);return access;}),new AgentRuntimeClient().targets()]).then(([access,inventory])=>{
      if(stopped)return;
      const approvalOptions=workroomApprovalOptions(inventory);
      setWorkroomOptions([...approvalOptions.options,...(access.workspaceRoots??[]).map((r:{workspaceRootId:string;name:string})=>({value:'root:'+r.workspaceRootId,label:r.name+' · 이 기기가 새로 만든 프로젝트'}))]);setWorkroomOptionError(approvalOptions.notice);
    }).catch(error=>{if(!stopped)setWorkroomOptionError(readableError(error));});
    return()=>{stopped=true};
  },[open]);
  const grantWorkroom=async(sessionId:string,scope:string,workspaceScopes=workroomFeatureScopes[sessionId]??[])=>{
    const result=await terminalLocalRequest(AI_TERMINAL_PREFIX+'/access',{owner:'internet:'+sessionId,enabled:true,rememberDevice:true,workspaceScopes,...workroomApprovalScope(scope,workroomOptions)});
    setWorkroomConnections(result.connections??[]);
    return result;
  };
  const setWorkroomFeatureScope=(sessionId:string,scope:MobileWorkspaceScope,enabled:boolean)=>setWorkroomFeatureScopes(current=>({
    ...current,
    [sessionId]:enabled?[...new Set([...(current[sessionId]??[]),scope])]:(current[sessionId]??[]).filter(value=>value!==scope),
  }));
  const [sessionScopeDrafts, setSessionScopeDrafts] = useState<Record<string, SessionScopeDraft>>({});
  const [riskAcknowledged, setRiskAcknowledged] = useState(false);
  const [busy, setBusyState] = useState<BusyAction>(null);
  const [initialLoading, setInitialLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [now, setNow] = useState(() => Date.now());

  const setBusy = useCallback((value: BusyAction) => {
    if (value) managementRevisionRef.current += 1;
    busyRef.current = value;
    setBusyState(value);
  }, []);

  const handleGrantAllApprovedFeatures = async (sessionId: string) => {
    if (busyRef.current) return;
    const scope = workroomScopes[sessionId];
    if (!scope || !workroomOptions.some(option => option.value === scope)) {
      setNotice({ kind: 'error', message: '먼저 이 기기에 허용할 프로젝트 또는 작업 폴더를 선택하세요.' });
      return;
    }
    setBusy('scopes');
    setNotice(null);
    try {
      // Pass the complete set directly. React has not committed a draft state
      // update yet, so reading workroomFeatureScopes here could save an old set.
      await grantWorkroom(sessionId, scope, [...mobileFeatureScopes]);
      setWorkroomFeatureScopes(current => ({ ...current, [sessionId]: [...mobileFeatureScopes] }));
      setNotice({ kind: 'success', message: '모바일 기능 5개를 한 번에 허용하고 저장했습니다. iPhone에서 음성 창을 다시 열어 주세요.' });
    } catch (error) {
      setNotice({ kind: 'error', message: readableError(error) });
    } finally {
      setBusy(null);
    }
  };

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  const applyStatus = useCallback((next: InternetRemoteControlStatus) => {
    setStatus(next);
    if (next.enabled) {
      const activeOrigin = controllerOriginFromStatus(next);
      if (activeOrigin) setControllerOrigin(activeOrigin);
    }
    if (!next.enabled) {
      setPairing(null);
      visiblePairingIdRef.current = null;
    } else if (isInternetRemotePairingClaimed(visiblePairingIdRef.current, next.sessions)) {
      setPairing(null);
      visiblePairingIdRef.current = null;
    }
  }, []);

  const refresh = useCallback(async (showOutcome = false) => {
    setBusy('refresh');
    setNotice(null);
    try {
      applyStatus((await api.status()).status);
      setLoadFailed(false);
      try {
        const access = await terminalLocalRequest(AI_TERMINAL_PREFIX + '/access', {});
        setWorkroomConnections(access.connections ?? []);
      } catch {
        setWorkroomConnections(null);
      }
      if (showOutcome) setNotice({ kind: 'success', message: '외부 인터넷 연결 상태를 다시 확인했습니다.' });
    } catch (error) {
      setLoadFailed(true);
      setNotice({ kind: 'error', message: readableError(error) });
    } finally {
      setBusy(null);
    }
  }, [api, applyStatus, setBusy]);

  useEffect(() => {
    if (!open) {
      // In particular, never retain the fragment-bearing pairing URL while the
      // dialog is closed. It is never written to persistent browser storage.
      setPairing(null);
      visiblePairingIdRef.current = null;
      setApprovalCodes({});
      setTaskScopeApprovals({});
      setConversationScopeApprovals({});
      setSessionScopeDrafts({});
      setControllerOrigin('');
      setRiskAcknowledged(false);
      setNotice(null);
      return;
    }
    let cancelled = false;
    setInitialLoading(true);
    setLoadFailed(false);
    setStatus(null);
    setPairing(null);
    visiblePairingIdRef.current = null;
    setApprovalCodes({});
    setTaskScopeApprovals({});
    setConversationScopeApprovals({});
    setSessionScopeDrafts({});
    setNotice(null);
    try {
      setControllerOrigin(defaultControllerOrigin
        ? normalizeInternetRemoteControllerOrigin(defaultControllerOrigin)
        : '');
    } catch {
      // App.tsx passes only a normalizeVercelPortalDeployUrl-verified value.
      // Fail closed if another caller supplies anything else.
      setControllerOrigin('');
    }
    void api.status()
      .then(latest => {
        if (cancelled) return;
        applyStatus(latest.status);
        // Only fill a blank field. Anything the user has already typed, or a
        // value seeded from the portal deploy setting, stays as it is.
        if (!latest.status.enabled && latest.suggestedControllerOrigin) {
          setControllerOrigin(current => current || latest.suggestedControllerOrigin!);
        }
      })
      .catch(error => { if (!cancelled) { setLoadFailed(true); setNotice({ kind: 'error', message: readableError(error) }); } })
      .finally(() => { if (!cancelled) setInitialLoading(false); });
    return () => { cancelled = true; };
  }, [open, api, applyStatus, defaultControllerOrigin]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    let pollInFlight = false;
    const pollStatus = async () => {
      if (cancelled || document.hidden || busyRef.current || pollInFlight) return;
      pollInFlight = true;
      const revision = managementRevisionRef.current;
      try {
        const latest = await api.status();
        if (!cancelled && revision === managementRevisionRef.current) applyStatus(latest.status);
      } catch {
        // Keep the last confirmed state. Manual refresh exposes the error.
      } finally {
        pollInFlight = false;
      }
    };
    const timer = window.setInterval(() => { void pollStatus(); }, 3_000);
    const handleVisibilityChange = () => {
      if (!document.hidden) void pollStatus();
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [open, api, applyStatus]);

  useEffect(() => {
    if (!open) return;
    previousFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const focusTimer = window.setTimeout(() => closeButtonRef.current?.focus(), 0);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (busyRef.current) return;
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(interactiveSelector) ?? [],
      ).filter(element => element.getClientRects().length > 0);
      if (!focusable.length) {
        event.preventDefault();
        dialogRef.current?.focus();
        return;
      }
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
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener('keydown', handleKeyDown);
      previousFocusRef.current?.focus();
      previousFocusRef.current = null;
    };
  }, [open]);

  useEffect(() => {
    if (!open || !pairing) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [open, pairing]);

  const pairingExpired = pairing ? isInternetRemoteControlExpired(pairing.expiresAt, now) : false;
  const visiblePairing = pairing && !pairingExpired ? pairing : null;
  const pendingSessions = useMemo(
    () => status?.sessions.filter(session => session.approvalState === 'pending') ?? [],
    [status?.sessions],
  );
  const connectedSessions = useMemo(
    () => status?.sessions.filter(session => session.approvalState === 'approved') ?? [],
    [status?.sessions],
  );

  // Whether the QR on screen lets the app open its bundled portal (the Mac put its public
  // Supabase key in it). Unknown until a QR is shown in this dialog.
  const appChannelReady = useMemo(() => {
    if (!pairing) return null;
    try { return !!parseRemoteControlRelayPairingUrl(pairing.pairingUrl).bootstrap.supabase; } catch { return null; }
  }, [pairing]);

  // 「폰 연결 링크」 (step ① data connection): the same public Supabase values the QR already carries
  // — guarded by pairingSupabaseConfig on the sidecar and re-checked by buildPhoneConnectLink — plus
  // the QR's portal origin and this Mac's label. No pairing secret: the link cannot grant control.
  // Kept after the QR expires; it lives only in this dialog's memory.
  const [phoneConnectLink, setPhoneConnectLink] = useState<PhoneConnectLinkText | null>(null);
  useEffect(() => {
    if (!pairing) return;
    try {
      const parsed = parseRemoteControlRelayPairingUrl(pairing.pairingUrl);
      const supabase = parsed.bootstrap.supabase;
      setPhoneConnectLink(supabase ? buildPhoneConnectLink({
        portalOrigin: new URL(parsed.controllerUrl).origin, supabaseUrl: supabase.url, anonKey: supabase.anonKey, hostName: hostLabel,
      }) : null);
    } catch { setPhoneConnectLink(null); }
  }, [pairing, hostLabel]);

  const handleEnable = async () => {
    if (busyRef.current) return;
    if (!riskAcknowledged) {
      setNotice({ kind: 'error', message: '베타 기능의 권한과 연결 제한을 먼저 확인해 주세요.' });
      return;
    }
    let normalizedOrigin: string;
    try {
      // Blank = 「앱으로만 원격제어」: the QR carries the public default origin only
      // as an identifier; the iPhone app opens its bundled portal with this Mac's
      // Supabase from the QR and never loads that address.
      normalizedOrigin = controllerOrigin.trim()
        ? normalizeInternetRemoteControllerOrigin(controllerOrigin)
        : DEFAULT_REMOTE_CONTROLLER_ORIGIN;
    } catch (error) {
      setNotice({ kind: 'error', message: readableError(error) });
      return;
    }
    setBusy('enable');
    setNotice(null);
    try {
      const result = await api.enable(normalizedOrigin);
      setStatus(result.status);
      setControllerOrigin(isDefaultRemoteControllerOrigin(normalizedOrigin) ? '' : normalizedOrigin);
      setPairing(result.pairing);
      visiblePairingIdRef.current = result.pairing
        ? parseRemoteControlRelayPairingUrl(result.pairing.pairingUrl).bootstrap.pairingId
        : null;
      setNotice(result.pairing
        ? { kind: 'success', message: '외부 인터넷 QR을 발급했습니다. QR은 30일 안에 한 번만 쓸 수 있고, 승인된 연결도 최대 30일 유지됩니다.' }
        : { kind: 'error', message: '기능은 켜졌지만 QR 원문을 받지 못했습니다. 전체 끄기 후 다시 시도해 주세요.' });
    } catch (error) {
      setPairing(null);
      visiblePairingIdRef.current = null;
      setNotice({ kind: 'error', message: readableError(error) });
    } finally {
      setBusy(null);
    }
  };

  /**
   * Mint one more QR without disabling the host. The relay binds a pairing to a
   * single controller key, so a second phone needs its own QR; before this the
   * dialog told the user to turn the whole feature off and back on, which
   * revoked the device already connected (VOC 2026-08-31 23:42).
   */
  const handleIssuePairing = async () => {
    if (busyRef.current) return;
    setBusy('issue');
    setNotice(null);
    try {
      const result = await api.issuePairing();
      setStatus(result.status);
      setPairing(result.pairing);
      visiblePairingIdRef.current = result.pairing
        ? parseRemoteControlRelayPairingUrl(result.pairing.pairingUrl).bootstrap.pairingId
        : null;
      setNotice(result.pairing
        ? { kind: 'success', message: `새 QR을 발급했습니다. 연결된 기기는 그대로 유지됩니다. 미사용 QR은 최대 ${REMOTE_CONTROL_MAX_SESSIONS}개이며, 초과 발급 시 가장 오래된 QR이 자동 폐기됩니다.` }
        : { kind: 'error', message: 'QR 원문을 받지 못했습니다. 잠시 후 다시 시도해 주세요.' });
    } catch (error) {
      setNotice({ kind: 'error', message: readableError(error) });
    } finally {
      setBusy(null);
    }
  };

  const handleApprove = async (session: InternetRemoteControlSession) => {
    if (busyRef.current || !session.sasCode) return;
    const entered = approvalCodes[session.sessionId] ?? '';
    if (entered !== session.sasCode) {
      setNotice({ kind: 'error', message: '휴대폰과 Mac에 보이는 6자리 코드를 확인한 뒤 정확히 입력해 주세요.' });
      return;
    }
    const workroomScope=workroomScopes[session.sessionId];
    if(workroomApprovals[session.sessionId]&&!workroomOptions.some(o=>o.value===workroomScope)){setNotice({kind:'error',message:'워크룸 작업을 허용할 프로젝트 또는 작업 폴더를 선택하세요.'});return;}
    setBusy('approve');
    setNotice(null);
    try {
      const grantTaskScope = AGENT_RUNTIME_MANAGED_EXECUTION_ENABLED
        && taskScopeApprovals[session.sessionId] === true;
      const grantConversationScope = conversationScopeApprovals[session.sessionId] === true;
      const approval=await approveInternetSessionWithWorkroom(()=>api.approveSession(
        session.sessionId,
        entered,
        grantTaskScope,
        grantConversationScope,
      ),workroomApprovals[session.sessionId]?()=>grantWorkroom(session.sessionId,workroomScope!,workroomFeatureScopes[session.sessionId]??[]):undefined);
      applyStatus(approval.status);
      if(approval.workroomError)setPendingWorkroom(current=>({...current,[session.sessionId]:{scope:workroomScope!,workspaceScopes:workroomFeatureScopes[session.sessionId]??[]}}));
      setApprovalCodes(current => {
        const next = { ...current };
        delete next[session.sessionId];
        return next;
      });
      setTaskScopeApprovals(current => {
        const next = { ...current };
        delete next[session.sessionId];
        return next;
      });
      setConversationScopeApprovals(current => {
        const next = { ...current };
        delete next[session.sessionId];
        return next;
      });
      setNotice(approval.workroomError?{kind:'error',message:`연결 승인은 완료됐습니다. 워크룸 권한 저장에 실패했습니다: ${approval.workroomError}. 아래에서 권한 저장만 다시 시도하세요.`}:{ kind: 'success', message: `${connectionDisplayName(internetConnectionLabelKey(session.sessionId),session.controllerName)} 연결을 이 Mac에서 승인했습니다.${workroomApprovals[session.sessionId]?' 워크룸 권한도 최대 30일 유지됩니다.':''}` });
    } catch (error) {
      setNotice({ kind: 'error', message: readableError(error) });
    } finally {
      setBusy(null);
    }
  };

  const handleRevoke = async (session: InternetRemoteControlSession) => {
    if (busyRef.current
      || !window.confirm(`${connectionDisplayName(internetConnectionLabelKey(session.sessionId),session.controllerName)}의 외부 인터넷 원격제어 권한을 해제할까요?`)) return;
    setBusy('revoke');
    setNotice(null);
    try {
      applyStatus(await api.revokeSession(session.sessionId));
      setNotice({ kind: 'success', message: `${connectionDisplayName(internetConnectionLabelKey(session.sessionId),session.controllerName)} 연결을 해제했습니다.` });
    } catch (error) {
      setNotice({ kind: 'error', message: readableError(error) });
    } finally {
      setBusy(null);
    }
  };

  const handleUpdateScopes = async (session: InternetRemoteControlSession) => {
    if (busyRef.current) return;
    const draft = sessionScopeDrafts[session.sessionId];
    if (!draft) return;
    // A closed production containment gate may revoke an old grant, but it
    // must never mint a new task-execution authority from this UI.
    const nextTaskScope = AGENT_RUNTIME_MANAGED_EXECUTION_ENABLED
      ? draft.task
      : session.taskScopeGranted && draft.task;
    if (nextTaskScope === session.taskScopeGranted
      && draft.conversation === session.conversationScopeGranted) return;
    const addsAuthority = (!session.taskScopeGranted && nextTaskScope)
      || (!session.conversationScopeGranted && draft.conversation);
    if (addsAuthority && !window.confirm(
      `${connectionDisplayName(internetConnectionLabelKey(session.sessionId),session.controllerName)}에 선택한 Codex 런타임 권한을 추가할까요? 원격에서는 위험 권한 우회 실행이 허용되지 않습니다.`,
    )) return;
    setBusy('scopes');
    setNotice(null);
    try {
      applyStatus(await api.updateSessionScopes(
        session.sessionId,
        nextTaskScope,
        draft.conversation,
      ));
      setSessionScopeDrafts(current => {
        const next = { ...current };
        delete next[session.sessionId];
        return next;
      });
      setNotice({
        kind: 'success',
        message: `${connectionDisplayName(internetConnectionLabelKey(session.sessionId),session.controllerName)}의 Codex 권한을 저장했습니다. QR 재연결 없이 바로 적용됩니다.`,
      });
    } catch (error) {
      setNotice({ kind: 'error', message: readableError(error) });
    } finally {
      setBusy(null);
    }
  };

  const handleDisable = async () => {
    if (busyRef.current
      || !window.confirm('이 Mac의 외부 인터넷 원격제어를 끄고 모든 QR·연결·승인을 차단할까요? 릴레이 항목은 즉시 정리되거나 자동 만료됩니다.')) return;
    setBusy('disable');
    setNotice(null);
    try {
      applyStatus(await api.disable());
      setPairing(null);
      visiblePairingIdRef.current = null;
      setApprovalCodes({});
      setSessionScopeDrafts({});
      setNotice({ kind: 'success', message: '이 Mac의 외부 인터넷 원격제어 권한을 모두 차단했습니다. 릴레이에 남은 항목은 사용할 수 없고 자동 만료됩니다.' });
    } catch (error) {
      setNotice({ kind: 'error', message: readableError(error) });
    } finally {
      setBusy(null);
    }
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[125] flex items-center justify-center bg-[var(--dialog-scrim)] p-3 backdrop-blur-sm sm:p-5"
      onMouseDown={event => {
        if (event.target === event.currentTarget && !busyRef.current) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="internet-qr-remote-title"
        aria-describedby="internet-qr-remote-description"
        data-testid="internet-qr-remote-control-dialog"
        tabIndex={-1}
        style={{ maxHeight: 'calc(var(--ui-viewport-height, 100dvh) - max(24px, 10dvh))' }}
        className="flex w-full max-w-4xl min-w-0 flex-col overflow-hidden rounded-2xl border border-sky-300/20 bg-[var(--bg-elevated)] shadow-[var(--dialog-shadow)]"
      >
        <header className="flex min-h-14 shrink-0 items-center gap-3 border-b border-[rgb(var(--surface-highlight-rgb))]/[0.07] px-4 py-2 sm:px-5">
          <div className="flex min-h-11 min-w-11 items-center justify-center rounded-xl border border-sky-300/20 bg-sky-300/[0.07] text-sky-200">
            <Globe2 className="h-5 w-5" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="internet-qr-remote-title" className="m-0 text-base font-semibold text-zinc-50">
              외부 인터넷 QR 원격제어 · 베타
            </h2>
            <p id="internet-qr-remote-description" className="m-0 mt-0.5 text-xs text-zinc-400">
              같은 Wi‑Fi가 아니어도 개인 HTTPS 컨트롤러를 통해 이 Mac의 제한된 프로젝트 동작만 제어합니다.
            </p>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            aria-label="외부 인터넷 QR 원격제어 닫기"
            disabled={busy !== null}
            onClick={onClose}
            className="flex min-h-11 min-w-11 items-center justify-center rounded-xl text-zinc-400 transition-colors hover:bg-[rgb(var(--surface-highlight-rgb))]/5 hover:text-[var(--text-primary)] disabled:cursor-wait disabled:opacity-40"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-5 sm:py-5">
          <div className="mb-4 grid grid-cols-1 gap-3 lg:grid-cols-3">
            <div className="rounded-xl border border-sky-300/15 bg-sky-300/[0.05] p-3 text-xs leading-5 text-sky-100">
              <div className="mb-1 flex items-center gap-2 font-semibold"><Cloud className="h-4 w-4" /> 두 가지 연결 · QR 하나</div>
              <strong className="text-[var(--text-primary)]">앱으로 원격제어</strong>: AgentsToZ 앱으로 스캔하면 앱 안의 화면이 열리고 이메일 코드로 로그인합니다. 웹 주소에 접속하지 않습니다.{' '}
              <strong className="text-[var(--text-primary)]">웹앱으로 원격제어</strong>(비상용): 휴대폰 카메라·브라우저로 스캔하면 웹앱 주소가 열립니다. 현재 구성은 Vercel에서 검증합니다. 정적 /remote 파일·Supabase 환경값·보안 헤더를 제공하는 HTTPS 호스트가 필요합니다.
            </div>
            <div className="rounded-xl border border-amber-300/15 bg-amber-300/[0.05] p-3 text-xs leading-5 text-amber-100">
              <div className="mb-1 flex items-center gap-2 font-semibold"><KeyRound className="h-4 w-4" /> 직접 승인</div>
              QR은 <strong className="text-[var(--text-primary)]">30일·1회용</strong> 초대장입니다. 유효기간이 길어도
              휴대폰과 Mac의 6자리 코드가 정확히 같을 때만 승인되며, 승인된 연결도 최대 30일 유지됩니다.
            </div>
            <div className="rounded-xl border border-teal-300/15 bg-teal-300/[0.05] p-3 text-xs leading-5 text-teal-100">
              <div className="mb-1 flex items-center gap-2 font-semibold"><ShieldCheck className="h-4 w-4" /> 제한된 권한</div>
              승인된 연결은 최대 30일 유지됩니다. 등록 프로젝트·워크트리 제어, 프로젝트·AgentsToZ/Orca 워크트리 생성,
              안전한 Codex 첫 대화 생성과 공식 Claude Code 원격 대화 시작,
              확인된 Git Commit·안전 Pull·Push·기본 브랜치 Merge와 허용된 앱 열기만 제공합니다.
            </div>
          </div>

          <div className="mb-4 rounded-xl border border-[rgb(var(--surface-highlight-rgb))]/[0.08] bg-[rgb(var(--surface-shade-rgb))]/20 p-3 text-xs leading-5 text-zinc-300">
            휴대폰에서 QR을 연 뒤 로그인해야 합니다. 앱은 <strong className="text-[var(--text-primary)]">이메일 코드</strong>, 웹앱은 <strong className="text-[var(--text-primary)]">Google 로그인</strong> 또는 이메일 코드입니다.
            임의 파일 읽기·쓰기, 임의 명령, 워크트리 삭제, AI 대화·자격증명·장기기억·What I Said·프롬프트 원문에는 접근 권한을 주지 않습니다.
            Git 작업은 등록 프로젝트에서 휴대폰 확인 후 정해진 안전 동작만 실행하며,
            이 Mac은 외부에 로컬 포트를 열지 않고 암호화된 릴레이를 확인합니다.
          </div>

          {Object.entries(pendingWorkroom).map(([sessionId,grant])=><div key={sessionId} role="alert" className="internet-workroom-retry">연결 승인 완료 · 워크룸 권한 저장 필요<button type="button" aria-label={`연결 ${sessionId.slice(-8)} 권한 저장 다시 시도`} disabled={busy!==null} onClick={async()=>{setBusy('scopes');try{await grantWorkroom(sessionId,grant.scope,grant.workspaceScopes);setPendingWorkroom(current=>{const next={...current};delete next[sessionId];return next});setNotice({kind:'success',message:'워크룸 권한을 저장했습니다.'})}catch(error){setNotice({kind:'error',message:readableError(error)})}finally{setBusy(null)}}}>권한 저장 다시 시도</button></div>)}
            {notice && (
            <div
              role={notice.kind === 'error' ? 'alert' : 'status'}
              aria-live={notice.kind === 'error' ? 'assertive' : 'polite'}
              aria-atomic="true"
              className={`mb-4 rounded-xl border px-3 py-2 text-xs ${notice.kind === 'error'
                ? 'border-red-300/25 bg-red-300/[0.07] text-red-100'
                : 'border-teal-300/25 bg-teal-300/[0.07] text-teal-100'}`}
            >
              {notice.message}
            </div>
          )}

          {internetRemoteStatusView({ initialLoading, hasStatus: status !== null, loadFailed }) === 'loading' ? (
            <div role="status" aria-live="polite" className="flex min-h-40 items-center justify-center gap-2 text-sm text-zinc-400">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> 외부 인터넷 원격제어 상태 확인 중…
            </div>
          ) : !status ? (
            <div className="flex min-h-40 flex-col items-center justify-center gap-3 rounded-xl border border-[rgb(var(--surface-highlight-rgb))]/[0.08] bg-[rgb(var(--surface-highlight-rgb))]/[0.02] p-5 text-center">
              <p className="m-0 text-sm text-zinc-300">현재 상태를 확인하지 못했습니다.</p>
              <button
                type="button"
                data-testid="internet-qr-status-retry" onClick={() => void refresh(true)}
                disabled={busy !== null}
                className="flex min-h-11 items-center gap-2 rounded-xl border border-[rgb(var(--surface-highlight-rgb))]/10 bg-[rgb(var(--surface-highlight-rgb))]/[0.04] px-4 text-sm text-zinc-100 hover:bg-[rgb(var(--surface-highlight-rgb))]/[0.07] disabled:cursor-wait disabled:opacity-40"
              >
                <RefreshCw className={`h-4 w-4 ${busy === 'refresh' ? 'animate-spin' : ''}`} aria-hidden="true" />다시 확인
              </button>
            </div>
          ) : (
            <>
              <div className="mb-4 flex flex-wrap items-center gap-2">
                <span className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${stateClasses[status.state]}`}>
                  {stateLabels[status.state]}
                </span>
                {status.lastRelayContactAt && (
                  <span className="text-[11px] text-zinc-500">마지막 릴레이 확인 {readableTime(status.lastRelayContactAt)}</span>
                )}
                <button
                  type="button"
                  onClick={() => void refresh(true)}
                  disabled={busy !== null}
                  className="ml-auto flex min-h-11 items-center gap-1.5 rounded-xl border border-[rgb(var(--surface-highlight-rgb))]/10 px-3 text-xs text-zinc-300 hover:bg-[rgb(var(--surface-highlight-rgb))]/5 disabled:opacity-40"
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${busy === 'refresh' ? 'animate-spin' : ''}`} /> 상태 새로고침
                </button>
              </div>

              {!status.enabled ? (
                <section className="rounded-2xl border border-[rgb(var(--surface-highlight-rgb))]/[0.08] bg-[rgb(var(--surface-highlight-rgb))]/[0.025] p-4">
                  <h3 className="m-0 text-sm font-semibold text-zinc-100">원격제어 켜기 · 앱으로 원격제어</h3>
                  <p className="mb-3 mt-1 text-xs leading-5 text-zinc-500" data-testid="internet-remote-app-only-intro">
                    iPhone의 AgentsToZ 앱으로 QR을 스캔하면 됩니다. 이 Mac의 Supabase 주소·공개 키가 QR에 들어 있어
                    웹 포털 주소는 필요 없습니다. 휴대폰 카메라가 아니라 앱으로 스캔하세요.
                  </p>
                  <details
                    data-testid="internet-remote-web-app-options"
                    open={webAppOptionsOpen}
                    onToggle={event => setWebAppOptionsOpen(event.currentTarget.open)}
                    className="rounded-xl border border-[rgb(var(--surface-highlight-rgb))]/[0.08] p-3"
                  >
                    <summary className="cursor-pointer text-xs font-medium text-zinc-300">{WEB_APP_OPTIONAL_TITLE}</summary>
                    <p className="mb-2 mt-2 text-[11px] leading-5 text-zinc-500">
                      직접 배포한 웹 포털이 있을 때만 넣습니다. 넣으면 휴대폰 카메라·브라우저로 스캔했을 때 이 주소가 열립니다.
                      앱으로 스캔할 때는 어느 포털용 QR인지 가리키는 식별값으로만 쓰입니다(접속하지 않음).
                      ChatGPT Sites는 배포·보안 헤더 호환성을 확인한 뒤 대체 후보로 사용할 수 있습니다.
                    </p>
                    <label className="block text-xs font-medium text-zinc-300" htmlFor="internet-remote-controller-origin">
                      웹앱 주소 — 내가 배포한 포털의 HTTPS 주소(선택)
                    </label>
                    <input
                    id="internet-remote-controller-origin"
                    data-testid="internet-remote-controller-origin"
                    type="url"
                    inputMode="url"
                    autoComplete="url"
                    spellCheck={false}
                    value={controllerOrigin}
                    onChange={event => setControllerOrigin(event.target.value)}
                    placeholder="https://your-controller.example"
                    disabled={busy !== null}
                    className="mt-1 min-h-11 w-full rounded-xl border border-[rgb(var(--surface-highlight-rgb))]/10 bg-[rgb(var(--surface-shade-rgb))]/30 px-3 text-sm text-zinc-100 outline-none placeholder:text-zinc-700 focus:border-sky-300/50 disabled:opacity-50"
                  />
                    <p className="mb-0 mt-1 text-[11px] leading-5 text-zinc-500">
                      경로, query, fragment, ID·토큰·키를 넣을 수 없습니다. 이 주소의 /remote 코드 자체가
                      허용된 프로젝트 열기·프로세스 제어 요청을 만들 수 있으므로, 본인이 배포하고 신뢰하는 HTTPS 주소만 입력하세요.
                    </p>
                  </details>
                  {!controllerOrigin.trim() && (
                    // Blank is a valid choice now (app-only), so say what it means instead of
                    // presenting it as a missing value.
                    <p
                      data-testid="internet-remote-origin-hint"
                      className="mb-0 mt-2 text-[11px] leading-5 text-zinc-400"
                    >
                      웹 포털 없이 앱으로만 원격제어합니다. QR에는 공개 기본 주소({DEFAULT_REMOTE_CONTROLLER_ORIGIN})가
                      식별값으로만 들어가고, 앱은 이 Mac의 Supabase로 연결합니다.
                    </p>
                  )}

                  <label className="mt-4 flex cursor-pointer items-start gap-3 rounded-xl border border-amber-300/15 bg-amber-300/[0.04] p-3 text-xs leading-5 text-zinc-300">
                    <input
                      type="checkbox"
                      checked={riskAcknowledged}
                      onChange={event => setRiskAcknowledged(event.target.checked)}
                      disabled={busy !== null}
                      className="mt-1 h-4 w-4 accent-teal-300"
                    />
                    <span>베타 기능이며, 30일 1회용 QR·6자리 직접 승인·최대 30일 연결·제한된 프로젝트 제어만 허용된다는 점을 확인했습니다.</span>
                  </label>

                  <button
                    type="button"
                    data-testid="enable-internet-qr-remote-control"
                    onClick={() => void handleEnable()}
                    disabled={busy !== null || !riskAcknowledged}
                    className="mt-4 flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-[rgb(var(--info-rgb))]/60 bg-[rgb(var(--info-rgb))] px-4 text-sm font-semibold text-[var(--text-on-solid)] transition-[filter] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {busy === 'enable' ? <Loader2 className="h-4 w-4 animate-spin" /> : <QrCode className="h-4 w-4" />}
                    외부 인터넷 원격제어 켜고 QR 발급
                  </button>
                </section>
              ) : (
                <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_280px]">
                  <div className="min-w-0 space-y-4">
                    <section className="rounded-2xl border border-[rgb(var(--surface-highlight-rgb))]/[0.08] bg-[rgb(var(--surface-highlight-rgb))]/[0.025] p-4">
                      <h3 className="m-0 text-sm font-semibold text-zinc-100">원격제어 채널</h3>
                      <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 text-[11px] leading-5" data-testid="internet-remote-channels">
                        <dt className="font-semibold text-zinc-200">앱으로 원격제어</dt>
                        <dd className="m-0 text-zinc-400" data-testid="internet-remote-app-channel">
                          AgentsToZ 앱으로 QR 스캔 · 앱 안의 화면 · 이메일 코드 로그인
                          {appChannelReady === false && <span className="mt-1 block text-amber-100">이 QR에는 Supabase 공개 키가 없어 앱이 웹앱 주소로 대신 엽니다. 앱 설정의 Supabase anon key를 확인하세요.</span>}
                          <PhoneConnectLinkBox link={phoneConnectLink} onNotice={setNotice}
                            unavailable={appChannelReady === false ? 'Supabase 공개 키가 없어 링크를 만들 수 없습니다.' : 'QR을 새로 발급하면 링크도 함께 만들어집니다.'} />
                        </dd>
                        <dt className="font-semibold text-zinc-200">웹앱으로 원격제어</dt>
                        <dd className="m-0 min-w-0">{isDefaultRemoteControllerOrigin(controllerOriginFromStatus(status))
                          ? <span className="text-zinc-500" data-testid="internet-remote-web-channel-app-only">설정 안 함 · 앱으로만 원격제어합니다. 휴대폰 카메라로 스캔하면 공개 웹 포털이 「AgentsToZ 앱으로 스캔하세요」라고 안내합니다.</span>
                          : <><code className="block break-all rounded-lg bg-[rgb(var(--surface-shade-rgb))]/30 px-2 py-1 text-sky-200">{status.controllerUrl}</code><span className="text-zinc-500">비상용 · 휴대폰 카메라·브라우저로 스캔할 때 열립니다</span></>}</dd>
                      </dl>
                      <div className="mt-2 grid grid-cols-1 gap-1 text-[11px] text-zinc-500 sm:grid-cols-2">
                        <span>이 Mac 등록 만료 {readableTime(status.hostExpiresAt)}</span>
                        <span>QR 유효 {readableTime(status.pairingExpiresAt)}</span>
                      </div>
                      {status.error && (
                        <p className="mb-0 mt-2 rounded-lg border border-red-300/20 bg-red-300/[0.05] p-2 text-xs text-red-100">{status.error}</p>
                      )}
                    </section>

                    {pendingSessions.map(session => {
                      const entered = approvalCodes[session.sessionId] ?? '';
                      const exactMatch = Boolean(session.sasCode && entered === session.sasCode);
                      return (
                        <section key={session.sessionId} data-testid="internet-remote-sas-approval" className="rounded-2xl border border-amber-300/25 bg-amber-300/[0.055] p-4">
                          <div className="flex items-start gap-3">
                            <Smartphone className="mt-0.5 h-5 w-5 shrink-0 text-amber-200" />
                            <div className="min-w-0 flex-1">
                              <h3 className="m-0 text-sm font-semibold text-amber-50">승인 대기</h3>
                              <RemoteConnectionLabel key={session.sessionId} sessionId={session.sessionId} fallback={session.controllerName} />
                              <p className="mb-0 mt-1 text-xs leading-5 text-amber-100/75">
                                휴대폰 화면의 코드와 아래 Mac 코드가 정확히 같은지 사람 눈으로 확인하세요.
                              </p>
                            </div>
                          </div>
                          <div aria-label="Mac의 6자리 연결 확인 코드" className="my-3 rounded-xl border border-amber-200/25 bg-[rgb(var(--surface-shade-rgb))]/25 py-3 text-center font-mono text-3xl font-bold tracking-[0.28em] text-amber-100">
                            {session.sasCode ? `${session.sasCode.slice(0, 3)} ${session.sasCode.slice(3)}` : '확인 불가'}
                          </div>
                          <label className="block text-xs font-medium text-zinc-300" htmlFor={`sas-${session.sessionId}`}>
                            휴대폰과 일치한 6자리 코드를 직접 입력
                          </label>
                          <div className="mt-1 flex flex-col gap-2 sm:flex-row">
                            <input
                              id={`sas-${session.sessionId}`}
                              data-testid="internet-remote-sas-input"
                              type="text"
                              inputMode="numeric"
                              autoComplete="one-time-code"
                              pattern="[0-9]{6}"
                              maxLength={6}
                              value={entered}
                              onChange={event => setApprovalCodes(current => ({
                                ...current,
                                [session.sessionId]: event.target.value.replace(/\D/g, '').slice(0, 6),
                              }))}
                              disabled={busy !== null || !session.sasCode}
                              className="min-h-11 min-w-0 flex-1 rounded-xl border border-[rgb(var(--surface-highlight-rgb))]/10 bg-[rgb(var(--surface-shade-rgb))]/30 px-3 text-center font-mono text-lg tracking-[0.2em] text-zinc-100 outline-none focus:border-amber-200/50 disabled:opacity-40"
                            />
                            <button
                              type="button"
                              data-testid="approve-internet-remote-session"
                              aria-label={`${connectionDisplayName(internetConnectionLabelKey(session.sessionId),session.controllerName)} · 연결 ${session.sessionId.slice(-8)} 정확히 일치 — 승인`}
                              onClick={() => void handleApprove(session)}
                              disabled={busy !== null || !exactMatch}
                              className="flex min-h-11 items-center justify-center gap-2 rounded-xl border border-amber-200/30 bg-amber-200 px-4 text-xs font-semibold text-slate-950 hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-40"
                            >
                              {busy === 'approve' ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                              정확히 일치 — 승인
                            </button>
                          </div>
                          <label className="internet-workroom-consent">
                            <input type="checkbox" data-testid="grant-internet-workroom" aria-label={`${connectionDisplayName(internetConnectionLabelKey(session.sessionId),session.controllerName)} · 연결 ${session.sessionId.slice(-8)} 워크룸 작업 허용`} checked={workroomApprovals[session.sessionId]===true} disabled={busy!==null} onChange={e=>setWorkroomApprovals(current=>({...current,[session.sessionId]:e.target.checked}))}/>
                            <span>이 기기에서 워크룸 작업 허용 · 최대 30일<span className="block">선택한 프로젝트에서 CLI를 실행하고 입력·출력을 사용합니다. 재연결과 앱 재시작 후에도 유지됩니다.</span></span>
                          </label>
                          {workroomApprovals[session.sessionId]&&<label className="internet-workroom-scope">허용 범위<select aria-label={`${connectionDisplayName(internetConnectionLabelKey(session.sessionId),session.controllerName)} · 연결 ${session.sessionId.slice(-8)} 워크룸 허용 범위`} disabled={busy!==null} value={workroomScopes[session.sessionId]??''} onChange={e=>setWorkroomScopes(current=>({...current,[session.sessionId]:e.target.value}))}><option value="">프로젝트 또는 작업 폴더 선택</option>{workroomOptions.map(o=><option key={o.value} value={o.value}>{o.label}</option>)}</select>{workroomOptionError&&<p role="alert">{workroomOptionError}</p>}</label>}
                          {workroomApprovals[session.sessionId]&&workroomScopes[session.sessionId]===ALL_WORKROOM_TARGETS&&<p>현재 목록의 모든 프로젝트·워크트리에서 CLI 입력·출력을 허용합니다. 이후 추가되는 프로젝트는 포함되지 않습니다. 기록 조회·기억 저장 등의 권한은 별도로 설정합니다.</p>}
                          {workroomApprovals[session.sessionId]&&<fieldset className="internet-workroom-features" data-testid="grant-internet-workroom-features"><legend>모바일에서 함께 허용할 기능</legend><MobileFeatureSelection connectionLabel={`${connectionDisplayName(internetConnectionLabelKey(session.sessionId),session.controllerName)} · 연결 ${session.sessionId.slice(-8)}`} selected={workroomFeatureScopes[session.sessionId]??[]} disabled={busy!==null} onChange={scopes=>setWorkroomFeatureScopes(current=>({...current,[session.sessionId]:scopes}))}/>{mobileFeatureScopes.map(scope=><label key={scope}><input type="checkbox" checked={(workroomFeatureScopes[session.sessionId]??[]).includes(scope)} disabled={busy!==null} onChange={event=>setWorkroomFeatureScope(session.sessionId,scope,event.target.checked)}/><span>{MOBILE_WORKSPACE_SCOPE_LABELS[scope]}</span></label>)}<p>음성·기록·기억은 CLI 권한과 분리되어 있으며 선택한 기능만 이 기기에 허용됩니다.</p></fieldset>}
                          {AGENT_RUNTIME_MANAGED_EXECUTION_ENABLED&&                          <label className="mt-3 flex cursor-pointer items-start gap-2 rounded-xl border border-sky-300/15 bg-sky-300/[0.04] p-3 text-xs leading-5 text-zinc-300">
                            <input
                              type="checkbox"
                              data-testid="grant-internet-remote-task-scope"
                              checked={AGENT_RUNTIME_MANAGED_EXECUTION_ENABLED
                                && taskScopeApprovals[session.sessionId] === true}
                              onChange={event => setTaskScopeApprovals(current => ({
                                ...current,
                                [session.sessionId]: event.target.checked,
                              }))}
                              disabled={busy !== null || !AGENT_RUNTIME_MANAGED_EXECUTION_ENABLED}
                              className="mt-1 h-4 w-4 shrink-0 accent-sky-300"
                            />
                            <span>
                              이 모바일 기기에서 Codex 작업 시작·상태 확인·취소 허용
                              <span className="block text-[10px] text-zinc-500">
                                {AGENT_RUNTIME_MANAGED_EXECUTION_ENABLED
                                  ? '선택하지 않으면 기존 프로젝트 원격제어만 허용됩니다. 위험 권한 우회 실행은 원격에서 허용되지 않습니다.'
                                  : '현재 production은 하위 프로세스까지 강제 회수하는 안전 격리가 준비되지 않아 새 Codex 작업 권한을 켤 수 없습니다.'}
                              </span>
                            </span>
                          </label>}
                          <label className="mt-2 flex cursor-pointer items-start gap-2 rounded-xl border border-violet-300/15 bg-violet-300/[0.04] p-3 text-xs leading-5 text-zinc-300">
                            <input
                              type="checkbox"
                              data-testid="grant-internet-remote-conversation-scope"
                              checked={conversationScopeApprovals[session.sessionId] === true}
                              onChange={event => setConversationScopeApprovals(current => ({
                                ...current,
                                [session.sessionId]: event.target.checked,
                              }))}
                              disabled={busy !== null}
                              className="mt-1 h-4 w-4 shrink-0 accent-violet-300"
                            />
                            <span>
                              이 모바일 기기에서 지속형 Codex 대화 및 대화 기록 열람 허용
                              <span className="block text-[10px] text-zinc-500">작업 실행 권한과 별개입니다. 선택한 프로젝트의 필터링된 대화 기록이 종단간 암호화되어 전송됩니다.</span>
                            </span>
                          </label>
                        </section>
                      );
                    })}

                    <section className="rounded-2xl border border-[rgb(var(--surface-highlight-rgb))]/[0.08] bg-[rgb(var(--surface-highlight-rgb))]/[0.025] p-4">
                      <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="m-0 text-sm font-semibold text-zinc-100">승인된 모바일 기기</h3>{onOpenWorkroom&&connectedSessions.length>0&&<button type="button" onClick={onOpenWorkroom}>전체 워크룸 열기</button>}</div>
                      {connectedSessions.length ? (
                        <div className="mt-3 space-y-2">
                          {connectedSessions.map(session => {
                            const draft = sessionScopeDrafts[session.sessionId] ?? {
                              task: session.taskScopeGranted,
                              conversation: session.conversationScopeGranted,
                            };
                            const scopeChanged = draft.task !== session.taskScopeGranted
                              || draft.conversation !== session.conversationScopeGranted;
                            const workroomConnection = workroomConnections?.find(connection => connection.id === 'internet:' + session.sessionId);
                            const canEditTaskScope = AGENT_RUNTIME_MANAGED_EXECUTION_ENABLED
                              || draft.task;
                            const updateDraft = (change: Partial<SessionScopeDraft>) => {
                              setSessionScopeDrafts(current => ({
                                ...current,
                                [session.sessionId]: {
                                  ...(current[session.sessionId] ?? {
                                    task: session.taskScopeGranted,
                                    conversation: session.conversationScopeGranted,
                                  }),
                                  ...change,
                                },
                              }));
                            };
                            return (
                              <div key={session.sessionId} className="min-w-0 rounded-xl border border-[rgb(var(--surface-highlight-rgb))]/[0.07] bg-[rgb(var(--surface-shade-rgb))]/20 p-3">
                                <div className="flex min-w-0 items-center gap-3">
                                  <Smartphone className="h-4 w-4 shrink-0 text-teal-200" />
                                  <div className="min-w-0 flex-1">
                                    <RemoteConnectionLabel key={session.sessionId} sessionId={session.sessionId} fallback={session.controllerName} />
                                    <div className="mt-0.5 text-[10px] text-zinc-600">승인 후 최대 30일 · {readableTime(session.expiresAt)} 만료</div>
                                  </div>
                                  <button
                                    type="button"
                                    aria-label={`${connectionDisplayName(internetConnectionLabelKey(session.sessionId),session.controllerName)} · 연결 ${session.sessionId.slice(-8)} 해제`}
                                    onClick={() => void handleRevoke(session)}
                                    disabled={busy !== null}
                                    className="min-h-11 shrink-0 rounded-xl border border-red-300/20 px-3 text-xs text-red-200 hover:bg-red-300/[0.06] disabled:opacity-40"
                                  >
                                    연결 해제
                                  </button>
                                </div>
                                <div className="internet-workroom-status" data-testid="approved-internet-workroom-status">
                                  <strong>워크룸 · CLI 작업</strong>
                                  <span>{workroomConnections === null
                                    ? '권한 상태를 확인하지 못했습니다. 상단 상태 확인을 눌러 주세요.'
                                    : workroomConnection?.allowed
                                      ? workroomConnection.durable
                                        ? `허용됨 · ${readableTime(workroomConnection.expiresAt ?? null)}까지 · 앱 업데이트 후에도 유지`
                                        : '현재 연결에서 허용됨 · 재접속 유지 설정은 워크룸에서 확인하세요.'
                                      : '워크룸에서 이 기기의 작업 권한을 허용해 주세요.'}</span>
                                  <span>휴대폰에서 프로젝트의 ‘워크룸에서 작업’을 선택하면 Codex·Claude Code·Hermes·Antigravity CLI를 사용할 수 있습니다. 각 CLI의 설치와 로그인이 필요합니다.</span>
                                  <span>음성 {workroomConnection?.workspaceScopes?.includes('voice.use')?'허용':'미허용'} · 기록 {workroomConnection?.workspaceScopes?.includes('records.read')?'허용':'미허용'} · 기억 저장 {workroomConnection?.workspaceScopes?.includes('memory.save')?'허용':'미허용'}</span>
                                  <details className="internet-workroom-permissions" data-testid="approved-internet-workroom-permissions"><summary aria-label={`${connectionDisplayName(internetConnectionLabelKey(session.sessionId),session.controllerName)} · 연결 ${session.sessionId.slice(-8)} 모바일 음성·기록 권한 설정`}>모바일 음성·기록 권한 설정</summary><label className="internet-workroom-scope">허용 범위<select aria-label={`${connectionDisplayName(internetConnectionLabelKey(session.sessionId),session.controllerName)} · 연결 ${session.sessionId.slice(-8)} 승인된 기기 워크룸 허용 범위`} disabled={busy!==null} value={workroomScopes[session.sessionId]??''} onChange={event=>setWorkroomScopes(current=>({...current,[session.sessionId]:event.target.value}))}><option value="">프로젝트 또는 작업 폴더 선택</option>{workroomOptions.map(option=><option key={option.value} value={option.value}>{option.label}</option>)}</select></label><button type="button" className="internet-workroom-grant-all" data-testid="grant-all-approved-internet-workroom-features" aria-label={`${connectionDisplayName(internetConnectionLabelKey(session.sessionId),session.controllerName)} · 연결 ${session.sessionId.slice(-8)} 5개 기능 한 번에 허용·저장`} disabled={busy!==null||!workroomOptions.some(option=>option.value===workroomScopes[session.sessionId])} onClick={()=>void handleGrantAllApprovedFeatures(session.sessionId)}>5개 기능 한 번에 허용·저장</button><p className="internet-workroom-saved-count" data-testid="saved-internet-workroom-feature-count">현재 저장된 기능 {(workroomConnection?.workspaceScopes??[]).filter(scope=>mobileFeatureScopes.some(feature=>feature===scope)).length}/5개 · 선택한 프로젝트 범위에 바로 적용됩니다.</p><fieldset className="internet-workroom-features"><legend>이 기기에서 허용할 기능</legend><MobileFeatureSelection connectionLabel={`${connectionDisplayName(internetConnectionLabelKey(session.sessionId),session.controllerName)} · 연결 ${session.sessionId.slice(-8)}`} selected={workroomFeatureScopes[session.sessionId]??workroomConnection?.workspaceScopes??[]} disabled={busy!==null} onChange={scopes=>setWorkroomFeatureScopes(current=>({...current,[session.sessionId]:scopes}))}/>{mobileFeatureScopes.map(scope=><label key={scope}><input type="checkbox" checked={(workroomFeatureScopes[session.sessionId]??workroomConnection?.workspaceScopes??[]).includes(scope)} disabled={busy!==null} onChange={event=>{if(workroomFeatureScopes[session.sessionId]===undefined)setWorkroomFeatureScopes(current=>({...current,[session.sessionId]:[...(workroomConnection?.workspaceScopes??[])]}));setWorkroomFeatureScope(session.sessionId,scope,event.target.checked)}}/><span>{MOBILE_WORKSPACE_SCOPE_LABELS[scope]}</span></label>)}</fieldset><button type="button" data-testid="save-approved-internet-workroom-permissions" aria-label={`${connectionDisplayName(internetConnectionLabelKey(session.sessionId),session.controllerName)} · 연결 ${session.sessionId.slice(-8)} 선택한 프로젝트·권한 적용`} disabled={busy!==null||!workroomOptions.some(option=>option.value===workroomScopes[session.sessionId])} onClick={async()=>{setBusy('scopes');setNotice(null);try{await grantWorkroom(session.sessionId,workroomScopes[session.sessionId]!,workroomFeatureScopes[session.sessionId]??workroomConnection?.workspaceScopes??[]);setNotice({kind:'success',message:'이 기기의 모바일 음성·기록 권한을 저장했습니다. iPhone에서 음성 창을 다시 열어 주세요.'})}catch(error){setNotice({kind:'error',message:readableError(error)})}finally{setBusy(null)}}}>선택한 프로젝트·권한 적용</button></details>
                                </div>
                                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                                  {(AGENT_RUNTIME_MANAGED_EXECUTION_ENABLED || session.taskScopeGranted) && <label className="flex min-h-11 cursor-pointer items-center gap-2 rounded-xl border border-sky-300/15 bg-sky-300/[0.04] px-3 text-xs text-zinc-300">
                                    <input
                                      type="checkbox"
                                      data-testid="update-internet-remote-task-scope"
                                      checked={draft.task}
                                      onChange={event => updateDraft({ task: event.target.checked })}
                                      disabled={busy !== null || !canEditTaskScope}
                                      className="h-4 w-4 shrink-0 accent-sky-300"
                                    />
                                    <span>
                                      Codex 자동 작업
                                      {!AGENT_RUNTIME_MANAGED_EXECUTION_ENABLED && (
                                        <span className="block text-[10px] text-zinc-500">
                                          {draft.task
                                            ? '과거 승인 권한 · 현재 실행 불가 · 해제만 가능'
                                            : '이전 권한 해제 선택됨'}
                                        </span>
                                      )}
                                    </span>
                                  </label>}
                                  <label className="flex min-h-11 cursor-pointer items-center gap-2 rounded-xl border border-violet-300/15 bg-violet-300/[0.04] px-3 text-xs text-zinc-300">
                                    <input
                                      type="checkbox"
                                      data-testid="update-internet-remote-conversation-scope"
                                      checked={draft.conversation}
                                      onChange={event => updateDraft({ conversation: event.target.checked })}
                                      disabled={busy !== null}
                                      className="h-4 w-4 shrink-0 accent-violet-300"
                                    />
                                    지속형 Codex 대화·기록 (읽기 전용)
                                  </label>
                                </div>
                                <div className="mt-2 flex flex-col items-start justify-between gap-2 sm:flex-row sm:items-center">
                                  <p className="m-0 text-[10px] leading-4 text-zinc-500">CLI 작업은 위 워크룸 권한을 사용합니다. 아래 저장 버튼은 지속형 대화{session.taskScopeGranted ? '·이전 자동 작업' : ''} 권한에만 적용됩니다.</p>
                                  <button
                                    type="button"
                                    data-testid="save-internet-remote-session-scopes"
                                    aria-label={`${connectionDisplayName(internetConnectionLabelKey(session.sessionId),session.controllerName)} · 연결 ${session.sessionId.slice(-8)} 권한 저장`}
                                    onClick={() => void handleUpdateScopes(session)}
                                    disabled={busy !== null || !scopeChanged}
                                    className="min-h-11 shrink-0 rounded-xl border border-teal-300/25 bg-teal-300/[0.07] px-3 text-xs font-semibold text-teal-100 hover:bg-teal-300/[0.12] disabled:cursor-not-allowed disabled:opacity-40"
                                  >
                                    {busy === 'scopes' ? '저장 중…' : '권한 저장'}
                                  </button>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      ) : (
                        <p className="mb-0 mt-2 text-xs text-zinc-600">아직 이 Mac에서 승인한 모바일 기기가 없습니다.</p>
                      )}
                    </section>
                  </div>

                  <aside className="min-w-0">
                    {visiblePairing ? (
                      <div data-testid="internet-remote-pairing-qr" className="rounded-2xl border border-sky-300/20 bg-sky-300/[0.04] p-4 text-center">
                        <div className="mx-auto w-fit rounded-2xl bg-white p-2 shadow-xl shadow-black/40">
                          <QRCodeSVG
                            value={visiblePairing.pairingUrl}
                            size={220}
                            level="Q"
                            marginSize={4}
                            bgColor="#ffffff"
                            fgColor="#000000"
                            title="30일 일회용 외부 인터넷 원격제어 QR"
                          />
                        </div>
                        <div className="mt-3 text-xs font-semibold text-sky-100">30일·1회용 QR</div>
                        <div className="mt-1 font-mono text-lg text-[var(--text-primary)]">
                          {formatInternetRemoteControlRemaining(visiblePairing.expiresAt, now)}
                        </div>
                        <p className="mb-0 mt-2 text-[11px] leading-5 text-sky-100" data-testid="internet-remote-scan-guide">
                          앱으로 원격제어: AgentsToZ 앱의 QR 스캔으로 찍으세요. 웹앱으로 원격제어: 휴대폰 카메라로 찍으면 웹앱이 열립니다.
                        </p>
                        <p className="mb-0 mt-2 text-[11px] leading-5 text-zinc-500">
                          QR 링크 자체는 브라우저 저장소·클립보드에 기록하지 않습니다. 스캔되거나 이 창을 닫으면 화면 메모리에서 제거합니다.
                          이 Mac은 재시작 후 기존 연결을 복원하려고 QR 연결 식별자·비밀값과 호스트 키를 앱 데이터 폴더의 이 계정 전용 파일(권한 0600)에 저장합니다.
                        </p>
                      </div>
                    ) : (
                      <div className="rounded-2xl border border-[rgb(var(--surface-highlight-rgb))]/[0.08] bg-[rgb(var(--surface-highlight-rgb))]/[0.025] p-4 text-xs leading-5 text-zinc-500">
                        <QrCode className="mb-2 h-5 w-5 text-zinc-600" />
                        일회용 QR 원문은 보안상 상태 조회에서 다시 불러오지 않습니다.
                        QR 하나는 기기 한 대만 연결할 수 있으니, 다른 기기를 추가하려면
                        아래에서 새 QR을 발급하세요. 연결된 기기는 그대로 유지됩니다.
                        미사용 QR은 최대 {REMOTE_CONTROL_MAX_SESSIONS}개이며, 초과 발급 시 가장 오래된 미사용 QR이 자동 폐기됩니다.
                      </div>
                    )}

                    <button
                      type="button"
                      data-testid="issue-internet-qr-remote-control-pairing"
                      onClick={() => void handleIssuePairing()}
                      disabled={busy !== null}
                      className="mt-3 flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-teal-300/25 bg-teal-300/[0.07] px-3 text-xs font-semibold text-teal-100 hover:bg-teal-300/[0.11] disabled:cursor-wait disabled:opacity-40"
                    >
                      {busy === 'issue'
                        ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                        : <QrCode className="h-4 w-4" aria-hidden="true" />}
                      다른 기기 추가 (새 QR)
                    </button>
                    <button
                      type="button"
                      data-testid="disable-internet-qr-remote-control"
                      onClick={() => void handleDisable()}
                      disabled={busy !== null}
                      className="mt-3 flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-red-300/25 px-3 text-xs font-semibold text-red-200 hover:bg-red-300/[0.06] disabled:opacity-40"
                    >
                      {busy === 'disable' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Unplug className="h-4 w-4" />}
                      외부 인터넷 원격제어 전체 끄기
                    </button>
                  </aside>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
