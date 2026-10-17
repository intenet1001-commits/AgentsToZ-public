/** The phone Workroom history panel alone, for tests/remote-workroom-history-confirm.e2e.mjs. The fake Mac records every
 *  history action in `window.__historyCalls`; nothing leaves the page. */
import React from 'react';
import {createRoot} from 'react-dom/client';
import {RemoteWorkroomHistoryPanel} from '../../src/RemoteWorkroomHistoryPanel';
import type {RemoteHistoryTransport} from '../../src/remoteWorkroomHistoryClient';

const now = new Date().toISOString();
const rows = [
  {id: 'conv_fixture_0000001', title: '이어 열 대화', agent: 'claude', state: 'ended', resumable: true, updatedAt: now, revision: 1},
  {id: 'conv_fixture_0000002', title: '다른 대화', agent: 'codex', state: 'detached', resumable: true, updatedAt: now, revision: 2},
];
const calls: string[] = [];
(window as unknown as {__historyCalls: string[]}).__historyCalls = calls;
const transport = (async request => {
  const {action} = (request as unknown as {workspace: {action: string}}).workspace;
  calls.push(action);
  if (action === 'history.list') return {action, history: {records: rows, nextBefore: null}};
  if (action === 'history.resume.review') return {action, history: {review: {id: 'review_fixture_0001', expiresAt: Date.now() + 60_000, available: true, reason: '', revision: 1}}};
  if (action === 'history.resume.execute') return {action, history: {resume: {state: 'unknown'}}};
  throw new Error('unexpected ' + action);
}) as RemoteHistoryTransport;
const map = new Map<string, string>();
const storage = {getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => { map.set(key, String(value)); }};

createRoot(document.getElementById('root')!).render(
  <main className="remote-shell" data-workspace-tab="workroom">
    <div className="remote-panel remote-workroom-content">
      <RemoteWorkroomHistoryPanel available visible online host="host_fixture_0001" pairing="p_fixture_pairing_0001" knownHosts={['host_fixture_0001']}
        projects={[{targetId: 'control_fixture_0001', label: '블로그'}]} transport={transport} storage={storage}/>
    </div>
  </main>,
);
