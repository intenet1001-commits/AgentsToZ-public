import {useEffect, useRef, useState} from 'react';
import {Monitor, RefreshCw, Terminal} from 'lucide-react';
import type {AiTerminalAgent} from './aiTerminalProtocol';
import {launchChoiceLabel, launchChoiceTarget, WORKROOM_LAUNCH_CHOICES, type HermesVariant} from './hermesVariants';
import {useHermesVariants} from './hermesVariantsClient';
import {hermesVariantCopy} from './i18n';
import {useAppLanguage} from './useAppLanguage';
import {projectCodexLaunchMessage, projectCodexPrimaryAction, type ProjectCodexConnectionState, type ProjectCodexLaunchResult} from './projectLaunchPolicy';

/** Two explicit destinations. Mounting reads metadata only and never launches AI. */
export function ProjectLaunchActions({projectKey, testId, onWorkroom, loadCodex, onCodex}: {
  projectKey: string;
  testId: string;
  /** 「Hermes · Claude」/「Hermes · Codex」 (src/hermesVariants.ts) pass the variant; every other AI passes none. */
  onWorkroom(agent: AiTerminalAgent, variant?: HermesVariant): Promise<unknown>;
  loadCodex(): Promise<{recentState: Exclude<ProjectCodexConnectionState, 'checking'>; appAvailable: boolean}>;
  onCodex(): Promise<ProjectCodexLaunchResult>;
}) {
  const [lang] = useAppLanguage(), copy = hermesVariantCopy(lang);
  const [choice, setChoice] = useState<string>('codex');
  const variants = useHermesVariants();
  const [connection, setConnection] = useState<ProjectCodexConnectionState>('checking');
  const [appAvailable, setAppAvailable] = useState(true);
  const [busy, setBusy] = useState<'workroom' | 'codex' | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [refresh, setRefresh] = useState(0);
  const callbacks = useRef({onWorkroom, loadCodex, onCodex});
  callbacks.current = {onWorkroom, loadCodex, onCodex};
  const generation = useRef(0);
  const inFlight = useRef(false);
  useEffect(() => {
    let active = true;
    generation.current += 1;
    setConnection('checking');
    setError(''); setMessage(''); setBusy(null); inFlight.current = false;
    void callbacks.current.loadCodex().then(result => {
      if (active) { setConnection(result.recentState); setAppAvailable(result.appAvailable); }
    }).catch(reason => {
      if (active) { setConnection('unavailable'); setError(reason instanceof Error ? reason.message : String(reason)); }
    });
    return () => { active = false; generation.current += 1; };
  }, [projectKey, refresh]);
  const action = projectCodexPrimaryAction(connection, appAvailable);
  const buttonStyle = {font: 'inherit', fontSize: 13, minHeight: 44, padding: '8px 12px', borderRadius: 8, border: '1px solid var(--border-mild)', background: 'var(--bg-card)', color: 'var(--text-primary)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 7, cursor: 'pointer'} as const;
  const run = async (destination: 'workroom' | 'codex') => {
    if (inFlight.current) return;
    if (destination === 'codex' && action.intent === 'check') { setRefresh(value => value + 1); return; }
    inFlight.current = true;
    const current = generation.current;
    setBusy(destination); setError(''); setMessage('');
    try {
      if (destination === 'workroom') { const target = launchChoiceTarget(choice); await callbacks.current.onWorkroom(target.agent, target.variant); }
      else {
        const result = await callbacks.current.onCodex();
        if (current === generation.current) { setConnection('found'); setMessage(projectCodexLaunchMessage(result)); }
      }
    } catch (reason) {
      if (current === generation.current) setError(reason instanceof Error ? reason.message : String(reason));
    } finally { if (current === generation.current) { setBusy(null); inFlight.current = false; } }
  };
  return <section data-testid={testId} aria-label="프로젝트에서 작업 시작" style={{padding: 14, borderRadius: 10, border: '1px solid var(--border-mild)', background: 'var(--bg-card)', marginBottom: 12}}>
    <strong style={{fontSize: 13}}>이 프로젝트에서 작업</strong>
    <div style={{display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 10}}>
      <select aria-label="워크룸에서 실행할 AI" value={choice} disabled={busy !== null} style={buttonStyle} onChange={event => setChoice(event.target.value)}>
        {WORKROOM_LAUNCH_CHOICES.map(value => {
          const item = variants.items.find(entry => entry.choice === value);
          return <option key={value} value={value} disabled={item ? !item.available : false}>
            {launchChoiceLabel(value)}{item && !item.available ? ` · ${copy.missingShort.replace('{provider}', item.provider)}` : ''}
          </option>;
        })}
      </select>
      <button data-testid={`${testId}-workroom`} type="button" style={buttonStyle} disabled={busy !== null || variants.items.some(item => item.choice === choice && !item.available)} onClick={() => void run('workroom')}><Terminal size={15}/>{busy === 'workroom' ? '워크룸 연결 중…' : '워크룸에서 작업'}</button>
      <button data-testid={`${testId}-codex`} type="button" style={buttonStyle} disabled={busy !== null || !action.enabled} onClick={() => void run('codex')}><Monitor size={15}/>{busy === 'codex' ? 'Codex 앱 연결 중…' : action.label}</button>
      <button type="button" aria-label="Codex 앱 연결 상태 새로고침" title="앱 설치·프로젝트 연결 상태 다시 확인" style={buttonStyle} disabled={busy !== null || connection === 'checking'} onClick={() => setRefresh(value => value + 1)}><RefreshCw size={14}/></button>
    </div>
    <p style={{fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6, margin: '9px 0 0'}}>AgentsToZ 워크룸에서 작업합니다. 열린 세션은 이어서 사용하고, 기기별 목록은 작업 세션에서 확인합니다.</p>
    {(() => { const item = variants.items.find(entry => entry.choice === choice); return item && <p data-testid={`${testId}-hermes-variant`} role={item.available ? undefined : 'status'} style={{fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6, margin: '6px 0 0'}}>{item.available ? copy.hint.replace('{model}', item.model) : copy.missing.replace('{provider}', item.provider)}</p>; })()}
    {connection === 'none' && <p style={{fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6, margin: '6px 0 0'}}>처음 열기는 프로젝트 연결용 첫 대화만 준비합니다. 파일·명령 작업 없이 준비됐다고만 답하는 고정 안내문을 1회 보내며, 실제 작업은 Mac의 Codex 앱에서 이어서 진행합니다.</p>}
    {!appAvailable && <p role="status" style={{fontSize: 12}}>이 Mac에서 Codex 앱 설치를 확인하지 못했습니다. 앱을 설치하거나 한 번 실행한 뒤 연결 상태를 새로고침하세요.</p>}
    {connection === 'unavailable' && !error && <p role="status" style={{fontSize: 12}}>프로젝트 연결 상태를 확인하지 못했습니다. Codex 앱을 연 뒤 다시 확인하세요.</p>}
    {error && <p role="alert" data-testid={`${testId}-error`} style={{fontSize: 12, lineHeight: 1.6, color: 'var(--danger)', marginBottom: 0}}>{error}</p>}
    {message && <p role="status" style={{fontSize: 12, lineHeight: 1.6, marginBottom: 0}}>{message}</p>}
  </section>;
}
