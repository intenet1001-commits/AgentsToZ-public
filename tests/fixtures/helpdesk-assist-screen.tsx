import {createRoot} from 'react-dom/client';
import {useState} from 'react';
import {HelpdeskBrowserAssist} from '../../src/HelpdeskBrowserAssist';
import type {AssistIntent, AssistService} from '../../src/helpdeskAssistProtocol';
import '../../src/HelpdeskPanel.css';

const service = new URLSearchParams(location.search).get('service') ?? 'google-workspace';
const intent: AssistIntent = {service: service as AssistService, goal: 'connect', stage: 'setup',
  origin: 'helpdesk-gws', scope: {kind: 'account-add'}, email: 'fixture@example.test'};
async function request(path: string, body: Record<string, unknown>) {
  const response = await fetch(path, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
  const result = await response.json();
  if (!response.ok) throw Error(result.error ?? 'Fixture request failed');
  return result;
}
const transport = (body: Record<string, unknown>) => request('/assist', body);
function Screen() {
  const [destination, setDestination] = useState('');
  return <main className="helpdesk-panel helpdesk-standalone">
    <aside aria-label="격리 시험의 외부 서비스 경계" className="helpdesk-bubble">
      <p><strong>격리 시험 화면</strong> · 실제 React 화면과 지원 호스트입니다. 브라우저 드라이버·공식 로그인·CLI 응답만 시험용입니다.</p>
      <p>실제 Google 계정·비밀번호·JSON을 입력하지 마세요. 설치 앱과 외부 서비스는 변경하지 않습니다.</p>
      <div className="helpdesk-actions">
        <button className="helpdesk-button" onClick={() => void request('/fixture', {operation: 'complete-login'})}>공식 로그인 완료 (시험 응답)</button>
        <button className="helpdesk-button" onClick={() => void request('/fixture', {operation: 'complete-project'})}>새 프로젝트 생성 완료 (시험 응답)</button>
        <button className="helpdesk-button" onClick={() => void request('/fixture', {operation: 'release-check'})}>대기 중인 검사 응답 보내기</button>
      </div>
    </aside>
    {destination === 'back' ? <p role="status">원래 화면으로 돌아왔습니다.</p> :
      <HelpdeskBrowserAssist intent={intent} transport={transport} onBack={() => setDestination('back')}
        onOpenStage={stage => setDestination(stage)}/>}
    {destination && destination !== 'back' && <p role="status">원래 앱 화면: {destination}</p>}
  </main>;
}
createRoot(document.getElementById('root')!).render(<Screen/>);
