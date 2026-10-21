import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

interface GoldenCase {
  input: unknown;
  expected: Record<string, string>;
}

const fixture = JSON.parse(readFileSync(new URL("./fixtures/spawn-port-env-golden.json", import.meta.url), "utf8")) as {
  cases: GoldenCase[];
};

describe("spawn port environment", () => {
  test("omits sentinel/invalid ports and derives API_PORT only inside range", async () => {
    const modulePath = "../src/processPortEnvironment";
    const loaded = await import(modulePath).catch(() => null) as null | {
      processPortEnvironment: (port: unknown) => Record<string, string>;
    };
    expect(loaded).not.toBeNull();
    for (const item of fixture.cases) {
      expect(loaded!.processPortEnvironment(item.input)).toEqual(item.expected);
    }
  });
});
