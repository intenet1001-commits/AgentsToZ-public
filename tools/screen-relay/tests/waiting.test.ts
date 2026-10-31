import { expect, test } from "bun:test";
import { controllerJoin, createMacIdentity, hostJoin, roomFor, startFixture } from "./fixture.ts";

test("a v2 host receives verified waiting admission before a v1 controller pairs", async () => {
  const fixture = startFixture();
  try {
    const mac = await createMacIdentity(), room = roomFor(mac), host = await fixture.connect();
    host.send(await hostJoin(mac, room, await host.nonce(), "screen", 2));
    await host.waitForFrames(2);
    expect(host.json(1)).toEqual({ type: "waiting", version: 2 });
    expect(fixture.server.core.stats().pairedRooms).toBe(0);
    const controller = await fixture.connect();
    await controller.nonce(); controller.send(controllerJoin(room));
    await host.waitForFrames(3); await controller.waitForFrames(2);
    expect(host.json(2).type).toBe("paired"); expect(controller.json(1).type).toBe("paired");
    const frame = new Uint8Array([3, 2, 1]); host.send(frame);
    await controller.waitForFrames(3);
    expect(controller.binaryFrames()).toEqual([frame]);
  } finally { await fixture.stop(); }
});

test("the relay join version is bound into the host signature", async () => {
  const fixture = startFixture();
  try {
    const mac = await createMacIdentity(), host = await fixture.connect();
    const join = JSON.parse(await hostJoin(mac, roomFor(mac), await host.nonce()));
    join.version = 2; host.send(JSON.stringify(join));
    await host.waitForClose();
    expect(host.errorCode()).toBe("unauthorized"); expect(fixture.server.core.stats().rooms).toBe(0);
  } finally { await fixture.stop(); }
});
