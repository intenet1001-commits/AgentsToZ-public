import { describe, expect, test } from "bun:test";
import { defaultFirstTaskBranchName } from "../src/repositoryWorkflow";

describe("repository workflow UI helpers", () => {
  test("builds a stable Git-safe default branch name", () => {
    expect(defaultFirstTaskBranchName(new Date(2026, 7, 1, 9, 5)))
      .toBe("task-20260801-0905");
  });
});
