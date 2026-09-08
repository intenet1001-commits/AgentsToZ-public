import { describe, expect, test } from "bun:test";
import { ProjectWorkerLockRegistry } from "../src/agentstozProjectDispatch";

test("project worker lock serializes different requests for the same project", () => {
  const locks = new ProjectWorkerLockRegistry();
  expect(locks.acquire("/tmp/project", "memory-1", "request-a")).toEqual({ ok: true });
  expect(locks.acquire("/tmp/project", "memory-1", "request-b")).toEqual({ ok: false, requestId: "request-a" });
  expect(locks.release("/tmp/project", "memory-1", "request-b")).toBe(false);
  expect(locks.release("/tmp/project", "memory-1", "request-a")).toBe(true);
  expect(locks.acquire("/tmp/project", "memory-1", "request-b")).toEqual({ ok: true });
});
