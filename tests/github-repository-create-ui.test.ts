import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(join(import.meta.dir, "..", "src", "App.tsx"), "utf8");

describe("GitHub repository creation UI", () => {
  test("offers explicit private/public selection and two-step confirmation", () => {
    expect(source).toContain('data-testid="github-repository-create-control"');
    expect(source).toContain('data-testid={`github-visibility-${option}`}');
    expect(source).toContain('data-testid="github-create-review"');
    expect(source).toContain('data-testid="github-create-confirmation"');
    expect(source).toContain('data-testid="github-create-submit"');
    expect(source).toContain("Public은 인터넷에 공개됩니다");
  });

  test("sends only the registered project ID and explicit visibility", () => {
    expect(source).toContain("body: JSON.stringify({ portId, visibility })");
    expect(source).toContain("githubRepositoryNameFromProject");
    expect(source).toContain("미커밋 파일은 포함하지 않습니다");
  });
});
