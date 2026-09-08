import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bindProjectMemoryThread,
  getProjectMemoryThreadBinding,
  projectMemoryThreadBindingKey,
  unbindProjectMemoryThread,
} from "../src/projectMemoryThreadBindings";

const temps: string[] = [];
afterEach(() => {
  for (const path of temps.splice(0)) rmSync(path, { recursive: true, force: true });
});

function registryPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "memory-thread-binding-"));
  temps.push(dir);
  return join(dir, "project-memory-thread-bindings.json");
}

const topic = {
  platform: "telegram",
  chatId: "8175665017",
  threadId: "6884",
};

const project = {
  projectId: "agentstoz",
  projectName: "AgentsToZ_byCS",
  memoryId: "90e60ca7-e624-4a9a-9c2a-e346715a9f46",
  canonicalPath: "/home/ubuntu/AgentsToZ_byCS",
};

describe("project-memory thread bindings", () => {
  test("keys a binding by platform, chat and topic without colliding with root chat", () => {
    expect(projectMemoryThreadBindingKey(topic)).toBe("telegram:8175665017:6884");
    expect(projectMemoryThreadBindingKey({ ...topic, threadId: null })).toBe("telegram:8175665017:root");
  });

  test("persists and reads only the exact topic binding", async () => {
    const file = registryPath();
    const saved = await bindProjectMemoryThread(file, { ...topic, ...project });

    expect(saved).toMatchObject({ ...topic, ...project });
    expect(await getProjectMemoryThreadBinding(file, topic)).toMatchObject(project);
    expect(await getProjectMemoryThreadBinding(file, { ...topic, threadId: "9999" })).toBeNull();

    const stored = JSON.parse(readFileSync(file, "utf8"));
    expect(stored.version).toBe(1);
    expect(Object.keys(stored.bindings)).toEqual(["telegram:8175665017:6884"]);
    expect(stored.bindings["telegram:8175665017:6884"].memoryId).toBe(project.memoryId);
  });

  test("rebind replaces one topic atomically while preserving another", async () => {
    const file = registryPath();
    await bindProjectMemoryThread(file, { ...topic, ...project });
    await bindProjectMemoryThread(file, {
      ...topic,
      threadId: "7000",
      ...project,
      projectId: "other",
      projectName: "Other",
      memoryId: "e8075c5e-a01a-4466-a19a-2a4cdde9399f",
      canonicalPath: "/tmp/other",
    });
    await bindProjectMemoryThread(file, {
      ...topic,
      ...project,
      projectName: "AgentsToZ renamed",
    });

    expect((await getProjectMemoryThreadBinding(file, topic))?.projectName).toBe("AgentsToZ renamed");
    expect((await getProjectMemoryThreadBinding(file, { ...topic, threadId: "7000" }))?.projectId).toBe("other");
  });

  test("unbind removes only the current topic and is idempotent", async () => {
    const file = registryPath();
    await bindProjectMemoryThread(file, { ...topic, ...project });
    await bindProjectMemoryThread(file, { ...topic, threadId: "7000", ...project });

    expect(await unbindProjectMemoryThread(file, topic)).toBe(true);
    expect(await unbindProjectMemoryThread(file, topic)).toBe(false);
    expect(await getProjectMemoryThreadBinding(file, topic)).toBeNull();
    expect(await getProjectMemoryThreadBinding(file, { ...topic, threadId: "7000" })).not.toBeNull();
  });

  test("rejects missing routing identity and malformed persisted records", async () => {
    const file = registryPath();
    await expect(bindProjectMemoryThread(file, { ...topic, ...project, chatId: "" })).rejects.toThrow("chatId");
    await expect(bindProjectMemoryThread(file, { ...topic, ...project, memoryId: "" })).rejects.toThrow("memoryId");
  });

  test("fails closed on a corrupted registry instead of treating it as unbound", async () => {
    const file = registryPath();
    writeFileSync(file, "{broken-json", "utf8");
    await expect(getProjectMemoryThreadBinding(file, topic)).rejects.toThrow("손상");
    await expect(bindProjectMemoryThread(file, { ...topic, ...project })).rejects.toThrow("손상");
  });

  test("concurrent writes preserve both topic bindings", async () => {
    const file = registryPath();
    await Promise.all([
      bindProjectMemoryThread(file, { ...topic, ...project }),
      bindProjectMemoryThread(file, { ...topic, threadId: "7000", ...project }),
    ]);
    expect(await getProjectMemoryThreadBinding(file, topic)).not.toBeNull();
    expect(await getProjectMemoryThreadBinding(file, { ...topic, threadId: "7000" })).not.toBeNull();
  });
});
