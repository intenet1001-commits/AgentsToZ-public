import { describe, expect, test } from "bun:test";
import {
  githubRepositoryCreateArgs,
  githubRepositoryNameFromProject,
} from "../src/githubRepositoryCreate";

describe("GitHub repository creation contract", () => {
  test("derives an allowed repository name without accepting a remote name from chat", () => {
    expect(githubRepositoryNameFromProject({
      projectName: "Study Finance",
      folderName: "study_finance",
      projectId: "project-1",
    })).toBe("study_finance");
    expect(githubRepositoryNameFromProject({
      projectName: "테스트해보자",
      folderName: "테스트해보자",
      projectId: "6d6012cf-d8da-43fe-a478-d9a54830c260",
    })).toBe("project-6d6012cfd8da");
    expect(githubRepositoryNameFromProject({
      projectName: "../ unsafe / name",
      projectId: "abc",
    })).toBe("unsafe-name");
  });

  test("builds argv without a shell and requires an explicit visibility", () => {
    expect(githubRepositoryCreateArgs({
      repositoryName: "study_finance",
      folderPath: "/Users/cs/work/study_finance",
      visibility: "private",
    })).toEqual([
      "repo", "create", "study_finance", "--private",
      "--source", "/Users/cs/work/study_finance",
      "--remote", "origin", "--push",
    ]);
  });
});
