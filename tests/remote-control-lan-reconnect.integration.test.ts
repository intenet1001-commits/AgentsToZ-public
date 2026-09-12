/**
 * The phone-survives-the-night contract, exercised against a real listener and a real
 * WebSocket rather than by grepping the client bundle.
 *
 * An iPhone drops its WebSocket every time the screen locks or Safari backgrounds the tab.
 * The LAN host used to answer that by destroying the paired session, and the QR that would
 * re-pair is single use — so the only recovery was walking back to the Mac. These tests hold
 * the two halves that make an overnight session usable in the morning: `session.restore` has
 * to reach its handler, and a closed socket must not be treated as a revoked connection.
 *
 * Gated on a real RFC1918 address because the listener refuses to bind anything else; a
 * machine without one skips instead of reporting a failure it cannot have.
 */
import { describe, expect, test } from 'bun:test';
import { networkInterfaces } from 'node:os';
import { RemoteControlLanServer, isPrivateRemoteControlIpv4 } from '../src/remoteControlLanServer';
import {
  REMOTE_CONTROL_MAX_SESSIONS,
  REMOTE_CONTROL_PROTOCOL_VERSION,
  parseRemoteControlClientMessage,
  RemoteControlError,
  type RemoteControlGateway,
} from '../src/remoteControlCore';

const gateway: RemoteControlGateway = {
  listRegisteredProjects: () => [],
  executeRegisteredProjectAction: () => undefined,
};

const project = {
  internalId: 'p1',
  name: 'Fixture',
  port: null,
  command: null,
  kind: 'main' as const,
  folderPath: '/tmp/fixture-project',
  status: 'unknown' as const,
  actions: ['folder.open'],
};

function privateAddress(): string | null {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal && isPrivateRemoteControlIpv4(entry.address)) {
        return entry.address;
      }
    }
  }
  return null;
}

function tokenFrom(pairingUrl: string): string {
  const token = new URL(pairingUrl).hash.replace(/^#pair=/, '');
  if (!token) throw new Error('pairing URL carried no token');
  return token;
}

/** Resolves with the first message the host sends, or rejects rather than hanging the suite. */
function connect(origin: string): Promise<{ socket: WebSocket; next: () => Promise<any> }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${origin.replace('http://', 'ws://')}/remote/ws`, {
      headers: { Origin: origin },
    } as unknown as string[]);
    const inbox: any[] = [];
    let waiting: ((value: any) => void) | null = null;
    socket.addEventListener('message', event => {
      const parsed = JSON.parse(String((event as MessageEvent).data));
      if (waiting) { const resume = waiting; waiting = null; resume(parsed); }
      else inbox.push(parsed);
    });
    socket.addEventListener('error', () => reject(new Error('WebSocket failed to open')));
    socket.addEventListener('open', () => resolve({
      socket,
      next: () => inbox.length
        ? Promise.resolve(inbox.shift())
        : Promise.race([
          new Promise<any>(done => { waiting = done; }),
          new Promise<any>((_, fail) => setTimeout(() => fail(new Error('host sent nothing within 5s')), 5_000)),
        ]),
    }));
  });
}

const closed = (socket: WebSocket) => new Promise<void>(done => {
  // The host closes first on a policy violation, and a 'close' listener added afterwards never
  // fires — waiting on it hangs the whole suite instead of failing.
  if (socket.readyState === WebSocket.CLOSED) { done(); return; }
  socket.addEventListener('close', () => done(), { once: true });
  socket.close();
});

/** The client's close event can land before the host runs its own close callback. */
async function until(predicate: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise(resume => setTimeout(resume, 20));
  }
  throw new Error('host never observed: ' + what);
}

describe('session.end parsing', () => {
  const end = {
    type: 'session.end' as const,
    protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION,
    sessionToken: 'a'.repeat(43),
  };

  test('a controller can say it is leaving for good', () => {
    // A plain close now means "away". Without this frame there is no way for a phone to end its
    // own session, so one the user disconnected stayed listed on the Mac until its 30-day TTL.
    expect(parseRemoteControlClientMessage(end)).toEqual(end);
  });

  test('it is as strict as every other client message', () => {
    for (const broken of [
      { ...end, extra: 1 },
      { ...end, protocolVersion: 'agentstoz-local-v1' },
      { ...end, sessionToken: 'short' },
      { type: 'session.end', protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION },
    ]) {
      expect(() => parseRemoteControlClientMessage(broken)).toThrow(RemoteControlError);
    }
  });
});

describe('session.restore parsing', () => {
  const restore = {
    type: 'session.restore' as const,
    protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION,
    sessionToken: 'a'.repeat(43),
  };

  test('a well-formed restore reaches the caller instead of being refused as a disallowed action', () => {
    expect(parseRemoteControlClientMessage(restore)).toEqual(restore);
  });

  test('restore keeps the same strictness as every other client message', () => {
    for (const broken of [
      { ...restore, extra: 1 },
      { ...restore, protocolVersion: 'agentstoz-local-v1' },
      { ...restore, sessionToken: 'short' },
      { ...restore, sessionToken: 'a'.repeat(43) + '/' },
      { type: 'session.restore', protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION },
    ]) {
      expect(() => parseRemoteControlClientMessage(broken)).toThrow(RemoteControlError);
    }
  });
});

const address = privateAddress();
const scenario = address ? describe : describe.skip;

scenario('a locked phone can come back without the Mac', () => {
  test('the session survives the socket, restores on the same id, and revoking still ends it', async () => {
    const server = new RemoteControlLanServer({ bindAddress: address!, hostName: 'Test Mac', gateway });
    const { pairing } = server.start();
    const origin = new URL(pairing.pairingUrl).origin;
    try {
      const first = await connect(origin);
      first.socket.send(JSON.stringify({
        type: 'controller.pair',
        protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION,
        token: tokenFrom(pairing.pairingUrl),
      }));
      const ready = await first.next();
      expect(ready.type).toBe('session.ready');
      const sessionToken: string = ready.sessionToken;
      const paired = server.status().sessions;
      expect(paired).toHaveLength(1);

      // The screen locks.
      await closed(first.socket);
      await until(() => (server.status().sessions[0]?.label ?? '').includes('연결 대기'), 'the socket closing');
      const away = server.status().sessions;
      expect(away).toHaveLength(1);
      expect(away[0]!.id).toBe(paired[0]!.id);
      expect(away[0]!.connected).toBe(false);
      expect(away[0]!.label).toContain('연결 대기');

      // The morning: the same phone reopens the page and resumes from its stored token.
      const second = await connect(origin);
      second.socket.send(JSON.stringify({
        type: 'session.restore',
        protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION,
        sessionToken,
      }));
      const restored = await second.next();
      expect(restored.type).toBe('session.restored');
      expect(restored.sessionToken).toBe(sessionToken);

      const back = server.status().sessions;
      expect(back).toHaveLength(1);
      expect(back[0]!.connected).toBe(true);
      // The phone is the same device — same pairing moment — but the management id is new, so
      // any AI terminal grant given to the previous connection does not come back with it.
      expect(back[0]!.pairedAt).toBe(paired[0]!.pairedAt);
      expect(back[0]!.id).not.toBe(paired[0]!.id);
      expect(back[0]!.label).not.toContain('연결 대기');

      // Revoking is still a real end, not a pause.
      server.revokeSession(back[0]!.id);
      expect(server.status().sessions).toHaveLength(0);
      await closed(second.socket);

      const third = await connect(origin);
      third.socket.send(JSON.stringify({
        type: 'session.restore',
        protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION,
        sessionToken,
      }));
      const refused = await third.next();
      expect(refused.type).toBe('error');
      expect(server.status().sessions).toHaveLength(0);
      await closed(third.socket);
    } finally {
      server.stop();
    }
  }, 20_000);
});

scenario('a connection that ends mid-request does not get to act on its way out', () => {
  test('restoring evicts the socket that held the token, and a disconnect cancels a pending action', async () => {
    // Both halves failed for the same reason: keeping the session alive across a socket close
    // removed the thing that used to cancel work in flight. Neither is caught by the reconnect
    // test above, which closes the old socket first and runs no action across the gap.
    const dispatched: string[] = [];
    let releaseLookup: (() => void) | null = null;
    const stalling: RemoteControlGateway = {
      listRegisteredProjects: () => {
        if (!releaseLookup) return [project] as never;
        return [project] as never;
      },
      executeRegisteredProjectAction: action => { dispatched.push(action.action); },
    };
    const server = new RemoteControlLanServer({ bindAddress: address!, hostName: 'Test Mac', gateway: stalling });
    const { pairing } = server.start();
    const origin = new URL(pairing.pairingUrl).origin;
    try {
      const first = await connect(origin);
      first.socket.send(JSON.stringify({
        type: 'controller.pair',
        protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION,
        token: tokenFrom(pairing.pairingUrl),
      }));
      const ready = await first.next();
      expect(ready.type).toBe('session.ready');
      const sessionToken: string = ready.sessionToken;
      const controlId: string = ready.projects[0].controlId;

      // The old socket is still open when a second one restores the same token.
      const second = await connect(origin);
      second.socket.send(JSON.stringify({
        type: 'session.restore',
        protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION,
        sessionToken,
      }));
      expect((await second.next()).type).toBe('session.restored');
      await until(() => first.socket.readyState === WebSocket.CLOSED, 'the superseded socket closing');
      expect(server.status().sessions).toHaveLength(1);

      // The surviving socket asks for an action, then goes away before the host finishes
      // rebuilding project authority. The action must not reach the gateway.
      let releaseRefresh!: () => void;
      let lookupEntered = false;
      const stalled = new Promise<void>(resume => { releaseRefresh = resume; });
      let stall = false;
      stalling.listRegisteredProjects = (() => {
        if (!stall) return [project];
        stall = false;
        lookupEntered = true;
        return stalled.then(() => [project]);
      }) as never;
      stall = true;
      second.socket.send(JSON.stringify({
        type: 'action.request',
        protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION,
        sessionToken,
        actionId: '11111111-1111-4111-8111-111111111111',
        action: 'folder.open',
        controlId,
        remoteConfirmed: true,
      }));
      // Wait for the authorization lookup to actually be in flight. Sleeping a fixed time instead
      // lets a slow message pump turn this into "the request was never processed", which passes
      // for the wrong reason and would keep passing with the fix reverted.
      await until(() => lookupEntered, 'the authorization lookup starting');
      await closed(second.socket);
      // Release only once the host has actually seen the close, otherwise the action resumes
      // while the server still believes the socket is attached and the test proves nothing.
      await until(() => server.status().sessions[0]?.connected === false, 'the socket closing');
      releaseRefresh();
      // Replaying the same actionId returns the original request's cached outcome, which is a
      // completion signal rather than a guess about elapsed time — and it says out loud that the
      // action was cancelled instead of merely not observed yet.
      const replay = await connect(origin);
      replay.socket.send(JSON.stringify({
        type: 'session.restore',
        protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION,
        sessionToken,
      }));
      expect((await replay.next()).type).toBe('session.restored');
      replay.socket.send(JSON.stringify({
        type: 'action.request',
        protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION,
        sessionToken,
        actionId: '11111111-1111-4111-8111-111111111111',
        action: 'folder.open',
        controlId,
        remoteConfirmed: true,
      }));
      const abandoned = await replay.next();
      expect(abandoned).toMatchObject({ type: 'action.result', ok: false, error: { code: 'SESSION_DISCONNECTED' } });
      expect(dispatched).toEqual([]);
      await closed(replay.socket);

      // The same abandoned action must stay cancelled when a THIRD socket restores the session
      // while it is parked. Asking "is anyone connected?" would answer yes and run it.
      let releaseSecondRefresh!: () => void;
      let secondLookupEntered = false;
      const stalledAgain = new Promise<void>(resume => { releaseSecondRefresh = resume; });
      const third = await connect(origin);
      third.socket.send(JSON.stringify({
        type: 'session.restore',
        protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION,
        sessionToken,
      }));
      expect((await third.next()).type).toBe('session.restored');
      let stallAgain = false;
      stalling.listRegisteredProjects = (() => {
        if (!stallAgain) return [project];
        stallAgain = false;
        secondLookupEntered = true;
        return stalledAgain.then(() => [project]);
      }) as never;
      stallAgain = true;
      third.socket.send(JSON.stringify({
        type: 'action.request',
        protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION,
        sessionToken,
        actionId: '22222222-2222-4222-8222-222222222222',
        action: 'folder.open',
        controlId,
        remoteConfirmed: true,
      }));
      await until(() => secondLookupEntered, 'the second authorization lookup starting');
      const fourth = await connect(origin);
      fourth.socket.send(JSON.stringify({
        type: 'session.restore',
        protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION,
        sessionToken,
      }));
      expect((await fourth.next()).type).toBe('session.restored');
      await until(() => server.status().sessions[0]?.connected === true, 'the replacement attaching');
      releaseSecondRefresh();
      fourth.socket.send(JSON.stringify({
        type: 'action.request',
        protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION,
        sessionToken,
        actionId: '22222222-2222-4222-8222-222222222222',
        action: 'folder.open',
        controlId,
        remoteConfirmed: true,
      }));
      const takenOver = await fourth.next();
      expect(takenOver).toMatchObject({ type: 'action.result', ok: false, error: { code: 'SESSION_DISCONNECTED' } });
      expect(dispatched).toEqual([]);
      await closed(fourth.socket);
    } finally {
      server.stop();
    }
  }, 20_000);
});

scenario('a restart is not a re-pair', () => {
  test('the listener comes back on the same port and the phone resumes with its own token', async () => {
    // The listener used to live only in a module variable on an ephemeral port, so an app update
    // closed it, dropped every paired phone, and changed the URL the QR encodes. Whatever the
    // process writes down has to be enough to bring both back.
    let persisted: { bindAddress: string; port: number; sessions: readonly any[] } | null = null;
    const first = new RemoteControlLanServer({
      bindAddress: address!,
      hostName: 'Test Mac',
      gateway,
      onRecordChanged: value => { persisted = value ? { ...value, sessions: value.sessions.map(s => ({ ...s })) } : null; },
    });
    const started = first.start();
    const origin = new URL(started.pairing.pairingUrl).origin;
    const port = started.status.listener!.port;
    let sessionToken = '';
    try {
      const phone = await connect(origin);
      phone.socket.send(JSON.stringify({
        type: 'controller.pair',
        protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION,
        token: tokenFrom(started.pairing.pairingUrl),
      }));
      const ready = await phone.next();
      expect(ready.type).toBe('session.ready');
      sessionToken = ready.sessionToken;
      expect(persisted).not.toBeNull();
      expect(persisted!.port).toBe(port);
      expect(persisted!.sessions.map((entry: any) => entry.sessionToken)).toEqual([sessionToken]);
      await closed(phone.socket);
    } finally {
      // keepRecord mirrors a crash or an update: the operator did not turn anything off.
      first.stop({ keepRecord: true });
    }

    const second = new RemoteControlLanServer({
      bindAddress: address!,
      hostName: 'Test Mac',
      gateway,
      port: persisted!.port,
      restore: { sessions: persisted!.sessions as never },
    });
    const resumed = second.start();
    try {
      // Same URL, and the phone is listed as away rather than gone.
      expect(resumed.status.listener!.port).toBe(port);
      expect(resumed.status.sessions).toHaveLength(1);
      expect(resumed.status.sessions[0]!.connected).toBe(false);

      const morning = await connect(new URL(resumed.pairing.pairingUrl).origin);
      morning.socket.send(JSON.stringify({
        type: 'session.restore',
        protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION,
        sessionToken,
      }));
      const restored = await morning.next();
      expect(restored.type).toBe('session.restored');
      expect(second.status().sessions[0]!.connected).toBe(true);
      await closed(morning.socket);
    } finally {
      second.stop();
    }
  }, 20_000);

  test('an operator disable forgets the phones; only a kept record brings them back', async () => {
    let persisted: unknown = undefined;
    const server = new RemoteControlLanServer({
      bindAddress: address!,
      hostName: 'Test Mac',
      gateway,
      onRecordChanged: value => { persisted = value; },
    });
    const started = server.start();
    const phone = await connect(new URL(started.pairing.pairingUrl).origin);
    phone.socket.send(JSON.stringify({
      type: 'controller.pair',
      protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION,
      token: tokenFrom(started.pairing.pairingUrl),
    }));
    expect((await phone.next()).type).toBe('session.ready');
    await closed(phone.socket);

    server.stop();
    // Turning it off means turning it off: the next startup must find nothing to resume.
    expect(persisted).toBeNull();
  }, 20_000);
});

scenario('what a restart must not bring back', () => {
  test('a policy close, a revoke and a preserving teardown each leave the right record', async () => {
    let persisted: any = undefined;
    const server = new RemoteControlLanServer({
      bindAddress: address!,
      hostName: 'Test Mac',
      gateway,
      onRecordChanged: value => { persisted = value ? { ...value, sessions: value.sessions.map((s: any) => ({ ...s })) } : null; },
    });
    const started = server.start();
    const origin = new URL(started.pairing.pairingUrl).origin;
    try {
      // A client that gets itself policy-closed keeps its token; the record must not.
      const rude = await connect(origin);
      rude.socket.send(JSON.stringify({
        type: 'controller.pair',
        protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION,
        token: tokenFrom(started.pairing.pairingUrl),
      }));
      const rudeReady = await rude.next();
      expect(rudeReady.type).toBe('session.ready');
      expect(persisted.sessions).toHaveLength(1);
      rude.socket.send('not json at all');
      await until(() => Array.isArray(persisted?.sessions) && persisted.sessions.length === 0,
        'the policy close reaching the record');
      await closed(rude.socket);

      // A revoke has to be durable before it is reported.
      const revoked = await connect(origin);
      const rotated = server.rotatePairing();
      revoked.socket.send(JSON.stringify({
        type: 'controller.pair',
        protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION,
        token: tokenFrom(rotated.pairingUrl),
      }));
      expect((await revoked.next()).type).toBe('session.ready');
      expect(persisted.sessions).toHaveLength(1);
      server.revokeSession(server.status().sessions[0]!.id);
      expect(persisted.sessions).toHaveLength(0);
      await closed(revoked.socket);
    } finally {
      server.stop();
    }
  }, 20_000);

  test('a preserving teardown does not tell a connected phone to forget its token', async () => {
    let persisted: any = undefined;
    const server = new RemoteControlLanServer({
      bindAddress: address!,
      hostName: 'Test Mac',
      gateway,
      onRecordChanged: value => { persisted = value ? { ...value, sessions: value.sessions.map((s: any) => ({ ...s })) } : null; },
    });
    const started = server.start();
    const phone = await connect(new URL(started.pairing.pairingUrl).origin);
    const closes: number[] = [];
    phone.socket.addEventListener('close', event => closes.push((event as CloseEvent).code), { once: true });
    const ended: unknown[] = [];
    phone.socket.addEventListener('message', event => {
      const parsed = JSON.parse(String((event as MessageEvent).data));
      if (parsed.type === 'session.closed') ended.push(parsed);
    });
    phone.socket.send(JSON.stringify({
      type: 'controller.pair',
      protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION,
      token: tokenFrom(started.pairing.pairingUrl),
    }));
    expect((await phone.next()).type).toBe('session.ready');

    // A crash or an update, not the operator: the phone clears its stored token on session.closed
    // and on close codes 1000/1001/1008, so a preserving teardown must use none of them.
    server.stop({ keepRecord: true });
    await until(() => closes.length > 0, 'the socket closing');
    expect(ended).toEqual([]);
    expect(closes[0]).toBe(1012);
    expect(persisted.sessions).toHaveLength(1);
  }, 20_000);
});

scenario('an away phone does not lock the operator out', () => {
  test('a freshly scanned QR retires the longest-idle detached session instead of being refused', async () => {
    // Sessions outliving their sockets means "away" sessions hold slots. A client that reconnects
    // by scanning a new QR each time — which is what the native iOS app does, since its webview
    // uses a non-persistent store and cannot session.restore — filled all eight and the ninth
    // pairing was refused. Measured against the core directly: pairs 1-8 ok, 9 SESSION_LIMIT.
    const server = new RemoteControlLanServer({ bindAddress: address!, hostName: 'Test Mac', gateway });
    let pairing = server.start().pairing;
    const origin = new URL(pairing.pairingUrl).origin;
    const sockets: WebSocket[] = [];
    try {
      const pairOnce = async () => {
        const phone = await connect(origin);
        sockets.push(phone.socket);
        phone.socket.send(JSON.stringify({
          type: 'controller.pair',
          protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION,
          token: tokenFrom(pairing.pairingUrl),
        }));
        const ready = await phone.next();
        pairing = server.rotatePairing();
        return { phone, ready };
      };

      // Eight phones that came and went.
      const first = await pairOnce();
      expect(first.ready.type).toBe('session.ready');
      const firstId = server.status().sessions[0]!.id;
      await closed(first.phone.socket);
      await until(() => server.status().sessions[0]?.connected === false, 'the first socket closing');
      for (let n = 1; n < REMOTE_CONTROL_MAX_SESSIONS; n += 1) {
        const later = await pairOnce();
        expect(later.ready.type).toBe('session.ready');
        await closed(later.phone.socket);
      }
      await until(() => server.status().sessions.every(session => !session.connected), 'every socket closing');
      expect(server.status().sessions).toHaveLength(REMOTE_CONTROL_MAX_SESSIONS);

      // The ninth scan is an explicit act by the operator; the oldest phone that is merely away
      // gives up its slot rather than the scan failing.
      const ninth = await pairOnce();
      expect(ninth.ready.type).toBe('session.ready');
      const after = server.status();
      expect(after.sessions).toHaveLength(REMOTE_CONTROL_MAX_SESSIONS);
      expect(after.sessions.map(session => session.id)).not.toContain(firstId);
      expect(after.sessions.filter(session => session.connected)).toHaveLength(1);
    } finally {
      for (const socket of sockets) { try { socket.close(); } catch { /* already closed */ } }
      server.stop();
    }
  }, 30_000);

  test('eight phones that are actually connected still refuse a ninth', async () => {
    // The limit is a limit on connections, not a suggestion: nothing here is idle to retire.
    const server = new RemoteControlLanServer({ bindAddress: address!, hostName: 'Test Mac', gateway });
    let pairing = server.start().pairing;
    const origin = new URL(pairing.pairingUrl).origin;
    const sockets: WebSocket[] = [];
    try {
      for (let n = 0; n < REMOTE_CONTROL_MAX_SESSIONS; n += 1) {
        const phone = await connect(origin);
        sockets.push(phone.socket);
        phone.socket.send(JSON.stringify({
          type: 'controller.pair',
          protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION,
          token: tokenFrom(pairing.pairingUrl),
        }));
        expect((await phone.next()).type).toBe('session.ready');
        pairing = server.rotatePairing();
      }
      expect(server.status().sessions.filter(session => session.connected)).toHaveLength(REMOTE_CONTROL_MAX_SESSIONS);
      // The refusal lands one layer earlier than the session limit: MAX_OPEN_SOCKETS caps live
      // connections, so a ninth phone is closed at the socket before it can present a QR. What
      // matters is that nothing was retired to let it in — eight live phones stay eight.
      const ninth = await connect(origin);
      sockets.push(ninth.socket);
      const ninthClosed = new Promise<number>(resolve => {
        ninth.socket.addEventListener('close', event => resolve((event as CloseEvent).code), { once: true });
      });
      ninth.socket.send(JSON.stringify({
        type: 'controller.pair',
        protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION,
        token: tokenFrom(pairing.pairingUrl),
      }));
      expect(await ninthClosed).toBe(1008);
      expect(server.status().sessions).toHaveLength(REMOTE_CONTROL_MAX_SESSIONS);
      expect(server.status().sessions.filter(session => session.connected)).toHaveLength(REMOTE_CONTROL_MAX_SESSIONS);
    } finally {
      for (const socket of sockets) { try { socket.close(); } catch { /* already closed */ } }
      server.stop();
    }
  }, 30_000);
});

scenario('a phone can end its own session', () => {
  test('session.end removes it everywhere and needs this socket to own it', async () => {
    let persisted: any = undefined;
    const server = new RemoteControlLanServer({
      bindAddress: address!,
      hostName: 'Test Mac',
      gateway,
      onRecordChanged: value => { persisted = value ? { ...value, sessions: value.sessions.map((s: any) => ({ ...s })) } : null; },
    });
    const started = server.start();
    const origin = new URL(started.pairing.pairingUrl).origin;
    try {
      const phone = await connect(origin);
      phone.socket.send(JSON.stringify({
        type: 'controller.pair',
        protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION,
        token: tokenFrom(started.pairing.pairingUrl),
      }));
      const ready = await phone.next();
      expect(ready.type).toBe('session.ready');
      const sessionToken: string = ready.sessionToken;
      expect(server.status().sessions).toHaveLength(1);

      // Another socket must not be able to end someone else's session by quoting its token.
      const stranger = await connect(origin);
      stranger.socket.send(JSON.stringify({
        type: 'session.end',
        protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION,
        sessionToken,
      }));
      expect(await stranger.next()).toMatchObject({ type: 'error', code: 'INVALID_SESSION_TOKEN' });
      expect(server.status().sessions).toHaveLength(1);
      await closed(stranger.socket);

      phone.socket.send(JSON.stringify({
        type: 'session.end',
        protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION,
        sessionToken,
      }));
      await until(() => server.status().sessions.length === 0, 'the session ending');
      // Gone from the record too, or the next restart would bring back a phone that left.
      expect(persisted.sessions).toHaveLength(0);
      await closed(phone.socket);

      // And it really is over: the token no longer restores.
      const returning = await connect(origin);
      returning.socket.send(JSON.stringify({
        type: 'session.restore',
        protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION,
        sessionToken,
      }));
      expect((await returning.next()).type).toBe('error');
      await closed(returning.socket);
    } finally {
      server.stop();
    }
  }, 20_000);
});
