/**
 * LAN 워크룸 폴링이 요청마다 등록 프로젝트 전체를 다시 열거하지 않는다 (2026-10-08 측정).
 *
 * 휴대폰 워크룸 화면은 세션 목록·출력을 1초 남짓마다 읽는다. LAN 경로는 그 `read`·`list` 하나마다
 * `taskTargetBindings` → 등록 프로젝트 전체 카드(매니페스트·lsof·git worktree)를 새로 만들었고,
 * 등록 150개에서 폴링 한 번이 호스트 시간 ~200ms였다(`bun run perf:baseline`의
 * `remote.workroom.list-poll`). 인터넷 릴레이는 이미 같은 이유로 5초 캐시를 두고 있었다.
 *
 * 지키는 것: 읽기 전용(read·list)만 같은 소켓에서 5초 재사용하고, 그 밖의 요청(resize 등)과
 * 5초가 지난 읽기, 그리고 새 소켓(복구)은 다시 만든다. 실제 리스너와 실제 WebSocket을 쓰므로
 * 사설 IPv4가 없는 기기에서는 건너뛴다(tests/remote-control-lan-reconnect.integration.test.ts와 같다).
 */
import {describe, expect, test} from 'bun:test';
import {networkInterfaces} from 'node:os';
import {LAN_READ_ONLY_TERMINAL_BINDINGS_TTL_MS, RemoteControlLanServer, isPrivateRemoteControlIpv4} from '../src/remoteControlLanServer';
import {REMOTE_CONTROL_PROTOCOL_VERSION, type RemoteControlGateway} from '../src/remoteControlCore';
import type {RemoteTerminalGateway} from '../src/remoteControlTerminalProtocol';

function privateAddress(): string | null {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal && isPrivateRemoteControlIpv4(entry.address)) return entry.address;
    }
  }
  return null;
}
const address = privateAddress();
const scenario = address ? describe : describe.skip;

function connect(origin: string): Promise<{socket: WebSocket; next: () => Promise<any>}> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${origin.replace('http://', 'ws://')}/remote/ws`, {headers: {Origin: origin}} as unknown as string[]);
    const inbox: any[] = [];
    let waiting: ((value: any) => void) | null = null;
    socket.addEventListener('message', event => {
      const parsed = JSON.parse(String((event as MessageEvent).data));
      if (waiting) { const resume = waiting; waiting = null; resume(parsed); } else inbox.push(parsed);
    });
    socket.addEventListener('error', () => reject(new Error('WebSocket failed to open')));
    socket.addEventListener('open', () => resolve({
      socket,
      next: () => inbox.length ? Promise.resolve(inbox.shift()) : Promise.race([
        new Promise<any>(done => { waiting = done; }),
        new Promise<any>((_, fail) => setTimeout(() => fail(new Error('host sent nothing within 5s')), 5_000)),
      ]),
    }));
  });
}

scenario('LAN terminal polling reuses project bindings like the relay does', () => {
  test('read-only requests share one enumeration for 5s; other requests, expiry and a new socket rebuild', async () => {
    let listings = 0;
    let clock = Date.parse('2099-01-01T00:00:00.000Z');
    const gateway: RemoteControlGateway = {
      listRegisteredProjects: () => {
        listings += 1;
        return [{internalId: 'p1', name: 'Fixture', port: null, command: null, kind: 'main', folderPath: '/tmp/fixture-project', status: 'unknown', actions: ['folder.open']}] as never;
      },
      executeRegisteredProjectAction: () => undefined,
    };
    const seen: Array<{operation: string; bindings: number}> = [];
    const terminalGateway: RemoteTerminalGateway = async (request, bindings) => {
      seen.push({operation: (request as {operation: string}).operation, bindings: bindings.length});
      return {sessions: []} as never;
    };
    const server = new RemoteControlLanServer({bindAddress: address!, hostName: 'Test Mac', gateway, terminalGateway, now: () => clock});
    const {pairing} = server.start();
    const origin = new URL(pairing.pairingUrl).origin;
    const token = new URLSearchParams(new URL(pairing.pairingUrl).hash.slice(1)).get('pair')!;
    try {
      const phone = await connect(origin);
      phone.socket.send(JSON.stringify({type: 'controller.pair', protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION, token}));
      const ready = await phone.next();
      expect(ready.type).toBe('session.ready');
      const afterPair = listings;
      const terminal = async (request: Record<string, unknown>) => {
        phone.socket.send(JSON.stringify({type: 'terminal.request', sessionToken: ready.sessionToken, request: {requestId: crypto.randomUUID(), ...request}}));
        const result = await phone.next();
        expect(result.type).toBe('terminal.result');
        expect(result.ok).toBe(true);
      };

      await terminal({operation: 'list'});
      expect(listings).toBe(afterPair + 1);
      // The phone's steady polling within the window: no further enumeration.
      await terminal({operation: 'list'});
      await terminal({operation: 'read', sessionId: 'session-00000001', after: 0});
      expect(listings).toBe(afterPair + 1);
      // The cached bindings are the real ones, not an empty stand-in.
      expect(seen.every(call => call.bindings === 1)).toBe(true);

      // A request that changes something always re-reads the registered projects.
      await terminal({operation: 'resize', sessionId: 'session-00000001', cols: 80, rows: 24});
      expect(listings).toBe(afterPair + 2);

      // After the window a read rebuilds them.
      clock += LAN_READ_ONLY_TERMINAL_BINDINGS_TTL_MS + 1;
      await terminal({operation: 'list'});
      expect(listings).toBe(afterPair + 3);

      // A restored session on a new socket never inherits another socket's cache.
      const resumed = await connect(origin);
      resumed.socket.send(JSON.stringify({type: 'session.restore', protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION, sessionToken: ready.sessionToken}));
      const restored = await resumed.next();
      expect(restored.type).toBe('session.restored');
      const before = listings;
      resumed.socket.send(JSON.stringify({type: 'terminal.request', sessionToken: ready.sessionToken, request: {requestId: crypto.randomUUID(), operation: 'list'}}));
      const result = await resumed.next();
      expect(result.ok).toBe(true);
      expect(listings).toBeGreaterThan(before);
      resumed.socket.close();
    } finally {
      server.stop();
    }
  }, 20_000);
});
