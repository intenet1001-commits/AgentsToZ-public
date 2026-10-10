import { describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ServiceMemoryError,
  ensureServiceMemory,
  inspectServiceMemory,
} from "../src/serviceMemory";

const project = {
  projectId: "project-123",
  projectName: "Study Finance",
  projectMemoryId: "20a41c23-3d92-5d3c-af5f-3dc55f8e45e1",
  canonicalPath: "/Users/example/product_2026/study_finance",
};

describe("platform-independent USE service memory", () => {
  test("is absent until explicitly created, then writes a separate local authority", () => {
    const appDataDir = mkdtempSync(join(tmpdir(), "agentstoz-service-memory-"));
    try {
      expect(inspectServiceMemory(appDataDir, { projectId: project.projectId, serviceKey: "default" }))
        .toEqual({ exists: false, ready: false, record: null, problem: null });

      const created = ensureServiceMemory(appDataDir, {
        ...project,
        serviceKey: "default",
        displayName: "study_finance",
      });

      expect(created.created).toBe(true);
      expect(created.record).toMatchObject({
        role: "use",
        serviceKey: "default",
        displayName: "study_finance",
        linkedProjectId: project.projectId,
        linkedProjectMemoryId: project.projectMemoryId,
        linkedCanonicalPath: project.canonicalPath,
      });
      expect(created.record.serviceMemoryId).toMatch(/^[0-9a-f-]{36}$/);
      expect(created.record.sourcePath).toBe(join(appDataDir, "service-memories", created.record.serviceMemoryId, "CORE.md"));
      expect(existsSync(created.record.configPath)).toBe(true);
      expect(existsSync(created.record.sourcePath)).toBe(true);

      const source = readFileSync(created.record.sourcePath, "utf8");
      expect(source).toContain("Role: USE");
      expect(source).toContain(project.projectMemoryId);
      expect(source).toContain("DEV handoff queue");
      expect(source).toContain("Do not store raw transcripts");
    } finally {
      rmSync(appDataDir, { recursive: true, force: true });
    }
  });

  test("reuses one service memory across surfaces without overwriting durable content", () => {
    const appDataDir = mkdtempSync(join(tmpdir(), "agentstoz-service-memory-"));
    const otherDeviceAppDataDir = mkdtempSync(join(tmpdir(), "agentstoz-service-memory-device-"));
    try {
      const first = ensureServiceMemory(appDataDir, {
        ...project,
        serviceKey: "default",
        displayName: "study_finance",
      });
      appendFileSync(first.record.sourcePath, "\nValidated FAQ: filters reset from the header.\n");

      const second = ensureServiceMemory(appDataDir, {
        ...project,
        serviceKey: "default",
        displayName: "study_finance service",
      });

      expect(second.created).toBe(false);
      expect(second.record.serviceMemoryId).toBe(first.record.serviceMemoryId);
      expect(second.record.displayName).toBe("study_finance service");
      expect(readFileSync(second.record.sourcePath, "utf8")).toContain("Validated FAQ");
      expect(inspectServiceMemory(appDataDir, { projectId: project.projectId, serviceKey: "default" }))
        .toMatchObject({ exists: true, ready: true, record: { serviceMemoryId: first.record.serviceMemoryId } });

      const otherDevice = ensureServiceMemory(otherDeviceAppDataDir, {
        ...project,
        projectId: "same-memory-different-local-row",
        serviceKey: "default",
        displayName: "study_finance",
      });
      expect(otherDevice.record.serviceMemoryId).toBe(first.record.serviceMemoryId);
      expect(otherDevice.record.sourcePath).not.toBe(first.record.sourcePath);
    } finally {
      rmSync(appDataDir, { recursive: true, force: true });
      rmSync(otherDeviceAppDataDir, { recursive: true, force: true });
    }
  });

  test("fails closed when a stable service key points at a different DEV identity", () => {
    const appDataDir = mkdtempSync(join(tmpdir(), "agentstoz-service-memory-"));
    try {
      ensureServiceMemory(appDataDir, { ...project, serviceKey: "default", displayName: "study_finance" });
      expect(() => ensureServiceMemory(appDataDir, {
        ...project,
        projectMemoryId: "884575df-63c4-407c-8b43-860d1295e663",
        serviceKey: "default",
        displayName: "study_finance",
      })).toThrow(ServiceMemoryError);
      try {
        ensureServiceMemory(appDataDir, {
          ...project,
          canonicalPath: "/Users/example/other-project",
          serviceKey: "default",
          displayName: "study_finance",
        });
      } catch (error) {
        expect(error).toBeInstanceOf(ServiceMemoryError);
        expect((error as ServiceMemoryError).code).toBe("SERVICE_MEMORY_IDENTITY_MISMATCH");
      }
      expect(() => inspectServiceMemory(appDataDir, { projectId: project.projectId, serviceKey: "../escape" }))
        .toThrow(ServiceMemoryError);
    } finally {
      rmSync(appDataDir, { recursive: true, force: true });
    }
  });

  test("does not silently regenerate a missing durable source", () => {
    const appDataDir = mkdtempSync(join(tmpdir(), "agentstoz-service-memory-"));
    try {
      const created = ensureServiceMemory(appDataDir, {
        ...project,
        serviceKey: "default",
        displayName: "study_finance",
      });
      rmSync(created.record.sourcePath);

      expect(inspectServiceMemory(appDataDir, {
        projectId: project.projectId,
        projectMemoryId: project.projectMemoryId,
        serviceKey: "default",
      })).toMatchObject({ exists: true, ready: false, problem: expect.stringContaining("누락") });
      try {
        ensureServiceMemory(appDataDir, {
          ...project,
          serviceKey: "default",
          displayName: "study_finance",
        });
        throw new Error("expected ensure to fail closed");
      } catch (error) {
        expect(error).toBeInstanceOf(ServiceMemoryError);
        expect((error as ServiceMemoryError).code).toBe("SERVICE_MEMORY_FILES_INVALID");
      }
      expect(existsSync(created.record.sourcePath)).toBe(false);
    } finally {
      rmSync(appDataDir, { recursive: true, force: true });
    }
  });

  test("preserves an orphaned deterministic directory for explicit recovery", () => {
    const appDataDir = mkdtempSync(join(tmpdir(), "agentstoz-service-memory-"));
    const referenceAppDataDir = mkdtempSync(join(tmpdir(), "agentstoz-service-memory-reference-"));
    try {
      const reference = ensureServiceMemory(referenceAppDataDir, {
        ...project,
        serviceKey: "default",
        displayName: "study_finance",
      });
      const orphanDirectory = join(appDataDir, "service-memories", reference.record.serviceMemoryId);
      mkdirSync(orphanDirectory, { recursive: true });
      const orphanSource = join(orphanDirectory, "CORE.md");
      writeFileSync(orphanSource, "irreplaceable orphaned content\n");

      try {
        ensureServiceMemory(appDataDir, {
          ...project,
          serviceKey: "default",
          displayName: "study_finance",
        });
        throw new Error("expected orphan recovery gate");
      } catch (error) {
        expect(error).toBeInstanceOf(ServiceMemoryError);
        expect((error as ServiceMemoryError).code).toBe("SERVICE_MEMORY_FILES_INVALID");
      }
      expect(readFileSync(orphanSource, "utf8")).toBe("irreplaceable orphaned content\n");
    } finally {
      rmSync(appDataDir, { recursive: true, force: true });
      rmSync(referenceAppDataDir, { recursive: true, force: true });
    }
  });
});
