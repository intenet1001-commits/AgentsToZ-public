import { expect, test } from "bun:test";
import { RelayCore, type RelaySocket } from "../src/server.ts";
import { controllerJoin, createMacIdentity, hostJoin, roomFor } from "./fixture.ts";

/** Real Bun sockets cannot deterministically force send() == 0/-1. This adapter exercises the same RelayCore;
 * normal forwarding and crypto continue to be covered by the real-socket suite. */
class Socket implements RelaySocket {
  data: ReturnType<RelayCore["createState"]>;
  sent: (string | Uint8Array)[] = [];
  closed = false;
  binaryResult = 1;
  buffered = 0;
  constructor(readonly core: RelayCore) { this.data = core.createState("127.0.0.1"); }
  send(frame: string | Uint8Array) {
    this.sent.push(frame);
    return typeof frame === "string" ? frame.length : this.binaryResult;
  }
  close() { if (!this.closed) { this.closed = true; this.core.close(this); } }
  getBufferedAmount() { return this.buffered; }
}

async function pair(core: RelayCore) {
  const mac = await createMacIdentity(), room = roomFor(mac);
  const host = new Socket(core), controller = new Socket(core);
  core.open(host);
  core.message(host, await hostJoin(mac, room, host.data.nonce));
  for (let i = 0; i < 100 && core.stats().rooms !== 1; i++) await Bun.sleep(5);
  expect(core.stats().rooms).toBe(1);
  core.open(controller); core.message(controller, controllerJoin(room));
  expect(core.stats().pairedRooms).toBe(1);
  return { host, controller };
}

test("a dropped Bun send closes both peers before another encrypted record can be forwarded", async () => {
  const core = new RelayCore();
  try {
    const { host, controller } = await pair(core);
    controller.binaryResult = 0;
    core.message(host, new Uint8Array([1, 2, 3]));
    expect(host.closed).toBe(true); expect(controller.closed).toBe(true);
    core.message(host, new Uint8Array([4, 5, 6]));
    expect(controller.sent.filter(frame => typeof frame !== "string")).toHaveLength(1);
    expect(core.stats().rooms).toBe(0); expect(core.stats().sockets).toBe(0);
    expect(core.stats().pendingBytes).toBe(0);
  } finally { core.shutdown(); }
});

test("Bun backpressure is already queued, so a -1 result is counted once and never retried", async () => {
  const core = new RelayCore();
  try {
    const { host, controller } = await pair(core);
    controller.binaryResult = -1; controller.buffered = 123;
    core.message(host, new Uint8Array([1, 2, 3]));
    expect(host.closed).toBe(false); expect(controller.closed).toBe(false);
    expect(controller.sent.filter(frame => typeof frame !== "string")).toHaveLength(1);
    expect(core.stats().pendingBytes).toBe(123);
    controller.buffered = 0; core.drain(controller);
    expect(core.stats().pendingBytes).toBe(0);
    host.close(); controller.close();
  } finally { core.shutdown(); }
});
