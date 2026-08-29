import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

type DurabilityPhase = "file" | "directory";
type DurabilityFault = (phase: DurabilityPhase, path: string) => void;

// Deterministic fault injection is intentionally unavailable outside tests.
// It lets recovery tests prove that cursors/baselines do not advance when the
// kernel has accepted bytes but durable storage has not acknowledged them.
let testDurabilityFault: DurabilityFault | null = null;

export function __setProjectMemoryDurabilityFaultForTests(
  fault: DurabilityFault | null,
): void {
  testDurabilityFault = fault;
}

function syncDescriptor(descriptor: number, phase: DurabilityPhase, path: string): void {
  testDurabilityFault?.(phase, path);
  fsyncSync(descriptor);
}

function noFollowFlag(): number {
  return process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0);
}

export function fsyncProjectMemoryDirectory(path: string): void {
  // Windows does not support opening a directory as a regular file handle.
  // File FlushFileBuffers is still enforced by the file fsync below.
  if (process.platform === "win32") return;
  const descriptor = openSync(path, constants.O_RDONLY | noFollowFlag());
  try {
    if (!fstatSync(descriptor).isDirectory()) {
      throw new Error(`project memory durability path is not a directory: ${path}`);
    }
    syncDescriptor(descriptor, "directory", path);
  } finally {
    closeSync(descriptor);
  }
}

/** Creates every missing directory and persists each new parent entry. */
export function ensureDurableProjectMemoryDirectory(path: string): void {
  const missing: string[] = [];
  let cursor = path;
  while (!existsSync(cursor)) {
    missing.unshift(cursor);
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  mkdirSync(path, { recursive: true });
  for (const created of missing) {
    fsyncProjectMemoryDirectory(dirname(created));
    fsyncProjectMemoryDirectory(created);
  }
}

/**
 * Appends without a read-modify-write window and does not return until both the
 * bytes and, for a new file, its directory entry are on durable storage.
 */
export function appendDurableProjectMemoryFile(path: string, content: string): void {
  const existed = existsSync(path);
  const directory = dirname(path);
  ensureDurableProjectMemoryDirectory(directory);
  const descriptor = openSync(
    path,
    constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | noFollowFlag(),
    0o600,
  );
  try {
    if (!fstatSync(descriptor).isFile()) {
      throw new Error(`project memory durability path is not a regular file: ${path}`);
    }
    writeFileSync(descriptor, content, { encoding: "utf8" });
    syncDescriptor(descriptor, "file", path);
  } finally {
    closeSync(descriptor);
  }
  if (!existed) fsyncProjectMemoryDirectory(directory);
}

/** Re-acknowledges a prior uncertain append before a retry advances metadata. */
export function fsyncExistingProjectMemoryFile(path: string): void {
  if (!existsSync(path)) return;
  const descriptor = openSync(path, constants.O_RDONLY | noFollowFlag());
  try {
    if (!fstatSync(descriptor).isFile()) {
      throw new Error(`project memory durability path is not a regular file: ${path}`);
    }
    syncDescriptor(descriptor, "file", path);
  } finally {
    closeSync(descriptor);
  }
  fsyncProjectMemoryDirectory(dirname(path));
}
