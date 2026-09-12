import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { OrchestrationMissionStore } from "../src/orchestrationMissionStore";
import type { PromptGuideKeyProvider } from "../src/promptGuideKeyProvider";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const appDataDir = mkdtempSync(join(tmpdir(), "agentstoz-missions-")); roots.push(appDataDir);
  const key = Buffer.alloc(32, 7);
  const provider: PromptGuideKeyProvider = { read: async () => Buffer.from(key), create: async () => Buffer.from(key) };
  return { appDataDir, store: new OrchestrationMissionStore({ appDataDir, keyProvider: provider }) };
}

describe("encrypted orchestration mission store", () => {
  test("an empty read stays side-effect free", async () => {
    const { appDataDir, store } = fixture();
    expect(await store.list()).toEqual([]);
    expect(existsSync(join(appDataDir, "orchestration-missions.v1.sqlite"))).toBe(false);
  });
  test("persists encrypted mission text and applies explicit lifecycle transitions", async () => {
    const { appDataDir, store } = fixture();
    const created = await store.create({ title: "비밀 SDK 조율", goal: "A와 B를 함께 변경", requestId: "request_create_1" });
    expect(created.state).toBe("active");
    const bytes = readFileSync(join(appDataDir, "orchestration-missions.v1.sqlite"));
    expect(bytes.includes(Buffer.from("비밀 SDK 조율"))).toBe(false);
    if (process.platform !== "win32") expect(lstatSync(join(appDataDir, "orchestration-missions.v1.sqlite")).mode & 0o777).toBe(0o600);
    const paused = await store.append({ missionId: created.id, kind: "mission-paused", requestId: "request_pause_1", projectIds: [], summary: "사용자가 멈춤", whatISaidEventId: null });
    expect(paused.mission.state).toBe("paused");
    await expect(store.append({ missionId: created.id, kind: "instruction-sent", requestId: "request_send_1", projectIds: ["A"], summary: "진행", whatISaidEventId: null }))
      .rejects.toMatchObject({ code: "MISSION_STATE_TRANSITION_INVALID" });
    const resumed = await store.append({ missionId: created.id, kind: "mission-resumed", requestId: "request_resume_1", projectIds: [], summary: "사용자가 재개", whatISaidEventId: null });
    expect(resumed.mission.state).toBe("active");
  });

  test("returns the same receipt for an exact request retry", async () => {
    const { store } = fixture();
    const first = await store.create({ title: "통합", goal: "두 프로젝트 조율", requestId: "request_create_2" });
    const retry = await store.create({ title: "통합", goal: "두 프로젝트 조율", requestId: "request_create_2" });
    expect(retry.id).toBe(first.id);
    const event = { missionId: first.id, kind: "project-bound", requestId: "request_bind_1", projectIds: ["B", "A"], summary: "두 프로젝트 연결", whatISaidEventId: null };
    const one = await store.append(event); const two = await store.append(event);
    expect(two.event.id).toBe(one.event.id);
    await expect(store.create({ title: "다른 미션", goal: "다른 목표", requestId: "request_create_2" }))
      .rejects.toMatchObject({ code: "MISSION_REQUEST_CONFLICT" });
    await expect(store.append({ ...event, summary: "다른 지시" }))
      .rejects.toMatchObject({ code: "MISSION_REQUEST_CONFLICT" });
  });

  test("never recreates a missing key for an existing database", async () => {
    const { appDataDir, store } = fixture();
    await store.create({ title: "통합", goal: "작업", requestId: "request_create_3" });
    let created = 0;
    const missing: PromptGuideKeyProvider = { read: async () => null, create: async () => { created++; return Buffer.alloc(32); } };
    await expect(new OrchestrationMissionStore({ appDataDir, keyProvider: missing }).read("mission_missing"))
      .rejects.toMatchObject({ code: "MISSION_KEY_MISSING" });
    expect(created).toBe(0); expect(existsSync(join(appDataDir, "orchestration-missions.v1.sqlite"))).toBe(true);
  });

  test("rejects reusing an action receipt as a create receipt", async () => {
    const { store } = fixture();
    const input = { title: "통합", goal: "작업", requestId: "create_original" };
    const mission = await store.create(input);
    await store.append({ missionId: mission.id, kind: "mission-paused", requestId: "pause_original", projectIds: [], summary: "Paused" });
    await expect(store.create({ ...input, requestId: "pause_original" }))
      .rejects.toMatchObject({ code: "MISSION_REQUEST_CONFLICT" });
    expect((await store.read(mission.id)).state).toBe("paused");
    expect(await store.events(mission.id)).toHaveLength(2);
  });

  test("missing metadata cannot replace the key or reinitialize persisted missions", async () => {
    const { appDataDir, store } = fixture();
    await store.create({ title: "보존", goal: "작업", requestId: "create_preserved" });
    const databasePath = join(appDataDir, "orchestration-missions.v1.sqlite");
    const db = new Database(databasePath);
    db.exec("DELETE FROM metadata");
    db.close();
    let created = 0;
    const missing: PromptGuideKeyProvider = { read: async () => null, create: async () => { created++; return Buffer.alloc(32); } };
    await expect(new OrchestrationMissionStore({ appDataDir, keyProvider: missing }).list())
      .rejects.toMatchObject({ code: "MISSION_METADATA_INVALID" });
    expect(created).toBe(0);
    const check = new Database(databasePath);
    try {
      expect(check.query("SELECT COUNT(*) AS count FROM metadata").get()).toEqual({ count: 0 });
      expect(check.query("SELECT COUNT(*) AS count FROM missions").get()).toEqual({ count: 1 });
    } finally { check.close(); }
  });

  test("pages through a long mission without gaps or duplicates", async () => {
    const { store } = fixture();
    const mission = await store.create({ title: "긴 작업", goal: "모든 결과 확인", requestId: "create_long_mission" });
    for (let index = 0; index < 7; index++) {
      await store.append({ missionId: mission.id, kind: "result-verified", requestId: `result_${index}_request`, projectIds: ["project-a"], summary: `result ${index}`, whatISaidEventId: null });
    }
    const first = await store.eventPage(mission.id, { limit: 3 });
    const second = await store.eventPage(mission.id, { limit: 3, afterEventId: first.nextEventId });
    const third = await store.eventPage(mission.id, { limit: 3, afterEventId: second.nextEventId });
    const combined = [...first.events, ...second.events, ...third.events];
    expect(first.hasMore).toBe(true);
    expect(second.hasMore).toBe(true);
    expect(third.hasMore).toBe(false);
    expect(combined).toHaveLength(8);
    expect(new Set(combined.map(event => event.id)).size).toBe(8);
    expect(combined.map(event => event.summary)).toEqual(["Mission created", ...Array.from({ length: 7 }, (_, index) => `result ${index}`)]);
    await expect(store.eventPage(mission.id, { afterEventId: "event_00000000-0000-4000-8000-000000000000" }))
      .rejects.toMatchObject({ code: "MISSION_EVENT_CURSOR_INVALID" });
  });

  test("marks only stale active missions interrupted after a runtime restart", async () => {
    const { store } = fixture();
    const active = await store.create({ title: "재개 필요", goal: "원격 흐름", requestId: "create_active_restart" });
    const paused = await store.create({ title: "이미 멈춤", goal: "대기", requestId: "create_paused_restart" });
    await store.append({ missionId: paused.id, kind: "mission-paused", requestId: "pause_before_restart", projectIds: [], summary: "Paused", whatISaidEventId: null });
    expect(await store.interruptActiveMissions()).toEqual([active.id]);
    expect((await store.read(active.id)).state).toBe("interrupted");
    expect((await store.read(paused.id)).state).toBe("paused");
    expect((await store.events(active.id)).at(-1)?.kind).toBe("mission-interrupted");
    expect(await store.interruptActiveMissions()).toEqual([]);
  });
});
