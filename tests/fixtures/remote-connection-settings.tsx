import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { RemoteConnectionSettings } from '../../src/RemoteConnectionSettings';
const state = { requests: [] as string[], hold: false, release: null as (() => void) | null };
(window as any).fixture = state;
function Fixture() {
  const [connections, setConnections] = useState(new URLSearchParams(location.search).has('single')
    ? [{ id: 'host-1', name: '아젠투지 1호' }]
    : [{ id: 'host-1', name: '아젠투지 1호' }, { id: 'host-3', name: '아젠투지 3호-회사' }]);
  return <main className="remote-shell">
    <header className="remote-header"><h1>내 작업 공간</h1></header>
    <section className="remote-panel"><h2>원격 작업</h2><p>아젠투지 1호 · 응답 중 · 종단간 암호화</p></section>
    <button className="remote-reload" type="button">화면 새로 불러오기</button>
    <RemoteConnectionSettings connections={connections} onDisconnect={async id => {
      state.requests.push(id);
      if (state.hold) await new Promise<void>(resolve => { state.release = resolve; });
      setConnections(current => current.filter(connection => connection.id !== id));
      return true;
    }} />
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
