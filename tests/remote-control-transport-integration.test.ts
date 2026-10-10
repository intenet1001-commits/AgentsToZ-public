import { describe, expect, test } from 'bun:test';
import { networkInterfaces } from 'node:os';
import {
  RemoteControlLanServer,
  isPrivateRemoteControlIpv4,
} from '../src/remoteControlLanServer';
import {
  REMOTE_CONTROL_PROTOCOL_VERSION,
  type RemoteControlGateway,
  type RemoteControlPairingDescriptor,
} from '../src/remoteControlCore';

const BunWebSocket = WebSocket as unknown as {
  new(url: string, options: { headers: Record<string, string> }): WebSocket;
};

const emptyGateway: RemoteControlGateway = {
  listRegisteredProjects: () => [],
  executeRegisteredProjectAction: () => undefined,
};

type ObservedSocket = {
  socket: WebSocket;
  opened: Promise<void>;
  closed: Promise<CloseEvent>;
};

function hostPrivateIpv4(): string | null {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (!entry.internal && entry.family === 'IPv4' && isPrivateRemoteControlIpv4(entry.address)) {
        return entry.address;
      }
    }
  }
  return null;
}

function observedSocket(origin: string): ObservedSocket {
  const socket = new BunWebSocket(origin.replace(/^http:/, 'ws:') + '/remote/ws', {
    headers: { Origin: origin },
  });
  const opened = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('WebSocket open timed out')), 5_000);
    socket.addEventListener('open', () => {
      clearTimeout(timeout);
      resolve();
    }, { once: true });
    socket.addEventListener('error', () => {
      clearTimeout(timeout);
      reject(new Error('WebSocket open failed'));
    }, { once: true });
  });
  const closed = new Promise<CloseEvent>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('WebSocket close timed out')), 5_000);
    socket.addEventListener('close', event => {
      clearTimeout(timeout);
      resolve(event);
    }, { once: true });
  });
  // Expected close tests always await this promise. Suppress an early timeout
  // from becoming an unhandled rejection while a prior assertion is running.
  void closed.catch(() => undefined);
  return { socket, opened, closed };
}

function waitForJsonMessage(
  socket: WebSocket,
  predicate: (message: Record<string, any>) => boolean,
  label: string,
): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error(`${label} timed out`)), 5_000);
    const onMessage = (event: MessageEvent) => {
      let message: Record<string, any>;
      try { message = JSON.parse(String(event.data)); }
      catch { return; }
      if (predicate(message)) finish(null, message);
    };
    const onClose = () => finish(new Error(`${label} socket closed before message`));
    const finish = (error: Error | null, message?: Record<string, any>) => {
      clearTimeout(timeout);
      socket.removeEventListener('message', onMessage);
      socket.removeEventListener('close', onClose);
      if (error) reject(error);
      else resolve(message!);
    };
    socket.addEventListener('message', onMessage);
    socket.addEventListener('close', onClose);
  });
}

function pairingToken(pairing: RemoteControlPairingDescriptor): { origin: string; token: string } {
  const url = new URL(pairing.pairingUrl);
  const token = new URLSearchParams(url.hash.slice(1)).get('pair');
  if (!token) throw new Error('pairing descriptor did not contain a token');
  return { origin: url.origin, token };
}

async function pairSocket(
  pairing: RemoteControlPairingDescriptor,
): Promise<{ observed: ObservedSocket; ready: Record<string, any> }> {
  const { origin, token } = pairingToken(pairing);
  const observed = observedSocket(origin);
  const readyMessage = waitForJsonMessage(
    observed.socket,
    message => message.type === 'session.ready',
    'session.ready',
  );
  await observed.opened;
  observed.socket.send(JSON.stringify({
    type: 'controller.pair',
    protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION,
    token,
  }));
  return { observed, ready: await readyMessage };
}

function stopQuietly(server: RemoteControlLanServer, sockets: readonly WebSocket[] = []): void {
  for (const socket of sockets) {
    try { socket.close(); } catch {}
  }
  try { server.stop(); } catch {}
}

describe('QR remote-control real WebSocket transport limits', () => {
  test('the native transport closes frames above 32 KiB without application dispatch', async () => {
    const address=hostPrivateIpv4();if(!address)return;
    let dispatched=0;
    const server=new RemoteControlLanServer({bindAddress:address,hostName:'Native size fixture',gateway:{
      listRegisteredProjects:()=>{dispatched++;return[];},executeRegisteredProjectAction:()=>{dispatched++;},
    }});
    const {origin}=pairingToken(server.start().pairing);const observed=observedSocket(origin);
    const messages:string[]=[];observed.socket.addEventListener('message',event=>messages.push(String(event.data)));
    try {
      await observed.opened;observed.socket.send('x'.repeat(32*1024+1));
      const closed=await observed.closed;
      expect(closed.code).toBe(1006);
      expect(dispatched).toBe(0);expect(messages).toEqual([]);
    } finally {stopQuietly(server,[observed.socket]);}
  });

  test('sends a fixed public error and closes payloads above 16 KiB', async () => {
    const address = hostPrivateIpv4();
    if (!address) return;
    const server = new RemoteControlLanServer({ bindAddress: address, hostName: 'Mac', gateway: emptyGateway });
    const started = server.start();
    const { origin } = pairingToken(started.pairing);
    const observed = observedSocket(origin);
    try {
      await observed.opened;
      const errorMessage = waitForJsonMessage(
        observed.socket,
        message => message.type === 'error',
        'oversize error',
      );
      observed.socket.send('x'.repeat((16 * 1024) + 1));
      expect(await errorMessage).toEqual({
        type: 'error',
        code: 'MESSAGE_TOO_LARGE',
        message: '원격 제어 메시지가 너무 큽니다.',
      });
      const closed = await observed.closed;
      expect(closed.code).toBe(1008);
      expect(closed.reason).toBe('MESSAGE_TOO_LARGE');
    } finally {
      stopQuietly(server, [observed.socket]);
    }
  });

  test('allows eight open sockets and policy-closes the ninth', async () => {
    const address = hostPrivateIpv4();
    if (!address) return;
    const server = new RemoteControlLanServer({ bindAddress: address, hostName: 'Mac', gateway: emptyGateway });
    const started = server.start();
    const { origin } = pairingToken(started.pairing);
    const sockets: ObservedSocket[] = [];
    try {
      for (let index = 0; index < 9; index += 1) {
        const observed = observedSocket(origin);
        sockets.push(observed);
        await observed.opened;
      }
      const ninthClose = await sockets[8]!.closed;
      expect(ninthClose.code).toBe(1008);
      expect(ninthClose.reason).toBe('too many connections');
      expect(sockets.slice(0, 8).every(entry => entry.socket.readyState === WebSocket.OPEN)).toBe(true);
    } finally {
      stopQuietly(server, sockets.map(entry => entry.socket));
    }
  });

  test('policy-closes the eleventh wire message inside one second', async () => {
    const address = hostPrivateIpv4();
    if (!address) return;
    const server = new RemoteControlLanServer({
      bindAddress: address,
      hostName: 'Mac',
      gateway: emptyGateway,
      maxActionsPerRateWindow: 100,
    });
    const started = server.start();
    const { observed, ready } = await pairSocket(started.pairing);
    try {
      const errorMessage = waitForJsonMessage(
        observed.socket,
        message => message.type === 'error' && message.code === 'RATE_LIMITED',
        'wire rate error',
      );
      for (let index = 0; index < 10; index += 1) {
        observed.socket.send(JSON.stringify({
          type: 'action.request',
          protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION,
          sessionToken: ready.sessionToken,
          actionId: `wire-rate-${index}`,
          action: 'projects.list',
        }));
      }
      const error = await errorMessage;
      expect(error).toEqual({
        type: 'error',
        code: 'RATE_LIMITED',
        message: '원격 제어 요청이 너무 빠릅니다.',
      });
      const closed = await observed.closed;
      expect(closed.code).toBe(1008);
      expect(closed.reason).toBe('RATE_LIMITED');
    } finally {
      stopQuietly(server, [observed.socket]);
    }
  });

  test('closes an unpaired socket when its transport deadline passes', async () => {
    const address = hostPrivateIpv4();
    if (!address) return;
    let now = Date.UTC(2026, 7, 30, 12, 0, 0);
    const server = new RemoteControlLanServer({
      bindAddress: address,
      hostName: 'Mac',
      gateway: emptyGateway,
      now: () => now,
    });
    const started = server.start();
    const { origin } = pairingToken(started.pairing);
    const observed = observedSocket(origin);
    try {
      await observed.opened;
      now += 30_001;
      server.status();
      const closed = await observed.closed;
      expect(closed.code).toBe(1008);
      expect(closed.reason).toBe('pairing timeout');
    } finally {
      stopQuietly(server, [observed.socket]);
    }
  });

  test('revoke emits session.closed before closing the paired socket', async () => {
    const address = hostPrivateIpv4();
    if (!address) return;
    const server = new RemoteControlLanServer({ bindAddress: address, hostName: 'Mac', gateway: emptyGateway });
    const started = server.start();
    const { observed } = await pairSocket(started.pairing);
    try {
      const session = server.status().sessions[0];
      expect(session?.id).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
      const closedMessage = waitForJsonMessage(
        observed.socket,
        message => message.type === 'session.closed',
        'revoked session.closed',
      );
      const status = server.revokeSession(session!.id);
      expect(status.sessions).toEqual([]);
      expect((await closedMessage).reason).toContain('해제');
      const closed = await observed.closed;
      expect(closed.code).toBe(1000);
      expect(closed.reason).toBe('session revoked');
    } finally {
      stopQuietly(server, [observed.socket]);
    }
  });

  test('idle expiry emits session.closed before closing the paired socket', async () => {
    const address = hostPrivateIpv4();
    if (!address) return;
    let now = Date.UTC(2026, 7, 30, 12, 0, 0);
    const server = new RemoteControlLanServer({
      bindAddress: address,
      hostName: 'Mac',
      gateway: emptyGateway,
      now: () => now,
      idleTtlMs: 50,
      absoluteTtlMs: 1_000,
    });
    const started = server.start();
    const { observed } = await pairSocket(started.pairing);
    try {
      const closedMessage = waitForJsonMessage(
        observed.socket,
        message => message.type === 'session.closed',
        'expired session.closed',
      );
      now += 51;
      const status = server.status();
      expect(status.sessions).toEqual([]);
      expect((await closedMessage).reason).toContain('활동이 없어');
      const closed = await observed.closed;
      expect(closed.code).toBe(1000);
      expect(closed.reason).toBe('session expired');
    } finally {
      stopQuietly(server, [observed.socket]);
    }
  });
});
