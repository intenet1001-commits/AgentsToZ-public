import { expect, test } from 'bun:test';
import { remoteTerminalOwners } from '../src/remoteTerminalOwners';

const away = { id: 'away-session', label: '모바일 브라우저 · 연결 대기', connected: false };
const live = { id: 'live-session', label: '모바일 브라우저', connected: true };

test('a paired phone with no socket is not a terminal owner', () => {
  // A locked iPhone keeps its session so it can resume without a new QR, and stays listed so the
  // operator can revoke it. Neither of those makes it something that may be handed a PTY: the
  // grant was given to a connection that is gone.
  expect(remoteTerminalOwners({ lan: [away] })).toEqual([]);
  expect(remoteTerminalOwners({ lan: [live] })).toEqual([{ id: 'lan:live-session', label: '모바일 브라우저' }]);
  expect(remoteTerminalOwners({ lan: [away, live] }).map(owner => owner.id)).toEqual(['lan:live-session']);
});

test('an internet controller owns a terminal only once the Mac has approved it', () => {
  const controllers = [
    { sessionId: 'a', controllerName: '대기 중 폰', approvalState: 'pending' },
    { sessionId: 'b', controllerName: '승인된 폰', approvalState: 'approved' },
    { sessionId: 'c', controllerName: '해지된 폰', approvalState: 'revoked' },
  ];
  expect(remoteTerminalOwners({ internet: controllers })).toEqual([
    { id: 'internet:b', label: '승인된 폰' },
  ]);
});

test('the two transports keep separate id namespaces and neither is required', () => {
  // A bare id would let a LAN session id collide with an internet one and inherit its grant.
  expect(remoteTerminalOwners({
    lan: [{ id: 'same', label: 'LAN', connected: true }],
    internet: [{ sessionId: 'same', controllerName: 'Internet', approvalState: 'approved' }],
  }).map(owner => owner.id)).toEqual(['lan:same', 'internet:same']);
  expect(remoteTerminalOwners({})).toEqual([]);
});
