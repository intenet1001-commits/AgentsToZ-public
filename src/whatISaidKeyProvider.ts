import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  whatISaidStoreAllowsInitialKey,
  type WhatISaidLocation,
} from "./whatISaidStore";

/** macOS stores the key itself; Windows stores only a CurrentUser-DPAPI blob. */
export const WHAT_I_SAID_KEYCHAIN_SERVICE = "com.portmanager.portmanager.what-i-said.v1";

export type WhatISaidKeyProviderErrorCode =
  | "WHAT_I_SAID_KEY_PLATFORM_UNSUPPORTED"
  | "WHAT_I_SAID_KEY_PATH_UNSAFE"
  | "WHAT_I_SAID_KEY_COMMAND_FAILED"
  | "WHAT_I_SAID_KEY_MISSING"
  | "WHAT_I_SAID_KEY_MALFORMED";

const MESSAGES: Record<WhatISaidKeyProviderErrorCode, string> = {
  WHAT_I_SAID_KEY_PLATFORM_UNSUPPORTED: "What-I-said secure key storage is not supported on this platform.",
  WHAT_I_SAID_KEY_PATH_UNSAFE: "What-I-said key storage path is unsafe.",
  WHAT_I_SAID_KEY_COMMAND_FAILED: "What-I-said secure key storage is unavailable.",
  WHAT_I_SAID_KEY_MISSING: "What-I-said secure key is missing for an existing local store.",
  WHAT_I_SAID_KEY_MALFORMED: "What-I-said secure key is invalid.",
};

export class WhatISaidKeyProviderError extends Error {
  constructor(readonly code: WhatISaidKeyProviderErrorCode) {
    super(MESSAGES[code]);
    this.name = "WhatISaidKeyProviderError";
  }
}

export interface WhatISaidKeyCommandResult {
  status: number | null;
  stdout: string;
  stderr?: string;
}

export interface WhatISaidKeyCommandOptions {
  detached?: boolean;
}

export type WhatISaidKeyCommandRunner = (
  command: string,
  args: readonly string[],
  input?: string,
  options?: WhatISaidKeyCommandOptions,
) => WhatISaidKeyCommandResult;

export interface ProductionWhatISaidKeyInput extends WhatISaidLocation {
  /** Test seams only. Production callers omit these fields. */
  platform?: string;
  commandRunner?: WhatISaidKeyCommandRunner;
  randomKey?: () => Uint8Array;
}

function fail(code: WhatISaidKeyProviderErrorCode): never {
  throw new WhatISaidKeyProviderError(code);
}

function defaultCommandRunner(
  command: string,
  args: readonly string[],
  input?: string,
  options?: WhatISaidKeyCommandOptions,
): WhatISaidKeyCommandResult {
  try {
    const result = Bun.spawnSync({
      cmd: [command, ...args],
      stdin: input === undefined ? "ignore" : Buffer.from(input, "utf8"),
      stdout: "pipe",
      stderr: "pipe",
      detached: options?.detached === true,
      windowsHide: true,
      maxBuffer: 64 * 1024,
      timeout: 5_000,
      killSignal: "SIGKILL",
    });
    return {
      status: result.exitCode,
      stdout: result.stdout.toString("utf8"),
      stderr: result.stderr.toString("utf8"),
    };
  } catch {
    return { status: null, stdout: "", stderr: "" };
  }
}

function canonicalProjectRoot(projectRoot: string): string {
  const requested = resolve(projectRoot);
  if (!existsSync(requested)) fail("WHAT_I_SAID_KEY_PATH_UNSAFE");
  const info = lstatSync(requested);
  if (info.isSymbolicLink() || !info.isDirectory()) fail("WHAT_I_SAID_KEY_PATH_UNSAFE");
  return realpathSync(requested);
}

function keyAccount(input: WhatISaidLocation, version: 1 | 2 = 1): string {
  if (typeof input.memoryId !== "string" || !input.memoryId || input.memoryId.includes("\0")) {
    fail("WHAT_I_SAID_KEY_PATH_UNSAFE");
  }
  // Validate the calling folder but bind the key to stable memory lineage only.
  // Renames and external worktrees must continue to decrypt the same authority.
  canonicalProjectRoot(input.projectRoot);
  return createHash("sha256")
    .update(`what-i-said-key-memory-v${version}\0${input.memoryId}`, "utf8")
    .digest("hex");
}

function keyBytes(value: Uint8Array): Buffer {
  const bytes = Buffer.from(value);
  if (bytes.byteLength !== 32) fail("WHAT_I_SAID_KEY_MALFORMED");
  return bytes;
}

function decodeKey(value: string): Buffer {
  const encoded = value.trim();
  if (!/^[A-Za-z0-9+/]{43}=$/.test(encoded)) fail("WHAT_I_SAID_KEY_MALFORMED");
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.byteLength !== 32 || bytes.toString("base64") !== encoded) fail("WHAT_I_SAID_KEY_MALFORMED");
  return bytes;
}

function generatedKey(input: ProductionWhatISaidKeyInput): Buffer {
  return keyBytes(input.randomKey?.() ?? randomBytes(32));
}

function assertKeyCreationIsSafe(input: ProductionWhatISaidKeyInput): void {
  try {
    // A missing OS credential must never become an implicit rotation. The
    // encrypted database is the durable evidence that this lineage already
    // had a key, even when every prompt has since been purged.
    if (!whatISaidStoreAllowsInitialKey(input)) {
      fail("WHAT_I_SAID_KEY_MISSING");
    }
  } catch (error) {
    if (error instanceof WhatISaidKeyProviderError) throw error;
    fail("WHAT_I_SAID_KEY_PATH_UNSAFE");
  }
}

type MacOSKeychainFindResult =
  | { kind: "found"; key: Buffer }
  | { kind: "missing" }
  | { kind: "malformed" }
  | { kind: "error" };

function findMacOSKey(
  run: WhatISaidKeyCommandRunner,
  account: string,
): MacOSKeychainFindResult {
  const found = run("/usr/bin/security", [
    "find-generic-password",
    "-a", account,
    "-s", WHAT_I_SAID_KEYCHAIN_SERVICE,
    "-w",
  ], undefined, { detached: true });
  if (found.status === 44) return { kind: "missing" };
  if (found.status !== 0) return { kind: "error" };
  try {
    return { kind: "found", key: decodeKey(found.stdout) };
  } catch (error) {
    if (error instanceof WhatISaidKeyProviderError && error.code === "WHAT_I_SAID_KEY_MALFORMED") {
      return { kind: "malformed" };
    }
    throw error;
  }
}

function createMacOSKey(
  input: ProductionWhatISaidKeyInput,
  run: WhatISaidKeyCommandRunner,
  account: string,
): Buffer {
  assertKeyCreationIsSafe(input);
  const generated = generatedKey(input);
  const encoded = generated.toString("base64");
  let added: WhatISaidKeyCommandResult;
  try {
    // Detached execution removes the controlling terminal so naked `-w`
    // consumes the two password/retype lines from the private stdin pipe.
    // The secret is never placed in argv; stdout/stderr remain captured and
    // are neither returned to callers nor logged.
    added = run("/usr/bin/security", [
      "add-generic-password",
      "-a", account,
      "-s", WHAT_I_SAID_KEYCHAIN_SERVICE,
      "-w",
    ], `${encoded}\n${encoded}\n`, { detached: true });
  } finally {
    generated.fill(0);
  }
  const authoritative = findMacOSKey(run, account);
  if (added.status !== 0 && authoritative.kind !== "found") fail("WHAT_I_SAID_KEY_COMMAND_FAILED");
  if (authoritative.kind !== "found") fail("WHAT_I_SAID_KEY_COMMAND_FAILED");
  return authoritative.key;
}

function macOSKey(
  input: ProductionWhatISaidKeyInput,
  primaryAccount: string,
  recoveryAccount: string,
): Buffer {
  const run = input.commandRunner ?? defaultCommandRunner;
  const primary = findMacOSKey(run, primaryAccount);
  if (primary.kind === "found") return primary.key;
  // Locked/unavailable Keychain is distinct from an absent item and must never
  // become an implicit key rotation.
  if (primary.kind === "error") fail("WHAT_I_SAID_KEY_COMMAND_FAILED");

  // Builds affected by the naked `security -w` bug may have left an empty v1
  // item. Never update or delete it: a deterministic v2 account is a separate
  // recovery lineage. Once v2 binds the DB, later loads may use it even though
  // that DB is no longer virgin. A malformed v2 always fails closed.
  const recovery = findMacOSKey(run, recoveryAccount);
  if (recovery.kind === "found") return recovery.key;
  if (recovery.kind === "malformed") fail("WHAT_I_SAID_KEY_MALFORMED");
  if (recovery.kind === "error") fail("WHAT_I_SAID_KEY_COMMAND_FAILED");

  if (primary.kind === "malformed") {
    // Only a strictly virgin store may recover from the known empty/malformed
    // v1 creation result. Existing encrypted or keyed evidence is immutable.
    if (!whatISaidStoreAllowsInitialKey(input)) fail("WHAT_I_SAID_KEY_MALFORMED");
    return createMacOSKey(input, run, recoveryAccount);
  }

  // A genuinely new lineage keeps the original v1 account. `add` has no
  // update mode; a concurrent winner is always re-read as authority.
  return createMacOSKey(input, run, primaryAccount);
}

function prepareWindowsKeyDirectory(appDataDir: string): string {
  const requested = resolve(appDataDir);
  if (existsSync(requested)) {
    const info = lstatSync(requested);
    if (info.isSymbolicLink() || !info.isDirectory()) fail("WHAT_I_SAID_KEY_PATH_UNSAFE");
  } else {
    mkdirSync(requested, { recursive: true, mode: 0o700 });
  }
  const directory = join(realpathSync(requested), "what-i-said-keys");
  if (existsSync(directory)) {
    const info = lstatSync(directory);
    if (info.isSymbolicLink() || !info.isDirectory() || realpathSync(directory) !== directory) {
      fail("WHAT_I_SAID_KEY_PATH_UNSAFE");
    }
  } else {
    mkdirSync(directory, { mode: 0o700 });
  }
  return directory;
}

const DPAPI_PROTECT_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  "$raw=[Console]::In.ReadToEnd().Trim()",
  "$bytes=[Convert]::FromBase64String($raw)",
  "$scope=[Security.Cryptography.DataProtectionScope]::CurrentUser",
  "$sealed=[Security.Cryptography.ProtectedData]::Protect($bytes,$null,$scope)",
  "[Console]::Out.Write([Convert]::ToBase64String($sealed))",
].join("; ");

const DPAPI_UNPROTECT_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  "$raw=[Console]::In.ReadToEnd().Trim()",
  "$sealed=[Convert]::FromBase64String($raw)",
  "$scope=[Security.Cryptography.DataProtectionScope]::CurrentUser",
  "$bytes=[Security.Cryptography.ProtectedData]::Unprotect($sealed,$null,$scope)",
  "[Console]::Out.Write([Convert]::ToBase64String($bytes))",
].join("; ");

function runPowerShell(
  run: WhatISaidKeyCommandRunner,
  script: string,
  input: string,
): string {
  const result = run("powershell.exe", [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    script,
  ], input);
  if (result.status !== 0) fail("WHAT_I_SAID_KEY_COMMAND_FAILED");
  return result.stdout.trim();
}

function windowsKey(input: ProductionWhatISaidKeyInput, account: string): Buffer {
  const run = input.commandRunner ?? defaultCommandRunner;
  const directory = prepareWindowsKeyDirectory(input.appDataDir);
  const path = join(directory, `${account}.dpapi`);
  if (existsSync(path)) {
    const info = lstatSync(path);
    if (info.isSymbolicLink() || !info.isFile()) fail("WHAT_I_SAID_KEY_PATH_UNSAFE");
    const protectedValue = readFileSync(path, "utf8").trim();
    if (!protectedValue || protectedValue.includes("\0")) fail("WHAT_I_SAID_KEY_MALFORMED");
    return decodeKey(runPowerShell(run, DPAPI_UNPROTECT_SCRIPT, protectedValue));
  }
  assertKeyCreationIsSafe(input);

  const key = generatedKey(input);
  const protectedValue = runPowerShell(run, DPAPI_PROTECT_SCRIPT, key.toString("base64"));
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(protectedValue)) fail("WHAT_I_SAID_KEY_MALFORMED");
  try {
    writeFileSync(path, `${protectedValue}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    if (process.platform !== "win32") chmodSync(path, 0o600);
  } catch {
    // A concurrent creator may have won. Never overwrite its DPAPI identity;
    // load that authoritative user-bound blob when it is now present.
    if (!existsSync(path)) fail("WHAT_I_SAID_KEY_COMMAND_FAILED");
    const info = lstatSync(path);
    if (info.isSymbolicLink() || !info.isFile()) fail("WHAT_I_SAID_KEY_PATH_UNSAFE");
    const existing = readFileSync(path, "utf8").trim();
    return decodeKey(runPowerShell(run, DPAPI_UNPROTECT_SCRIPT, existing));
  }
  return key;
}

/**
 * Loads or creates the project's 32-byte key from platform-native user-bound
 * secret storage. Unsupported platforms fail closed; tests pass a key directly
 * to the store and never invoke host credential UI.
 */
export function loadOrCreateProductionWhatISaidKey(input: ProductionWhatISaidKeyInput): Buffer {
  const platform = input.platform ?? process.platform;
  const account = keyAccount(input);
  if (platform === "darwin") return macOSKey(input, account, keyAccount(input, 2));
  if (platform === "win32") return windowsKey(input, account);
  fail("WHAT_I_SAID_KEY_PLATFORM_UNSUPPORTED");
}
