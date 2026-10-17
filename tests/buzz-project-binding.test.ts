import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bindExclusiveProjectMemoryThread,
  findProjectMemoryThreadBindings,
  getProjectMemoryThreadBinding,
  unbindProjectMemoryThreads,
} from "../src/projectMemoryThreadBindings";

const temps: string[] = [];
afterEach(() => {
  for (const path of temps.splice(0)) rmSync(path, { recursive: true, force: true });
});

function registryPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "buzz-project-binding-"));
  temps.push(dir);
  return join(dir, "project-memory-thread-bindings.json");
}

describe("Buzz channel project-memory binding", () => {
  test("persists channel label and verification without exposing credentials", async () => {
    const file = registryPath();
    const route = {
      platform: "buzz",
      chatId: "ws://localhost:3000",
      threadId: "90e60ca7-e624-4a9a-9c2a-e346715a9f46",
    };
    const saved = await bindExclusiveProjectMemoryThread(file, {
      ...route,
      projectId: "agentstoz",
      projectName: "AgentsToZ_byCS",
      memoryId: "25b0ca35-60c2-41ff-91c3-bc64e2f38af1",
      canonicalPath: "/Users/example/AgentsToZ_byCS",
      threadName: "AgentsToZ",
      verifiedAt: "2026-08-27T00:00:00.000Z",
    });

    expect(saved.threadName).toBe("AgentsToZ");
    expect(saved.verifiedAt).toBe("2026-08-27T00:00:00.000Z");
    expect(await getProjectMemoryThreadBinding(file, route)).toMatchObject(saved);
    expect(await findProjectMemoryThreadBindings(file, {
      platform: "buzz",
      projectId: "agentstoz",
      memoryId: "25b0ca35-60c2-41ff-91c3-bc64e2f38af1",
    })).toHaveLength(1);

    await unbindProjectMemoryThreads(file, {
      platform: "buzz",
      projectId: "agentstoz",
      memoryId: "25b0ca35-60c2-41ff-91c3-bc64e2f38af1",
      canonicalPath: "/Users/example/AgentsToZ_byCS",
    });
    expect(await findProjectMemoryThreadBindings(file, { platform: "buzz", projectId: "agentstoz" }))
      .toEqual([]);
  });

  test("moves one project to its newest channel without leaving a stale binding", async () => {
    const file = registryPath();
    const project = {
      projectId: "agentstoz",
      projectName: "AgentsToZ_byCS",
      memoryId: "25b0ca35-60c2-41ff-91c3-bc64e2f38af1",
      canonicalPath: "/Users/example/AgentsToZ_byCS",
    };
    await bindExclusiveProjectMemoryThread(file, {
      platform: "buzz",
      chatId: "wss://first.communities.buzz.xyz",
      threadId: "90e60ca7-e624-4a9a-9c2a-e346715a9f46",
      ...project,
    });
    const newest = await bindExclusiveProjectMemoryThread(file, {
      platform: "buzz",
      chatId: "wss://second.communities.buzz.xyz",
      threadId: "2ef9d949-3d91-49ae-a9c9-49c9ca226f78",
      ...project,
    });

    expect(await findProjectMemoryThreadBindings(file, {
      platform: "buzz",
      projectId: project.projectId,
      memoryId: project.memoryId,
    })).toEqual([newest]);
  });

  test("atomically rejects two projects racing for the same Buzz channel", async () => {
    const file = registryPath();
    const route = {
      platform: "buzz",
      chatId: "wss://csncompany.communities.buzz.xyz",
      threadId: "90e60ca7-e624-4a9a-9c2a-e346715a9f46",
    };
    const outcomes = await Promise.allSettled([
      bindExclusiveProjectMemoryThread(file, {
        ...route,
        projectId: "agentstoz",
        projectName: "AgentsToZ_byCS",
        memoryId: "25b0ca35-60c2-41ff-91c3-bc64e2f38af1",
        canonicalPath: "/Users/example/AgentsToZ_byCS",
      }),
      bindExclusiveProjectMemoryThread(file, {
        ...route,
        projectId: "other",
        projectName: "Other",
        memoryId: "30c206c0-6354-42e7-87ab-697289f81138",
        canonicalPath: "/Users/example/Other",
      }),
    ]);

    expect(outcomes.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(result => result.status === "rejected")).toHaveLength(1);
    expect((outcomes.find(result => result.status === "rejected") as PromiseRejectedResult).reason.code)
      .toBe("PROJECT_MEMORY_THREAD_ROUTE_CONFLICT");
  });
});
