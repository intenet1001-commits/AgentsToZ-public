import { describe, expect, test } from "bun:test";
import { assertProjectMemoryRevisionLineage } from "../project-memory-server";

describe("project-memory revision lineage guard", () => {
  test("rejects a historical revision from another initialized memory lineage", () => {
    expect(() => assertProjectMemoryRevisionLineage(
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
    )).toThrow(/다른 프로젝트/);
  });

  test("accepts a historical revision from the current memory lineage", () => {
    expect(() => assertProjectMemoryRevisionLineage(
      "11111111-1111-4111-8111-111111111111",
      "11111111-1111-4111-8111-111111111111",
    )).not.toThrow();
  });
});
