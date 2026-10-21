import {useCallback, useEffect, useRef, useState} from 'react';
import {terminalLocalRequest} from './aiTerminalClient';
import type {DutyAgentSettings} from './csDutyAgent';
import {DUTY_AGENT_MAX_TARGETS} from './csDutyAgent';
import {openWorkroomPopout} from './workroomPopoutClient';
import {workroomPopoutTitle} from './workroomPopout';

/**
 * AI 대직 — 켜고, 방을 고르면 끝. 프로젝트 Claude 세션이 kakaotalk·slack MCP로 그 방들을 지킨다.
 * 규칙은 서버(src/csDutyAgentHost.ts)와 MCP가 강제하고 이 화면은 목록과 ON/OFF만 다룬다.
 */
const path = '/api/agent-runtime/cs-duty';
const box = {display: 'grid', gap: 8, padding: 12, border: '1px solid var(--line)', borderRadius: 10} as const;
const button = {padding: '7px 12px', border: '1px solid var(--line)', borderRadius: 8, background: 'var(--surface)', color: 'var(--ink)', cursor: 'pointer', font: 'inherit'} as const;
const input = {flex: '1 1 160px', minWidth: 0, padding: 8, border: '1px solid var(--line)', borderRadius: 8, background: 'var(--surface)', color: 'var(--ink)', font: 'inherit'} as const;
const chip = {display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 6px 3px 10px', borderRadius: 999, background: 'var(--sunken)', fontSize: 13} as const;

type Status = {
  supported: boolean;
  settings: DutyAgentSettings;
  session: {id: string; state: string} | null;
  mcp: {kakao: boolean; slack: boolean};
  problem: string | null;
};
type Draft = Pick<DutyAgentSettings, 'kakaoRooms' | 'slackChannels' | 'note'>;
type Kind = 'kakao' | 'slack';
const draftOf = (s: DutyAgentSettings): Draft => ({kakaoRooms: s.kakaoRooms, slackChannels: s.slackChannels, note: s.note});
const same = (a: Draft, b: Draft) => JSON.stringify(a) === JSON.stringify(b);

export function CsDutyAgentSection({targetId, projectName}: {targetId: string; projectName: string}) {
  const [status, setStatus] = useState<Status | null>(null);
  const [draft, setDraft] = useState<Draft>({kakaoRooms: [], slackChannels: [], note: ''});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [choices, setChoices] = useState<Record<Kind, {id: string; title: string}[] | null>>({kakao: null, slack: null});
  const [loadingChoices, setLoadingChoices] = useState<Kind | null>(null);
  const [typed, setTyped] = useState<Record<Kind, string>>({kakao: '', slack: ''});
  const saved = useRef<Draft | null>(null);
  const alive = useRef(true);

  const apply = useCallback((next: Status) => {
    setStatus(next);
    // Never overwrite what the operator is editing: only adopt the server's list when the draft is clean.
    setDraft(current => (!saved.current || same(current, saved.current) ? draftOf(next.settings) : current));
    saved.current = draftOf(next.settings);
  }, []);

  const refresh = useCallback(async () => {
    try { const next = await terminalLocalRequest(path, {operation: 'agentStatus', targetId}); if (alive.current) apply(next); }
    catch (e) { if (alive.current) setError(e instanceof Error ? e.message : '대직 상태를 확인하지 못했습니다.'); }
  }, [targetId, apply]);

  useEffect(() => {
    alive.current = true;
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => { alive.current = false; clearInterval(timer); };
  }, [refresh]);

  const run = async (body: Record<string, unknown>) => {
    setBusy(true); setError('');
    try { const next = await terminalLocalRequest(path, {targetId, ...body}); if (alive.current) apply(next); return true; }
    catch (e) { if (alive.current) setError(e instanceof Error ? e.message : '요청을 처리하지 못했습니다.'); return false; }
    finally { if (alive.current) setBusy(false); }
  };

  const loadChoices = async (kind: Kind) => {
    setLoadingChoices(kind); setError('');
    try {
      const result = await terminalLocalRequest(path, {operation: 'agentChoices', targetId, kind});
      if (alive.current) setChoices(current => ({...current, [kind]: result.choices ?? []}));
    } catch (e) { if (alive.current) setError(e instanceof Error ? e.message : '목록을 불러오지 못했습니다.'); }
    finally { if (alive.current) setLoadingChoices(null); }
  };

  const listKey = (kind: Kind) => (kind === 'kakao' ? 'kakaoRooms' : 'slackChannels') as 'kakaoRooms' | 'slackChannels';
  const add = (kind: Kind, value: string) => {
    const item = value.trim();
    if (!item) return;
    setDraft(current => {
      const list = current[listKey(kind)];
      if (list.length >= DUTY_AGENT_MAX_TARGETS || list.some(existing => existing.toLowerCase() === item.toLowerCase())) return current;
      return {...current, [listKey(kind)]: [...list, item]};
    });
    setTyped(current => ({...current, [kind]: ''}));
  };
  const remove = (kind: Kind, item: string) => setDraft(current => ({...current, [listKey(kind)]: current[listKey(kind)].filter(existing => existing !== item)}));

  const running = status?.session?.state === 'running';
  const on = status?.settings.enabled === true;
  const dirty = !!saved.current && !same(draft, saved.current);
  const empty = !draft.kakaoRooms.length && !draft.slackChannels.length;

  const turnOn = async () => {
    if (dirty && !(await run({operation: 'agentSave', agent: draft}))) return;
    await run({operation: 'agentStart'});
  };

  const stateText = !status ? '상태 확인 중' : !status.supported ? '설치된 macOS 앱에서 사용할 수 있습니다'
    : on && running ? '켜짐 · 질문을 기다리는 중' : on ? (status.problem ? '켜짐 · 세션 문제' : '켜짐 · 세션 시작 중') : '꺼짐';
  const tone = on && running ? 'var(--ok)' : on ? 'var(--warn)' : 'var(--ink-2)';

  const targetBlock = (kind: Kind) => {
    const title = kind === 'kakao' ? '카카오톡 방' : '슬랙 채널 · DM';
    const installed = status?.mcp[kind];
    const list = draft[listKey(kind)];
    const options = (choices[kind] ?? []).filter(option => !list.some(item => item.toLowerCase() === option.id.toLowerCase()));
    return <div style={box} data-testid={`duty-agent-${kind}`}>
      <strong style={{fontSize: 13}}>{title}</strong>
      {status && !installed && <small style={{color: 'var(--warn)'}}>
        {kind === 'kakao' ? '카카오톡 MCP(kakaotalk)가 없습니다. mcp-series/kakaotalk-mcp의 install.sh를 실행하세요.' : '슬랙 MCP(slack)가 없습니다. mcp-series/slack-mcp의 install.sh를 실행하세요.'}
      </small>}
      <div style={{display: 'flex', flexWrap: 'wrap', gap: 6}}>
        {list.length ? list.map(item => <span key={item} style={chip} data-testid={`duty-agent-${kind}-chip`}>{item}
          <button type="button" aria-label={`${item} 빼기`} style={{...button, padding: '0 6px', borderRadius: 999}} disabled={busy} onClick={() => remove(kind, item)}>×</button></span>)
          : <small style={{color: 'var(--ink-3)'}}>아직 없습니다.</small>}
      </div>
      <div style={{display: 'flex', flexWrap: 'wrap', gap: 6}}>
        {choices[kind] ? <select aria-label={`${title} 고르기`} style={input} value="" disabled={busy || list.length >= DUTY_AGENT_MAX_TARGETS}
          onChange={e => add(kind, e.target.value)}>
          <option value="">{options.length ? '목록에서 고르기' : '추가할 항목이 없습니다'}</option>
          {options.map(option => <option key={option.id} value={option.id}>{option.title}</option>)}
        </select>
          : <button type="button" style={button} disabled={!installed || loadingChoices !== null} onClick={() => void loadChoices(kind)}>
            {loadingChoices === kind ? '불러오는 중…' : '목록 불러오기'}</button>}
        <input aria-label={`${title} 직접 입력`} style={input} value={typed[kind]} disabled={busy || list.length >= DUTY_AGENT_MAX_TARGETS}
          placeholder={kind === 'kakao' ? '방 제목 그대로' : '#채널 · @이름 · 이메일'}
          onChange={e => setTyped(current => ({...current, [kind]: e.target.value}))}
          onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); add(kind, typed[kind]); } }}/>
        <button type="button" style={button} disabled={busy || !typed[kind].trim()} onClick={() => add(kind, typed[kind])}>추가</button>
      </div>
      {kind === 'kakao' && <small style={{color: 'var(--ink-3)'}}>카카오톡에서 그 방을 별도 창으로 열어 두세요. 방 제목이 정확히 같아야 합니다.</small>}
    </div>;
  };

  return <section data-testid="duty-agent" style={{display: 'grid', gap: 12, marginBottom: 16}}>
    <div style={{display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap'}}>
      <strong style={{fontSize: 15}}>AI 대직 · 카카오톡 · 슬랙</strong>
      <span role="status" data-testid="duty-agent-state" data-on={on ? 'true' : 'false'} data-running={running ? 'true' : 'false'}
        style={{display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 700, color: tone}}>
        <span aria-hidden="true" style={{width: 8, height: 8, borderRadius: '50%', background: 'currentColor'}}/>{stateText}</span>
    </div>
    <p style={{margin: 0, fontSize: 13}}>켜면 이 프로젝트 폴더에서 Claude가 아래 방들을 지키며, <strong>누가 묻든(나 포함) 질문으로 보이면</strong> 프로젝트 자료로 짧게 답합니다.
      답장은 <code>[cs-assistant-bot]</code>으로 시작해 사람이 쓴 글과 구분되고, 방에서 「봇 그만」이라고 하면 그 방의 대직이 끝납니다.</p>
    {targetBlock('kakao')}
    {targetBlock('slack')}
    <label style={{display: 'grid', gap: 4, fontSize: 13}}>응대 방침 (선택)
      <textarea data-testid="duty-agent-note" rows={3} maxLength={2000} style={{...input, resize: 'vertical'}} value={draft.note} disabled={busy}
        placeholder="예: 존댓말로, 가격·일정 확정은 담당자에게 넘기기, 출시 전 기능은 말하지 않기"
        onChange={e => setDraft(current => ({...current, note: e.target.value}))}/>
    </label>
    {error && <p role="alert" data-testid="duty-agent-error" style={{margin: 0, color: 'var(--danger)'}}>{error}</p>}
    {!error && status?.problem && <p role="alert" style={{margin: 0, color: 'var(--warn)'}}>{status.problem}</p>}
    <div style={{display: 'flex', flexWrap: 'wrap', gap: 8}}>
      {on ? <button type="button" data-testid="duty-agent-off" style={{...button, borderColor: 'var(--danger)', color: 'var(--danger)', fontWeight: 700}} disabled={busy} onClick={() => void run({operation: 'agentStop'})}>대직 끄기</button>
        : <button type="button" data-testid="duty-agent-on" style={{...button, background: 'var(--accent)', color: 'var(--on-accent)', borderColor: 'transparent', fontWeight: 700}}
          disabled={busy || empty || !status?.supported} onClick={() => void turnOn()}>대직 켜기</button>}
      {dirty && <button type="button" data-testid="duty-agent-save" style={button} disabled={busy} onClick={() => void run({operation: 'agentSave', agent: draft})}>
        {on ? '저장하고 세션 다시 시작' : '저장'}</button>}
      {running && status?.session && <button type="button" data-testid="duty-agent-session" style={button}
        onClick={() => void openWorkroomPopout({sessionId: status.session!.id, targetId, agent: 'claude', bypassPermissions: false}, workroomPopoutTitle(`${projectName} 대직`, 'claude')).catch(e => setError(e instanceof Error ? e.message : '세션 창을 열지 못했습니다.'))}>세션 보기</button>}
    </div>
    <small style={{color: 'var(--ink-3)'}}>대직 세션은 이 프로젝트 폴더 읽기와 대직 도구만 쓸 수 있습니다 — 명령 실행·파일 수정·등록하지 않은 방으로의 발송은 막혀 있고 .env·키 파일은 읽지 않습니다. 켜 둔 대직은 앱을 다시 열어도 이어집니다.</small>
  </section>;
}
