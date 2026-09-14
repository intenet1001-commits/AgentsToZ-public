import { useCallback, useEffect, useRef, useState } from 'react';
import { isTauri } from './lib/env';
import {
  MacOSRuntimeNativeClient,
  type MacOSRuntimeNativeDiagnostic,
  type MacOSRuntimeNativeResult,
} from './macOSRuntimeNativeClient';

const RESULT_LABELS: Readonly<Record<MacOSRuntimeNativeResult, string>> = {
  'not-registered': '서비스 등록 전',
  enabled: '서비스 승인·활성',
  'requires-approval': '시스템 설정 관리자 승인 필요',
  'not-found': '내장 서비스를 찾지 못함',
  registered: '등록 요청 완료',
  unregistered: '등록 해제 완료',
  'already-registered': '이미 등록됨',
  'registration-denied': '사용자가 등록을 승인하지 않음',
  'probe-passed': '상호 서명 XPC 확인',
  'dedicated-identity-fixture-passed': '전용 UID background fixture 확인',
  'dedicated-identity-provisioned': '전용 비로그인 계정 생성·검증 완료',
  'dedicated-identity-already-provisioned': '기존 전용 비로그인 계정 재검증 완료',
  'unsupported-os': 'macOS 26 이상 필요',
  'production-identity-unavailable': '운영 Apple Team ID 미고정',
  'app-location-rejected': '정확한 /Applications 설치본 필요',
  'bundle-identity-rejected': '앱 번들 식별 불일치',
  'signature-rejected': 'Developer ID·entitlement 검증 실패',
  'embedded-service-missing': '내장 broker 또는 plist 없음',
  'invalid-challenge': 'challenge 계약 불일치',
  'connection-rejected': '상호 인증 XPC 연결 실패',
  'probe-mismatch': 'broker challenge 응답 불일치',
  'probe-timed-out': 'broker 응답 시간 초과',
  'registration-failed': '서비스 등록 실패',
  'unregistration-failed': '서비스 등록 해제 실패',
  'dedicated-identity-fixture-rejected': '전용 UID background fixture 실패',
  'dedicated-identity-provisioning-rejected': '전용 비로그인 계정 생성·검증 거부',
  unknown: '알 수 없는 네이티브 상태',
};

export interface MacOSRuntimeBrokerSetupProps {
  visible: boolean;
  client?: MacOSRuntimeNativeClient;
  available?: boolean;
}

export function MacOSRuntimeBrokerSetup({
  visible,
  client: providedClient,
  available = isTauri(),
}: MacOSRuntimeBrokerSetupProps) {
  const clientRef = useRef<MacOSRuntimeNativeClient | null>(null);
  if (!clientRef.current) clientRef.current = providedClient ?? new MacOSRuntimeNativeClient();
  const client = clientRef.current;
  const [diagnostic, setDiagnostic] = useState<MacOSRuntimeNativeDiagnostic | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!available) return;
    try {
      setDiagnostic(await client.status());
      setError('');
    } catch {
      // The command does not exist on Windows/Linux builds. This sub-panel is
      // macOS-only and should not turn a portable runtime diagnostic into an error.
      setDiagnostic(null);
      setError('');
    }
  }, [available, client]);

  useEffect(() => {
    if (visible) void refresh();
  }, [refresh, visible]);

  if (!available || !visible || !diagnostic) return null;

  const run = async (
    operation: () => Promise<MacOSRuntimeNativeDiagnostic>,
    confirmation?: string,
  ) => {
    if (confirmation && !window.confirm(confirmation)) return;
    setBusy(true);
    setError('');
    try {
      const result = await operation();
      setDiagnostic(result);
      if (result.operation === 'register' || result.operation === 'unregister') {
        await refresh();
      }
    } catch {
      setError('네이티브 런타임 작업을 완료하지 못했습니다.');
    } finally {
      setBusy(false);
    }
  };

  const status = diagnostic.result;
  const canRegister = status === 'not-registered';
  const canExercise = status === 'enabled';
  const canUnregister = status === 'enabled' || status === 'requires-approval';

  return (
    <section
      data-testid="macos-runtime-broker-setup"
      className="mt-3 rounded-xl border border-[rgb(var(--surface-highlight-rgb))]/[0.08] bg-[rgb(var(--surface-shade-rgb))]/20 p-3"
      aria-label="macOS 런타임 서비스"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-[11px] font-semibold text-zinc-200">macOS 네이티브 서비스</p>
          <p className="mt-1 text-[10px] text-zinc-500">{RESULT_LABELS[status]}</p>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={busy}
          className="min-h-9 rounded-lg border border-[rgb(var(--surface-highlight-rgb))]/10 px-2.5 py-1 text-[10px] text-zinc-300 disabled:opacity-50"
        >
          다시 확인
        </button>
      </div>
      {status === 'requires-approval' ? (
        <p className="mt-2 text-[10px] leading-4 text-amber-200">
          시스템 설정 → 일반 → 로그인 항목 및 확장 프로그램에서 AgentsToZ background service를 관리자가 승인해야 합니다.
        </p>
      ) : null}
      {error ? <p role="alert" className="mt-2 text-[10px] text-rose-200">{error}</p> : null}
      {(canRegister || canExercise || canUnregister) ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {canRegister ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void run(
                () => client.register(),
                '관리자 승인이 필요한 AgentsToZ 런타임 서비스를 등록할까요?',
              )}
              className="min-h-9 rounded-lg border border-teal-300/20 bg-teal-300/[0.06] px-3 py-1 text-[10px] text-teal-100 disabled:opacity-50"
            >
              서비스 등록…
            </button>
          ) : null}
          {canExercise ? (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={() => void run(() => client.probe())}
                className="min-h-9 rounded-lg border border-[rgb(var(--surface-highlight-rgb))]/10 px-3 py-1 text-[10px] text-zinc-300 disabled:opacity-50"
              >
                상호 인증 확인
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void run(
                  () => client.provisionDedicatedIdentity(),
                  '로그인·관리자 권한이 없는 _agentstoz 전용 런타임 계정을 생성하거나 재검증할까요?',
                )}
                className="min-h-9 rounded-lg border border-[rgb(var(--surface-highlight-rgb))]/10 px-3 py-1 text-[10px] text-zinc-300 disabled:opacity-50"
              >
                전용 계정 준비…
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void run(
                  () => client.runDedicatedIdentityFixture(),
                  'Apple Container를 실행하지 않는 전용 UID background fixture를 실행할까요?',
                )}
                className="min-h-9 rounded-lg border border-[rgb(var(--surface-highlight-rgb))]/10 px-3 py-1 text-[10px] text-zinc-300 disabled:opacity-50"
              >
                전용 UID 시험…
              </button>
            </>
          ) : null}
          {canUnregister ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void run(
                () => client.unregister(),
                'AgentsToZ 런타임 서비스 등록을 해제할까요?',
              )}
              className="min-h-9 rounded-lg border border-rose-300/20 px-3 py-1 text-[10px] text-rose-200 disabled:opacity-50"
            >
              등록 해제…
            </button>
          ) : null}
        </div>
      ) : null}
      <p className="mt-2 text-[10px] leading-4 text-zinc-600">
        이 결과만으로 모델 실행은 허용되지 않습니다. 계정·컨테이너 TCB·탈출 canary가 별도로 통과해야 합니다.
      </p>
    </section>
  );
}
