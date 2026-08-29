import { describe, expect, test } from "bun:test";
import { planAgentsToZProjectWorker } from "../src/agentstozProjectDispatch";

describe("AgentsToZ project worker dispatch plan", () => {
  test("binds hermes chat to the resolved project and memory", () => {
    const plan = planAgentsToZProjectWorker({
      requestId: "req-1",
      project: "csncompany2-0",
      memoryId: "memory-1",
      canonicalPath: "/Users/cs-work/projects/csncompany2-0",
      task: "로그인 버그를 조사해줘",
      hermesCli: "/opt/hermes/bin/hermes",
    });
    expect(plan).toMatchObject({
      ok: true,
      requestId: "req-1",
      project: "csncompany2-0",
      memoryId: "memory-1",
      workerProfile: "cs-ceo",
      canonicalPath: "/Users/cs-work/projects/csncompany2-0",
      cwd: "/Users/cs-work/projects/csncompany2-0",
    });
    if (plan.ok) {
      expect(plan.command.join(" ")).toContain("Read the project-local memory");
      expect(plan.command.join(" ")).toContain("Record durable decisions and verified results");
      expect(plan.command.join(" ")).toContain("Do not write to global or another project memory");
    }
    expect(planAgentsToZProjectWorker({
      requestId: "req-1",
      project: "csncompany2-0",
      memoryId: "memory-1",
      canonicalPath: "/Users/cs-work/projects/csncompany2-0",
      task: "로그인 버그를 조사해줘",
      hermesCli: "/opt/hermes/bin/hermes",
    }).ok).toBe(true);
  });

  test("fails closed for missing binding, relative paths, and empty work", () => {
    expect(planAgentsToZProjectWorker({ task: "work" })).toMatchObject({ ok: false, code: "REQUEST_ID_REQUIRED" });
    expect(planAgentsToZProjectWorker({ requestId: "r", project: "p", memoryId: "m", canonicalPath: "relative", task: "work" }))
      .toMatchObject({ ok: false, code: "CANONICAL_PATH_NOT_ABSOLUTE" });
    expect(planAgentsToZProjectWorker({ requestId: "r", project: "p", memoryId: "m", canonicalPath: "/p", task: "" }))
      .toMatchObject({ ok: false, code: "TASK_REQUIRED" });
  });
});
