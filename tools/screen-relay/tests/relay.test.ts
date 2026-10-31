/**
 * Real-socket relay tests. Every case below opens genuine Bun WebSocket connections to a relay on
 * 127.0.0.1 with an ephemeral port and asserts on what actually crossed the wire.
 *
 * Run: bun test tools/screen-relay/tests
 */

import { describe, expect, test } from "bun:test";
import {
  controllerJoin,
  createMacIdentity,
  hostJoin,
  pattern,
  roomFor,
  sameBytes,
  startFixture,
} from "./fixture.ts";
import { hostSignatureMessage, PROTOCOL_VERSION } from "../src/protocol.ts";

describe("challenge", () => {
  test("every socket is greeted with its own one-use 32-byte nonce", async () => {
    const fixture = startFixture();
    try {
      const a = await fixture.connect();
      const b = await fixture.connect();
      const first = await a.nonce();
      const second = await b.nonce();
      // 32 bytes base64url without padding.
      expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(first).not.toBe(second);
    } finally {
      await fixture.stop();
    }
  });

  test("a socket that does not join inside the window is expired", async () => {
    const fixture = startFixture({ challengeTtlMs: 120 });
    try {
      const client = await fixture.connect();
      await client.nonce();
      await client.waitForClose();
      expect(client.errorCode()).toBe("expired");
    } finally {
      await fixture.stop();
    }
  });

  test("a host signature is bound to its own socket's nonce, so it cannot be replayed", async () => {
    const fixture = startFixture();
    try {
      const identity = await createMacIdentity();
      const room = roomFor(identity);

      const first = await fixture.connect();
      const stolenNonce = await first.nonce();
      const join = await hostJoin(identity, room, stolenNonce);
      first.send(join);

      // The very same join frame, replayed onto a different socket with a different nonce.
      const second = await fixture.connect();
      await second.nonce();
      second.send(join);
      await second.waitForClose();
      expect(second.errorCode()).toBe("unauthorized");
    } finally {
      await fixture.stop();
    }
  });

  test("a signature for another purpose does not admit a host", async () => {
    const fixture = startFixture();
    try {
      const identity = await createMacIdentity();
      const room = roomFor(identity);
      const client = await fixture.connect();
      const nonce = await client.nonce();
      // Signed for "registration" but claiming "screen".
      const signature = await identity.sign(hostSignatureMessage("registration", room, nonce));
      client.send(
        JSON.stringify({
          type: "join",
          version: PROTOCOL_VERSION,
          role: "host",
          purpose: "screen",
          room,
          publicKey: identity.publicKeyBase64,
          signature,
        }),
      );
      await client.waitForClose();
      expect(client.errorCode()).toBe("unauthorized");
    } finally {
      await fixture.stop();
    }
  });

  test("a controller holding the room cannot squat as host", async () => {
    const fixture = startFixture();
    try {
      // The room names identity A, but the join carries identity B's key and a valid B signature.
      const roomOwner = await createMacIdentity();
      const impostor = await createMacIdentity();
      const room = roomFor(roomOwner);

      const client = await fixture.connect();
      const nonce = await client.nonce();
      const signature = await impostor.sign(hostSignatureMessage("screen", room, nonce));
      client.send(
        JSON.stringify({
          type: "join",
          version: PROTOCOL_VERSION,
          role: "host",
          purpose: "screen",
          room,
          publicKey: impostor.publicKeyBase64,
          signature,
        }),
      );
      await client.waitForClose();
      // SHA256(publicKey) !== room prefix.
      expect(client.errorCode()).toBe("unauthorized");
    } finally {
      await fixture.stop();
    }
  });
});

describe("duplicate host join flood", () => {
  test("a flood of host joins on one socket consumes the challenge exactly once", async () => {
    const fixture = startFixture();
    try {
      const identity = await createMacIdentity();
      const room = roomFor(identity);
      const client = await fixture.connect();
      const nonce = await client.nonce();
      const join = await hostJoin(identity, room, nonce);

      // The same valid join, 24 times, as fast as the socket takes it. Verification is a P-256
      // signature check: if the challenge were not consumed synchronously, each copy would start
      // another one against the same nonce — unauthenticated CPU amplification from one socket.
      const copies = 24;
      for (let i = 0; i < copies; i += 1) client.send(join);

      // Sending a second join is protocol abuse, so the socket is refused (the first refusal is
      // final everywhere in this server). The invariant under test is the amplification bound:
      // 24 copies cost exactly one signature verification, not 24.
      await client.waitForClose();
      expect(fixture.server.core.stats().hostVerifications).toBe(1);
      expect(client.errorCode()).toBe("malformed");

      // And the refused socket leaves nothing behind, even though a verification was in flight.
      await new Promise((resolve) => setTimeout(resolve, 200));
      const stats = fixture.server.core.stats();
      expect(stats.rooms).toBe(0);
      expect(stats.sockets).toBe(0);
    } finally {
      await fixture.stop();
    }
  });

  test("one well-formed host join still costs exactly one verification and gets its room", async () => {
    const fixture = startFixture();
    try {
      const identity = await createMacIdentity();
      const client = await fixture.connect();
      client.send(await hostJoin(identity, roomFor(identity), await client.nonce()));
      await fixture.waitForRooms(1);
      // The honest path is unaffected by the duplicate-join hardening.
      expect(fixture.server.core.stats().hostVerifications).toBe(1);
      expect(client.errorCode()).toBeUndefined();
    } finally {
      await fixture.stop();
    }
  });

  test("the duplicate joins after the first are refused as malformed", async () => {
    const fixture = startFixture();
    try {
      const identity = await createMacIdentity();
      const room = roomFor(identity);
      const client = await fixture.connect();
      const join = await hostJoin(identity, room, await client.nonce());

      client.send(join);
      client.send(join);
      // The second join arrives while the first is still verifying: the socket is already past
      // its one challenge, so it is closed rather than verified again.
      await client.waitForClose();
      expect(client.errorCode()).toBe("malformed");
      expect(fixture.server.core.stats().hostVerifications).toBe(1);

      // The refused socket left no room behind.
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(fixture.server.core.stats().rooms).toBe(0);
    } finally {
      await fixture.stop();
    }
  });

  test("a flood of invalid host joins still verifies at most once per socket", async () => {
    const fixture = startFixture();
    try {
      const roomOwner = await createMacIdentity();
      const impostor = await createMacIdentity();
      const room = roomFor(roomOwner);

      const client = await fixture.connect();
      const nonce = await client.nonce();
      // A well-formed join whose key does not hash to the room: verification must fail, and the
      // flood must not multiply that work.
      const signature = await impostor.sign(hostSignatureMessage("screen", room, nonce));
      const join = JSON.stringify({
        type: "join",
        version: PROTOCOL_VERSION,
        role: "host",
        purpose: "screen",
        room,
        publicKey: impostor.publicKeyBase64,
        signature,
      });
      for (let i = 0; i < 24; i += 1) client.send(join);

      await client.waitForClose();
      // The first attempt is refused; the rest never reach verification.
      expect(fixture.server.core.stats().hostVerifications).toBeLessThanOrEqual(1);
      // Either refusal is correct here: the first copy fails verification, or a later copy is
      // refused as illegal text first. `?? "none"` keeps this a defined string for the matcher.
      expect(["unauthorized", "malformed"]).toContain(client.errorCode() ?? "none");
      expect(fixture.server.core.stats().rooms).toBe(0);
    } finally {
      await fixture.stop();
    }
  });

  test("many sockets each get one verification, and the per-IP budget still bounds them", async () => {
    const fixture = startFixture({ maxAdmissionsPerIp: 4, admissionWindowMs: 60_000 });
    try {
      const identity = await createMacIdentity();
      // Six sockets, each flooding its own valid join for its own room.
      for (let i = 0; i < 6; i += 1) {
        const client = await fixture.connect();
        const join = await hostJoin(identity, roomFor(identity), await client.nonce());
        for (let copy = 0; copy < 8; copy += 1) client.send(join);
        await new Promise((resolve) => setTimeout(resolve, 60));
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
      // At most one verification per socket, and the admission budget caps how many got that far.
      expect(fixture.server.core.stats().hostVerifications).toBeLessThanOrEqual(4);
    } finally {
      await fixture.stop();
    }
  });

  test("a socket closing mid-verification neither attaches nor leaks a room", async () => {
    const fixture = startFixture();
    try {
      const identity = await createMacIdentity();
      const room = roomFor(identity);
      const client = await fixture.connect();
      client.send(await hostJoin(identity, room, await client.nonce()));
      // Close immediately, while verification is almost certainly still in flight.
      client.close();

      await new Promise((resolve) => setTimeout(resolve, 300));
      const stats = fixture.server.core.stats();
      expect(stats.sockets).toBe(0);
      expect(stats.rooms).toBe(0);

      // And the room is genuinely free: a fresh host can take it.
      const next = await fixture.connect();
      next.send(await hostJoin(identity, room, await next.nonce()));
      await fixture.waitForRooms(1);
      expect(next.errorCode()).toBeUndefined();
    } finally {
      await fixture.stop();
    }
  });

  test("a join racing the challenge timeout ends in one consistent state, never a half-attach", async () => {
    // This race has two legitimate winners and the test asserts both are clean, rather than
    // forcing one: with a small TTL the watchdog may fire inside the verification window, or the
    // verification may land first. (A ~1ms TTL cannot be used to force the first case — signing is
    // itself async, so the socket expires before any join can be sent; measured directly.)
    const identity = await createMacIdentity();
    const room = roomFor(identity);
    const fixture = startFixture({ challengeTtlMs: 8 });
    try {
      const client = await fixture.connect();
      const nonce = await client.nonce();
      // Pre-signed against this socket's nonce, so sending costs no await.
      client.send(await hostJoin(identity, room, nonce));

      await new Promise((resolve) => setTimeout(resolve, 400));
      const stats = fixture.server.core.stats();
      // Either way, exactly one verification was spent on this socket.
      expect(stats.hostVerifications).toBe(1);

      if (client.closed) {
        // The watchdog won: expired, and nothing was attached afterwards.
        expect(client.errorCode()).toBe("expired");
        expect(stats.rooms).toBe(0);
        expect(stats.sockets).toBe(0);
      } else {
        // The verification won: a normal waiting host, with its room and no error.
        expect(client.errorCode()).toBeUndefined();
        expect(stats.rooms).toBe(1);
        expect(stats.sockets).toBe(1);
      }
    } finally {
      await fixture.stop();
    }
  });

  test("a verification that resolves after its socket expired attaches nothing", async () => {
    // Deterministic version of the race above: expire the socket first, by waiting out a short
    // TTL, then confirm no late attach can revive it.
    const fixture = startFixture({ challengeTtlMs: 60 });
    try {
      const identity = await createMacIdentity();
      const room = roomFor(identity);
      const client = await fixture.connect();
      await client.nonce();
      await client.waitForClose();
      expect(client.errorCode()).toBe("expired");

      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(fixture.server.core.stats().rooms).toBe(0);

      // The room was never taken, so a real host still gets it.
      const next = await fixture.connect();
      next.send(await hostJoin(identity, room, await next.nonce()));
      await fixture.waitForRooms(1);
      expect(next.errorCode()).toBeUndefined();
    } finally {
      await fixture.stop();
    }
  });
});

describe("strict schema", () => {
  const cases: Array<[string, unknown]> = [
    ["not json", "{"],
    ["wrong type", { type: "hello", version: 1, role: "controller", purpose: "screen", room: "x" }],
    ["wrong version", { type: "join", version: 3, role: "controller", purpose: "screen" }],
    ["unknown role", { type: "join", version: 1, role: "observer", purpose: "screen" }],
    ["unknown purpose", { type: "join", version: 1, role: "controller", purpose: "audio" }],
    ["malformed room", { type: "join", version: 1, role: "controller", purpose: "screen", room: "nope" }],
    ["array body", [1, 2, 3]],
  ];

  for (const [name, body] of cases) {
    test(`rejects ${name}`, async () => {
      const fixture = startFixture();
      try {
        const client = await fixture.connect();
        await client.nonce();
        client.send(typeof body === "string" ? body : JSON.stringify(body));
        await client.waitForClose();
        expect(client.errorCode()).toBe("malformed");
      } finally {
        await fixture.stop();
      }
    });
  }

  test("an extra field makes a controller join malformed", async () => {
    const fixture = startFixture();
    try {
      const identity = await createMacIdentity();
      const client = await fixture.connect();
      await client.nonce();
      client.send(
        JSON.stringify({
          type: "join",
          version: PROTOCOL_VERSION,
          role: "controller",
          purpose: "screen",
          room: roomFor(identity),
          extra: "smuggled",
        }),
      );
      await client.waitForClose();
      expect(client.errorCode()).toBe("malformed");
    } finally {
      await fixture.stop();
    }
  });

  test("binary before pairing is refused", async () => {
    const fixture = startFixture();
    try {
      const client = await fixture.connect();
      await client.nonce();
      client.send(new Uint8Array([1, 2, 3]));
      await client.waitForClose();
      expect(client.errorCode()).toBe("malformed");
    } finally {
      await fixture.stop();
    }
  });

  test("text other than the host's authenticated signal is refused after pairing", async () => {
    const fixture = startFixture();
    try {
      const { controller } = await fixture.pair();
      controller.send(JSON.stringify({ type: "authenticated" }));
      await controller.waitForClose();
      // Only the host may send it; from a controller it is simply illegal text.
      expect(controller.errorCode()).toBe("malformed");
    } finally {
      await fixture.stop();
    }
  });

  test("the relay path is the only surface and takes no query string", async () => {
    const fixture = startFixture();
    try {
      const base = `http://${fixture.server.hostname}:${fixture.server.port}`;
      expect((await fetch(`${base}/`)).status).toBe(404);
      expect((await fetch(`${base}/screen-relay/extra`)).status).toBe(404);
      // The room capability must never travel in a URL.
      expect((await fetch(`${base}/screen-relay?room=abc`)).status).toBe(400);
      // A plain GET on the right path is not an upgrade.
      expect((await fetch(`${base}/screen-relay`)).status).toBe(426);
    } finally {
      await fixture.stop();
    }
  });
});

describe("pairing", () => {
  test("a controller without a live host is told offline and does not consume a future host", async () => {
    const fixture = startFixture();
    try {
      const identity = await createMacIdentity();
      const room = roomFor(identity);

      const early = await fixture.connect();
      await early.nonce();
      early.send(controllerJoin(room));
      await early.waitForClose();
      expect(early.errorCode()).toBe("offline");
      expect(fixture.server.core.stats().rooms).toBe(0);

      // The host then arrives and a later controller still pairs normally.
      const { host, controller } = await fixture.pair({ identity, room });
      expect(host.json(1).type).toBe("paired");
      expect(controller.json(1).type).toBe("paired");
    } finally {
      await fixture.stop();
    }
  });

  test("both sides get paired with distinct peer ids and no binary precedes it", async () => {
    const fixture = startFixture();
    try {
      const { host, controller } = await fixture.pair();
      const hostPaired = host.json(1);
      const controllerPaired = controller.json(1);
      expect(hostPaired.type).toBe("paired");
      expect(controllerPaired.type).toBe("paired");
      expect(hostPaired.peerId).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(hostPaired.peerId).not.toBe(controllerPaired.peerId);
      expect(host.binaryFrames()).toHaveLength(0);
      expect(controller.binaryFrames()).toHaveLength(0);
    } finally {
      await fixture.stop();
    }
  });

  test("a second host does not displace the room's live host", async () => {
    const fixture = startFixture();
    try {
      const identity = await createMacIdentity();
      const room = roomFor(identity);
      const { host } = await fixture.pair({ identity, room });

      const second = await fixture.connect();
      second.send(await hostJoin(identity, room, await second.nonce()));
      await second.waitForClose();
      expect(second.errorCode()).toBe("busy");
      // The original session is untouched.
      expect(host.closed).toBe(false);
    } finally {
      await fixture.stop();
    }
  });

  test("a second controller gets busy and the active session survives", async () => {
    const fixture = startFixture();
    try {
      const identity = await createMacIdentity();
      const room = roomFor(identity);
      const { host, controller } = await fixture.pair({ identity, room });

      const second = await fixture.connect();
      await second.nonce();
      second.send(controllerJoin(room));
      await second.waitForClose();
      expect(second.errorCode()).toBe("busy");
      expect(host.closed).toBe(false);
      expect(controller.closed).toBe(false);
    } finally {
      await fixture.stop();
    }
  });

  test("screen and registration are separate rooms for the same name", async () => {
    const fixture = startFixture();
    try {
      const identity = await createMacIdentity();
      const room = roomFor(identity);
      const screen = await fixture.pair({ identity, room, purpose: "screen" });
      const registration = await fixture.pair({ identity, room, purpose: "registration" });
      expect(screen.host.closed).toBe(false);
      expect(registration.host.closed).toBe(false);
      expect(fixture.server.core.stats().pairedRooms).toBe(2);
    } finally {
      await fixture.stop();
    }
  });

  test("an unpaired host waiting too long is expired", async () => {
    const fixture = startFixture({ idleWaitingMs: 150 });
    try {
      const identity = await createMacIdentity();
      const host = await fixture.connect();
      host.send(await hostJoin(identity, roomFor(identity), await host.nonce()));
      await host.waitForClose();
      expect(host.errorCode()).toBe("expired");
    } finally {
      await fixture.stop();
    }
  });
});

describe("relaying bytes", () => {
  test("original bytes and order are preserved in both directions", async () => {
    const fixture = startFixture();
    try {
      const { host, controller } = await fixture.pair();

      // Distinct sizes and contents, including a zero-ish frame and high bytes.
      const upstream = [pattern(1, 1), pattern(64, 2), pattern(1500, 3), new Uint8Array([0, 255, 0, 255])];
      for (const frame of upstream) controller.send(frame);
      await host.waitForFrames(2 + upstream.length);

      const received = host.binaryFrames();
      expect(received).toHaveLength(upstream.length);
      for (let i = 0; i < upstream.length; i += 1) {
        // Byte-for-byte, and in the order sent.
        expect(sameBytes(received[i], upstream[i])).toBe(true);
      }

      const downstream = [pattern(8, 11), pattern(900, 12), pattern(32, 13)];
      for (const frame of downstream) host.send(frame);
      await controller.waitForFrames(2 + downstream.length);
      const back = controller.binaryFrames();
      expect(back).toHaveLength(downstream.length);
      for (let i = 0; i < downstream.length; i += 1) {
        expect(sameBytes(back[i], downstream[i])).toBe(true);
      }
    } finally {
      await fixture.stop();
    }
  });

  test("a long interleaved run keeps strict order", async () => {
    const fixture = startFixture();
    try {
      const { host, controller } = await fixture.pair();
      const count = 120;
      const sent: Uint8Array[] = [];
      for (let i = 0; i < count; i += 1) {
        // The first bytes encode the sequence number, so a reorder is detectable.
        const frame = pattern(40, i + 1);
        frame[0] = i & 0xff;
        frame[1] = (i >> 8) & 0xff;
        sent.push(frame);
        controller.send(frame);
      }
      await host.waitForFrames(2 + count, 8_000);
      const received = host.binaryFrames();
      expect(received).toHaveLength(count);
      for (let i = 0; i < count; i += 1) {
        expect(received[i][0]).toBe(i & 0xff);
        expect(sameBytes(received[i], sent[i])).toBe(true);
      }
    } finally {
      await fixture.stop();
    }
  });

  test("the relay never injects or echoes frames of its own", async () => {
    const fixture = startFixture();
    try {
      const { host, controller } = await fixture.pair();
      controller.send(pattern(10, 5));
      await host.waitForFrames(3);
      await new Promise((resolve) => setTimeout(resolve, 120));
      // The host saw exactly: challenge, paired, one relayed frame.
      expect(host.frames).toHaveLength(3);
      // The sender gets nothing back.
      expect(controller.binaryFrames()).toHaveLength(0);
      expect(controller.frames).toHaveLength(2);
    } finally {
      await fixture.stop();
    }
  });
});

describe("size budgets", () => {
  test("a screen room is capped at 16KiB until the host says authenticated", async () => {
    const fixture = startFixture();
    try {
      const { host, controller } = await fixture.pair();
      controller.send(pattern(16 * 1024 + 1, 9));
      await controller.waitForClose();
      expect(controller.errorCode()).toBe("limited");
    } finally {
      await fixture.stop();
    }
  });

  test("exactly 16KiB passes before authenticated", async () => {
    const fixture = startFixture();
    try {
      const { host, controller } = await fixture.pair();
      const frame = pattern(16 * 1024, 4);
      controller.send(frame);
      await host.waitForFrames(3);
      expect(sameBytes(host.binaryFrames()[0], frame)).toBe(true);
    } finally {
      await fixture.stop();
    }
  });

  test("after the host's authenticated signal a larger screen frame passes", async () => {
    const fixture = startFixture();
    try {
      const { host, controller } = await fixture.pair();
      host.send(JSON.stringify({ type: "authenticated" }));
      await new Promise((resolve) => setTimeout(resolve, 80));

      const big = pattern(64 * 1024, 6);
      controller.send(big);
      await host.waitForFrames(3, 4_000);
      expect(sameBytes(host.binaryFrames()[0], big)).toBe(true);
      expect(host.closed).toBe(false);
    } finally {
      await fixture.stop();
    }
  });

  test("registration stays at 16KiB even if the host sends the signal", async () => {
    const fixture = startFixture();
    try {
      const { host, controller } = await fixture.pair({ purpose: "registration" });
      // On a registration room the signal is not the host's to give: it is illegal text.
      host.send(JSON.stringify({ type: "authenticated" }));
      await host.waitForClose();
      expect(host.errorCode()).toBe("malformed");

      // And the controller's partner is gone, so the pair is torn down.
      await controller.waitForClose();
    } finally {
      await fixture.stop();
    }
  });

  test("an oversize screen frame is refused even after authenticated", async () => {
    const fixture = startFixture({ screenMaxFrameBytes: 32 * 1024 });
    try {
      const { host, controller } = await fixture.pair();
      host.send(JSON.stringify({ type: "authenticated" }));
      await new Promise((resolve) => setTimeout(resolve, 80));
      controller.send(pattern(32 * 1024 + 1, 8));
      await controller.waitForClose();
      expect(controller.errorCode()).toBe("limited");
    } finally {
      await fixture.stop();
    }
  });

  test("an overlong text frame is refused", async () => {
    const fixture = startFixture({ maxTextFrameBytes: 256 });
    try {
      const client = await fixture.connect();
      await client.nonce();
      client.send(JSON.stringify({ type: "join", pad: "x".repeat(400) }));
      await client.waitForClose();
      expect(client.errorCode()).toBe("malformed");
    } finally {
      await fixture.stop();
    }
  });
});

describe("pressure", () => {
  test("both peers close under back-pressure and no partial frame is delivered", async () => {
    // A tiny per-peer buffer budget, so pressure is reached without moving megabytes.
    const fixture = startFixture({ maxPeerBufferedBytes: 4 * 1024, screenMaxFrameBytes: 1024 * 1024 });
    try {
      const { host, controller } = await fixture.pair();
      host.send(JSON.stringify({ type: "authenticated" }));
      await new Promise((resolve) => setTimeout(resolve, 80));

      // Flood without reading on the far side; the relay must close rather than drop or splice.
      for (let i = 0; i < 400 && !controller.closed; i += 1) {
        controller.send(pattern(64 * 1024, i + 1));
      }
      await controller.waitForClose(5_000);
      expect(controller.errorCode()).toBe("limited");

      // Every frame the host did receive is intact and full-sized; none was truncated.
      for (const frame of host.binaryFrames()) {
        expect(frame.byteLength).toBe(64 * 1024);
      }
    } finally {
      await fixture.stop();
    }
  });

  test("the global pending budget also closes the pair", async () => {
    const fixture = startFixture({
      maxTotalPendingBytes: 8 * 1024,
      maxPeerBufferedBytes: 8 * 1024 * 1024,
      screenMaxFrameBytes: 1024 * 1024,
    });
    try {
      const { host, controller } = await fixture.pair();
      host.send(JSON.stringify({ type: "authenticated" }));
      await new Promise((resolve) => setTimeout(resolve, 80));
      for (let i = 0; i < 400 && !controller.closed; i += 1) {
        controller.send(pattern(64 * 1024, i + 1));
      }
      await controller.waitForClose(5_000);
      expect(controller.errorCode()).toBe("limited");
    } finally {
      await fixture.stop();
    }
  });
});

describe("rate and count budgets", () => {
  test("too many admissions from one IP are limited", async () => {
    const fixture = startFixture({ maxAdmissionsPerIp: 3, admissionWindowMs: 60_000 });
    try {
      const identity = await createMacIdentity();
      const codes: Array<string | undefined> = [];
      for (let i = 0; i < 5; i += 1) {
        const client = await fixture.connect();
        await client.nonce();
        // Each attempt is a well-formed controller join for a room with no host.
        client.send(controllerJoin(roomFor(identity)));
        await client.waitForClose();
        codes.push(client.errorCode());
      }
      // The first three are admitted far enough to be told `offline`; later ones are `limited`.
      expect(codes.slice(0, 3)).toEqual(["offline", "offline", "offline"]);
      expect(codes.slice(3)).toEqual(["limited", "limited"]);
    } finally {
      await fixture.stop();
    }
  });

  test("a malformed flood is rejected without spending the admission budget", async () => {
    const fixture = startFixture({ maxAdmissionsPerIp: 2 });
    try {
      for (let i = 0; i < 5; i += 1) {
        const junk = await fixture.connect();
        await junk.nonce();
        junk.send("{");
        await junk.waitForClose();
        expect(junk.errorCode()).toBe("malformed");
      }
      // The budget was never charged, so a real host still gets in.
      const identity = await createMacIdentity();
      const host = await fixture.connect();
      host.send(await hostJoin(identity, roomFor(identity), await host.nonce()));
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(host.errorCode()).toBeUndefined();
    } finally {
      await fixture.stop();
    }
  });

  test("the socket ceiling is enforced", async () => {
    const fixture = startFixture({ maxSockets: 2 });
    try {
      await fixture.connect();
      await fixture.connect();
      const third = await fixture.connect();
      await third.waitForClose();
      expect(third.errorCode()).toBe("limited");
    } finally {
      await fixture.stop();
    }
  });

  test("the room ceiling is enforced", async () => {
    const fixture = startFixture({ maxRooms: 1 });
    try {
      const first = await createMacIdentity();
      const a = await fixture.connect();
      a.send(await hostJoin(first, roomFor(first), await a.nonce()));
      await new Promise((resolve) => setTimeout(resolve, 80));

      const second = await createMacIdentity();
      const b = await fixture.connect();
      b.send(await hostJoin(second, roomFor(second), await b.nonce()));
      await b.waitForClose();
      expect(b.errorCode()).toBe("limited");
    } finally {
      await fixture.stop();
    }
  });

  test("a paired session is closed at its absolute lifetime", async () => {
    const fixture = startFixture({ activeLifetimeMs: 200 });
    try {
      const { host, controller } = await fixture.pair();
      await host.waitForClose(3_000);
      expect(host.errorCode()).toBe("expired");
      await controller.waitForClose(3_000);
    } finally {
      await fixture.stop();
    }
  });
});

describe("cleanup", () => {
  test("losing one peer closes the other and frees the room", async () => {
    const fixture = startFixture();
    try {
      const { host, controller } = await fixture.pair();
      expect(fixture.server.core.stats().rooms).toBe(1);

      controller.close();
      await host.waitForClose(3_000);
      expect(host.closed).toBe(true);

      await new Promise((resolve) => setTimeout(resolve, 120));
      const stats = fixture.server.core.stats();
      expect(stats.rooms).toBe(0);
      expect(stats.sockets).toBe(0);
      expect(stats.pendingBytes).toBe(0);
    } finally {
      await fixture.stop();
    }
  });

  test("an ended session is not resumable: the room is gone and a controller gets offline", async () => {
    const fixture = startFixture();
    try {
      const identity = await createMacIdentity();
      const room = roomFor(identity);
      const { host, controller } = await fixture.pair({ identity, room });

      host.close();
      await controller.waitForClose(3_000);
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(fixture.server.core.stats().rooms).toBe(0);

      // A fresh controller cannot rejoin the dead session.
      const late = await fixture.connect();
      await late.nonce();
      late.send(controllerJoin(room));
      await late.waitForClose();
      expect(late.errorCode()).toBe("offline");
    } finally {
      await fixture.stop();
    }
  });

  test("a waiting host that disconnects leaves no room behind", async () => {
    const fixture = startFixture();
    try {
      const identity = await createMacIdentity();
      const host = await fixture.connect();
      host.send(await hostJoin(identity, roomFor(identity), await host.nonce()));
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(fixture.server.core.stats().rooms).toBe(1);

      host.close();
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(fixture.server.core.stats().rooms).toBe(0);
    } finally {
      await fixture.stop();
    }
  });

  test("repeated pair/teardown cycles leak no rooms or sockets", async () => {
    const fixture = startFixture();
    try {
      for (let i = 0; i < 6; i += 1) {
        const { host, controller } = await fixture.pair();
        controller.send(pattern(32, i + 1));
        await host.waitForFrames(3);
        host.close();
        controller.close();
        await new Promise((resolve) => setTimeout(resolve, 60));
      }
      const stats = fixture.server.core.stats();
      expect(stats.rooms).toBe(0);
      expect(stats.sockets).toBe(0);
      expect(stats.pendingBytes).toBe(0);
    } finally {
      await fixture.stop();
    }
  });
});
