import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadOrCreateProductionWhatISaidKey,
  WHAT_I_SAID_KEYCHAIN_SERVICE,
  WhatISaidKeyProviderError,
  type WhatISaidKeyCommandRunner,
} from "../src/whatISaidKeyProvider";
import {
  captureWhatISaidPrompt,
  configureWhatISaidCapture,
  readWhatISaidStatus,
  whatISaidDatabasePath,
  whatISaidFeedRegistrationReadOnly,
  whatISaidStoreAllowsInitialKey,
} from "../src/whatISaidStore";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const path of temporaryRoots.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture() {
  const parent = mkdtempSync(join(tmpdir(), "agentstoz-what-i-said-key-"));
  temporaryRoots.push(parent);
  const projectRoot = join(parent, "project");
  const appDataDir = join(parent, "app-data");
  mkdirSync(projectRoot);
  mkdirSync(appDataDir);
  return { projectRoot, appDataDir, memoryId: "stable-key-memory" };
}

type MacCommandCall = {
  command: string;
  args: readonly string[];
  input?: string;
  detached: boolean;
  stdout: string;
  stderr: string;
};

function memoryKeychainRunner(input?: {
  values?: Map<string, string>;
  onAdd?: (account: string, encoded: string, values: Map<string, string>) => number;
}): { runner: WhatISaidKeyCommandRunner; values: Map<string, string>; calls: MacCommandCall[] } {
  const values = input?.values ?? new Map<string, string>();
  const calls: MacCommandCall[] = [];
  const runner: WhatISaidKeyCommandRunner = (command, args, stdin, options) => {
    expect(command).toBe("/usr/bin/security");
    const accountIndex = args.indexOf("-a");
    const serviceIndex = args.indexOf("-s");
    const account = args[accountIndex + 1]!;
    expect(account).toMatch(/^[0-9a-f]{64}$/);
    expect(args[serviceIndex + 1]).toBe(WHAT_I_SAID_KEYCHAIN_SERVICE);
    expect(args.at(-1)).toBe("-w");
    expect(options?.detached).toBe(true);
    let status: number;
    let stdout = "";
    const stderr = "";
    if (args[0] === "find-generic-password") {
      if (values.has(account)) {
        status = 0;
        stdout = `${values.get(account)!}\n`;
      } else {
        status = 44;
      }
    } else {
      expect(args[0]).toBe("add-generic-password");
      const lines = (stdin ?? "").split("\n");
      expect(lines[0]).toBeTruthy();
      expect(lines[1]).toBe(lines[0]);
      expect(lines[2]).toBe("");
      status = input?.onAdd
        ? input.onAdd(account, lines[0]!, values)
        : values.has(account)
          ? 45
          : (values.set(account, lines[0]!), 0);
    }
    calls.push({ command, args, input: stdin, detached: options?.detached === true, stdout, stderr });
    return { status, stdout, stderr };
  };
  return { runner, values, calls };
}

function createVirginStore(input: ReturnType<typeof fixture>, version: 1 | 2 | 3 | 4 | 5): string {
  const databasePath = whatISaidDatabasePath(input);
  const identityHash = createHash("sha256")
    .update(`what-i-said-memory-v1\0${input.memoryId}`, "utf8")
    .digest("hex");
  const keyColumns = version >= 2
    ? "key_version INTEGER NOT NULL, key_verifier TEXT,"
    : "";
  const feedColumns = version >= 3
    ? "feed_key_nonce BLOB, feed_key_ciphertext BLOB, feed_key_auth_tag BLOB, feed_registration_id TEXT,"
    : "";
  const columns = [
    "singleton", "schema_version", "identity_hash", "memory_id",
    ...(version >= 2 ? ["key_version", "key_verifier"] : []),
    "capture_enabled", "capture_enabled_at", "last_scan_at", "last_capture_at",
    "retention_policy", "analysis_allowed", "feed_enabled", "feed_token_hash",
    ...(version >= 3
      ? ["feed_key_nonce", "feed_key_ciphertext", "feed_key_auth_tag", "feed_registration_id"]
      : []),
    "feed_token_updated_at", "index_epoch", "updated_at",
  ];
  const values: Array<string | number | null> = [
    1, version, identityHash, input.memoryId,
    ...(version >= 2 ? [1, null] : []),
    0, null, null, null, "90", 0, 0, null,
    ...(version >= 3 ? [null, null, null, null] : []),
    null, "virgin-index-epoch", "2026-08-30T00:00:00.000Z",
  ];
  const db = new Database(databasePath, { create: true });
  try {
    db.exec(`
      CREATE TABLE what_i_said_settings (
        singleton INTEGER PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        identity_hash TEXT NOT NULL,
        memory_id TEXT NOT NULL,
        ${keyColumns}
        capture_enabled INTEGER NOT NULL,
        capture_enabled_at TEXT,
        last_scan_at TEXT,
        last_capture_at TEXT,
        retention_policy TEXT NOT NULL,
        analysis_allowed INTEGER NOT NULL,
        feed_enabled INTEGER NOT NULL,
        feed_token_hash TEXT,
        ${feedColumns}
        feed_token_updated_at TEXT,
        index_epoch TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE what_i_said_events (seq INTEGER PRIMARY KEY AUTOINCREMENT);
      PRAGMA user_version = ${version};
    `);
    if (version >= 4) {
      db.exec(`
        CREATE TABLE what_i_said_transcript_cursors (source_id TEXT PRIMARY KEY);
        CREATE TABLE what_i_said_discovery_cursors (scope TEXT PRIMARY KEY);
        CREATE TABLE what_i_said_transcript_classifications (source_id TEXT PRIMARY KEY);
      `);
    }
    db.query(`INSERT INTO what_i_said_settings(${columns.join(", ")})
      VALUES (${columns.map(() => "?").join(", ")})`).run(...values);
  } finally {
    db.close();
  }
  return databasePath;
}

function mutateStore(databasePath: string, sql: string): void {
  const db = new Database(databasePath);
  try { db.exec(sql); }
  finally { db.close(); }
}

describe("What-I-said production key provider", () => {
  test("fails closed on unsupported platforms", () => {
    const input = fixture();
    let failure: unknown;
    try {
      loadOrCreateProductionWhatISaidKey({ ...input, platform: "linux" });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(WhatISaidKeyProviderError);
    expect((failure as WhatISaidKeyProviderError).code).toBe("WHAT_I_SAID_KEY_PLATFORM_UNSUPPORTED");
  });

  test("loads a 32-byte macOS Keychain value", () => {
    const input = fixture();
    const key = Buffer.alloc(32, 0x31);
    let calls = 0;
    const runner: WhatISaidKeyCommandRunner = (_command, args, _stdin, options) => {
      calls += 1;
      expect(args[0]).toBe("find-generic-password");
      expect(options?.detached).toBe(true);
      return { status: 0, stdout: `${key.toString("base64")}\n`, stderr: "" };
    };
    expect(loadOrCreateProductionWhatISaidKey({ ...input, platform: "darwin", commandRunner: runner }))
      .toEqual(key);
    expect(calls).toBe(1);
  });

  test("fails closed when either Keychain lookup returns a non-missing command error", () => {
    const cases = [
      { label: "primary", failingLookup: 1, expectedLookups: 1 },
      { label: "recovery", failingLookup: 2, expectedLookups: 2 },
    ];
    for (const entry of cases) {
      const input = fixture();
      let lookups = 0;
      const runner: WhatISaidKeyCommandRunner = (_command, args, _stdin, options) => {
        expect(args[0]).toBe("find-generic-password");
        expect(options?.detached).toBe(true);
        lookups += 1;
        return lookups === entry.failingLookup
          ? { status: 36, stdout: "", stderr: "keychain unavailable" }
          : { status: 44, stdout: "", stderr: "item not found" };
      };
      expect(() => loadOrCreateProductionWhatISaidKey({
        ...input,
        platform: "darwin",
        commandRunner: runner,
        randomKey: () => {
          throw new Error("a command error must never create a key");
        },
      }), entry.label).toThrow(expect.objectContaining({ code: "WHAT_I_SAID_KEY_COMMAND_FAILED" }));
      expect(lookups, entry.label).toBe(entry.expectedLookups);
    }
  });

  test("reuses the deterministic v2 account when v1 is missing", () => {
    const input = fixture();
    const recoveryKey = Buffer.alloc(32, 0x32);
    const accounts: string[] = [];
    const runner: WhatISaidKeyCommandRunner = (_command, args, _stdin, options) => {
      expect(args[0]).toBe("find-generic-password");
      expect(options?.detached).toBe(true);
      accounts.push(args[args.indexOf("-a") + 1]!);
      return accounts.length === 1
        ? { status: 44, stdout: "", stderr: "item not found" }
        : { status: 0, stdout: `${recoveryKey.toString("base64")}\n`, stderr: "" };
    };
    expect(loadOrCreateProductionWhatISaidKey({
      ...input,
      platform: "darwin",
      commandRunner: runner,
      randomKey: () => {
        throw new Error("a valid v2 item must be reused");
      },
    })).toEqual(recoveryKey);
    expect(accounts).toEqual([
      "830c335079888956dd677ce04ccfb84687d2cf9d0d475d5ff46d6485be52d3d9",
      "8b352b9a1345b1b932d5fbb07847a6d4342035bb99cada2330cb19430b5386c0",
    ]);
  });

  test("fails closed on a malformed v2 recovery item", () => {
    const input = fixture();
    let lookups = 0;
    const runner: WhatISaidKeyCommandRunner = (_command, args) => {
      expect(args[0]).toBe("find-generic-password");
      lookups += 1;
      return lookups === 1
        ? { status: 44, stdout: "", stderr: "item not found" }
        : { status: 0, stdout: "not-a-32-byte-base64-key\n", stderr: "" };
    };
    expect(() => loadOrCreateProductionWhatISaidKey({
      ...input,
      platform: "darwin",
      commandRunner: runner,
      randomKey: () => {
        throw new Error("a malformed recovery item must never be replaced");
      },
    })).toThrow(expect.objectContaining({ code: "WHAT_I_SAID_KEY_MALFORMED" }));
    expect(lookups).toBe(2);
  });

  test("creates a macOS Keychain key with two private stdin lines and no secret in argv/stdout/stderr", () => {
    const input = fixture();
    const key = Buffer.alloc(32, 0x42);
    const mock = memoryKeychainRunner();
    expect(loadOrCreateProductionWhatISaidKey({
      ...input,
      platform: "darwin",
      commandRunner: mock.runner,
      randomKey: () => key,
    })).toEqual(key);
    const encoded = key.toString("base64");
    const add = mock.calls.find(call => call.args[0] === "add-generic-password")!;
    expect(add.detached).toBe(true);
    expect(add.input).toBe(`${encoded}\n${encoded}\n`);
    expect([add.command, ...add.args].join(" ")).not.toContain(encoded);
    expect(add.stdout).not.toContain(encoded);
    expect(add.stderr).not.toContain(encoded);
    expect(add.args).not.toContain("-U");
    expect(add.args.at(-1)).toBe("-w");
    expect(mock.calls.every(call => call.args.at(-1) === "-w")).toBe(true);
    expect(existsSync(join(input.appDataDir, "what-i-said"))).toBe(false);
  });

  test("re-reads the winning Keychain item after a concurrent creator", () => {
    const input = fixture();
    const generated = Buffer.alloc(32, 0x43);
    const winner = Buffer.alloc(32, 0x44);
    const mock = memoryKeychainRunner({
      onAdd: (account, encoded, values) => {
        expect(encoded).toBe(generated.toString("base64"));
        values.set(account, winner.toString("base64"));
        return 45;
      },
    });
    expect(loadOrCreateProductionWhatISaidKey({
      ...input,
      platform: "darwin",
      commandRunner: mock.runner,
      randomKey: () => generated,
    })).toEqual(winner);
  });

  test("fails closed when an add cannot be confirmed by an authoritative re-read", () => {
    const cases = [
      { label: "successful add then missing", addStatus: 0, authoritativeStatus: 44, authoritativeValue: "" },
      { label: "failed add then missing", addStatus: 45, authoritativeStatus: 44, authoritativeValue: "" },
      { label: "successful add then malformed", addStatus: 0, authoritativeStatus: 0, authoritativeValue: "malformed" },
      { label: "failed add then malformed", addStatus: 45, authoritativeStatus: 0, authoritativeValue: "malformed" },
    ];
    for (const entry of cases) {
      const input = fixture();
      let finds = 0;
      let adds = 0;
      const generated = Buffer.alloc(32, 0x46);
      const runner: WhatISaidKeyCommandRunner = (_command, args, stdin, options) => {
        expect(options?.detached).toBe(true);
        if (args[0] === "add-generic-password") {
          adds += 1;
          expect(stdin).toBe(`${generated.toString("base64")}\n${generated.toString("base64")}\n`);
          return { status: entry.addStatus, stdout: "", stderr: "" };
        }
        expect(args[0]).toBe("find-generic-password");
        finds += 1;
        if (finds <= 2) return { status: 44, stdout: "", stderr: "item not found" };
        return {
          status: entry.authoritativeStatus,
          stdout: entry.authoritativeValue,
          stderr: "",
        };
      };
      expect(() => loadOrCreateProductionWhatISaidKey({
        ...input,
        platform: "darwin",
        commandRunner: runner,
        randomKey: () => generated,
      }), entry.label).toThrow(expect.objectContaining({ code: "WHAT_I_SAID_KEY_COMMAND_FAILED" }));
      expect(adds, entry.label).toBe(1);
      expect(finds, entry.label).toBe(3);
    }
  });

  test("fails closed on an existing empty Keychain item without update or deletion", () => {
    const input = fixture();
    configureWhatISaidCapture({
      ...input,
      enabled: true,
      retention: "forever",
      analysisAllowed: false,
      now: "2026-08-30T10:00:00Z",
    });
    captureWhatISaidPrompt({
      ...input,
      key: Buffer.alloc(32, 0x55),
      agent: "codex",
      sourceIdentity: "session.jsonl",
      sourceEventIdentity: "empty-key-regression",
      recordedAt: "2026-08-30T10:01:00Z",
      text: "encrypted evidence must remain bound to its original key",
      now: "2026-08-30T10:01:01Z",
    });
    let primaryAccount: string | null = null;
    const values = new Map<string, string>();
    const mock = memoryKeychainRunner({ values });
    const runner: WhatISaidKeyCommandRunner = (command, args, stdin, options) => {
      const account = args[args.indexOf("-a") + 1]!;
      if (primaryAccount === null) {
        primaryAccount = account;
        values.set(account, "");
      }
      return mock.runner(command, args, stdin, options);
    };
    expect(() => loadOrCreateProductionWhatISaidKey({
      ...input,
      platform: "darwin",
      commandRunner: runner,
      randomKey: () => {
        throw new Error("must not generate a replacement key");
      },
    })).toThrow(expect.objectContaining({ code: "WHAT_I_SAID_KEY_MALFORMED" }));
    expect(mock.calls.filter(call => call.args[0] === "find-generic-password")).toHaveLength(2);
    expect(mock.calls.some(call => call.args[0] === "add-generic-password")).toBe(false);
  });

  test("recovers a known empty v1 item into a separate v2 account only while the store is virgin", () => {
    const input = fixture();
    readWhatISaidStatus(input);
    const recoveredKey = Buffer.alloc(32, 0x45);
    let primaryAccount: string | null = null;
    let recoveryAccount: string | null = null;
    const values = new Map<string, string>();
    const mock = memoryKeychainRunner({ values });
    const runner: WhatISaidKeyCommandRunner = (command, args, stdin, options) => {
      const account = args[args.indexOf("-a") + 1]!;
      if (primaryAccount === null) {
        primaryAccount = account;
        values.set(account, "");
      } else if (account !== primaryAccount && recoveryAccount === null) {
        recoveryAccount = account;
      }
      return mock.runner(command, args, stdin, options);
    };
    const first = loadOrCreateProductionWhatISaidKey({
      ...input,
      platform: "darwin",
      commandRunner: runner,
      randomKey: () => recoveredKey,
    });
    expect(first).toEqual(recoveredKey);
    expect(recoveryAccount).not.toBeNull();
    expect(recoveryAccount).not.toBe(primaryAccount);

    configureWhatISaidCapture({
      ...input,
      enabled: true,
      retention: "forever",
      analysisAllowed: false,
      now: "2026-08-30T11:00:00Z",
    });
    captureWhatISaidPrompt({
      ...input,
      key: first,
      agent: "codex",
      sourceIdentity: "session.jsonl",
      sourceEventIdentity: "v2-recovery-event",
      recordedAt: "2026-08-30T11:01:00Z",
      text: "v2 recovery remains authoritative after the DB is bound",
      now: "2026-08-30T11:01:01Z",
    });
    expect(whatISaidStoreAllowsInitialKey(input)).toBe(false);
    expect(loadOrCreateProductionWhatISaidKey({
      ...input,
      platform: "darwin",
      commandRunner: runner,
      randomKey: () => {
        throw new Error("existing v2 must be reused");
      },
    })).toEqual(recoveredKey);
  });

  test("schema-v4 cursor, discovery, and classification evidence each make a store non-virgin", () => {
    const sourceId = `wisc_${"a".repeat(64)}`;
    const cases: Array<{ table: string; insert: string }> = [
      {
        table: "transcript cursor",
        insert: `INSERT INTO what_i_said_transcript_cursors(
          source_id, source_agent, generation, file_identity, byte_offset,
          line_number, anchor_length, anchor_hash, discard_until_newline, updated_at
        ) VALUES ('${sourceId}', 'codex', 0, 'fixture', 0, 0, 0, NULL, 0, '2026-08-30T12:00:00Z')`,
      },
      {
        table: "discovery cursor",
        insert: `INSERT INTO what_i_said_discovery_cursors(scope, after_source_id, updated_at)
          VALUES ('codex', NULL, '2026-08-30T12:00:00Z')`,
      },
      {
        table: "classification",
        insert: `INSERT INTO what_i_said_transcript_classifications(
          source_id, source_agent, file_identity, classified_size, owned, updated_at
        ) VALUES ('${sourceId}', 'codex', 'fixture', 0, 0, '2026-08-30T12:00:00Z')`,
      },
    ];
    for (const entry of cases) {
      const input = fixture();
      readWhatISaidStatus(input);
      const db = new Database(whatISaidDatabasePath(input));
      try { db.exec(entry.insert); }
      finally { db.close(); }
      expect(whatISaidStoreAllowsInitialKey(input), entry.table).toBe(false);
    }
  });

  test("a single event makes otherwise virgin settings non-virgin", () => {
    const input = fixture();
    const databasePath = createVirginStore(input, 4);
    expect(whatISaidStoreAllowsInitialKey(input)).toBe(true);
    mutateStore(databasePath, "INSERT INTO what_i_said_events DEFAULT VALUES");
    expect(whatISaidStoreAllowsInitialKey(input)).toBe(false);
  });

  test("checking a lineage with no store does not create app-data or storage", () => {
    for (const existingAppData of [false, true]) {
      const input = fixture();
      if (!existingAppData) rmSync(input.appDataDir, { recursive: true, force: true });
      const storageDirectory = join(input.appDataDir, "what-i-said");
      expect(existsSync(storageDirectory)).toBe(false);
      expect(existsSync(input.appDataDir)).toBe(existingAppData);

      expect(whatISaidStoreAllowsInitialKey(input), existingAppData ? "existing app-data" : "missing app-data").toBe(true);

      expect(existsSync(input.appDataDir)).toBe(existingAppData);
      expect(existsSync(storageDirectory)).toBe(false);
    }
  });

  test("requires untouched virgin metadata in schema versions 1 through 5", () => {
    for (const version of [1, 2, 3, 4, 5] as const) {
      const input = fixture();
      const databasePath = createVirginStore(input, version);
      expect(whatISaidStoreAllowsInitialKey(input), `v${version} baseline`).toBe(true);

      mutateStore(databasePath, `UPDATE what_i_said_settings SET retention_policy = '30'`);
      expect(whatISaidStoreAllowsInitialKey(input), `v${version} retention`).toBe(false);
      mutateStore(databasePath, `UPDATE what_i_said_settings SET retention_policy = '90'`);

      mutateStore(databasePath, `UPDATE what_i_said_settings
        SET feed_token_updated_at = '2026-08-30T12:00:00.000Z'`);
      expect(whatISaidStoreAllowsInitialKey(input), `v${version} feed timestamp`).toBe(false);
      mutateStore(databasePath, `UPDATE what_i_said_settings SET feed_token_updated_at = NULL`);

      if (version >= 2) {
        mutateStore(databasePath, `UPDATE what_i_said_settings SET key_version = 2`);
        expect(whatISaidStoreAllowsInitialKey(input), `v${version} key version`).toBe(false);
        mutateStore(databasePath, `UPDATE what_i_said_settings SET key_version = 1`);
      }

      mutateStore(databasePath, `ALTER TABLE what_i_said_settings ADD COLUMN retention_updated_at TEXT`);
      expect(whatISaidStoreAllowsInitialKey(input), `v${version} null retention timestamp`).toBe(true);
      mutateStore(databasePath, `UPDATE what_i_said_settings
        SET retention_updated_at = '2026-08-30T12:01:00.000Z'`);
      expect(whatISaidStoreAllowsInitialKey(input), `v${version} retention timestamp`).toBe(false);
    }
  });

  test("rejects representative corrupted or previously-used schema-v4 settings", () => {
    const cases = [
      { label: "schema version", sql: "UPDATE what_i_said_settings SET schema_version = 3" },
      { label: "identity", sql: "UPDATE what_i_said_settings SET identity_hash = 'wrong'" },
      { label: "memory lineage", sql: "UPDATE what_i_said_settings SET memory_id = 'other-memory'" },
      { label: "capture enabled", sql: "UPDATE what_i_said_settings SET capture_enabled = 1" },
      { label: "capture history", sql: "UPDATE what_i_said_settings SET capture_enabled_at = '2026-08-30T12:00:00Z'" },
      { label: "scan history", sql: "UPDATE what_i_said_settings SET last_scan_at = '2026-08-30T12:00:00Z'" },
      { label: "capture receipt history", sql: "UPDATE what_i_said_settings SET last_capture_at = '2026-08-30T12:00:00Z'" },
      { label: "analysis opt-in", sql: "UPDATE what_i_said_settings SET analysis_allowed = 1" },
      { label: "feed enabled", sql: "UPDATE what_i_said_settings SET feed_enabled = 1" },
      { label: "legacy feed credential", sql: "UPDATE what_i_said_settings SET feed_token_hash = 'present'" },
      { label: "bound key", sql: `UPDATE what_i_said_settings SET key_verifier = '${"a".repeat(64)}'` },
      { label: "encrypted feed nonce", sql: "UPDATE what_i_said_settings SET feed_key_nonce = X'00'" },
      { label: "encrypted feed ciphertext", sql: "UPDATE what_i_said_settings SET feed_key_ciphertext = X'00'" },
      { label: "encrypted feed auth tag", sql: "UPDATE what_i_said_settings SET feed_key_auth_tag = X'00'" },
      { label: "feed registration", sql: "UPDATE what_i_said_settings SET feed_registration_id = 'registration'" },
      { label: "missing singleton", sql: "DELETE FROM what_i_said_settings WHERE singleton = 1" },
      { label: "unsupported database schema", sql: "PRAGMA user_version = 5" },
    ];
    for (const entry of cases) {
      const input = fixture();
      const databasePath = createVirginStore(input, 4);
      mutateStore(databasePath, entry.sql);
      expect(whatISaidStoreAllowsInitialKey(input), entry.label).toBe(false);
    }
  });

  test("treats orphaned SQLite sidecars as unavailable durable state, never a virgin store", () => {
    for (const suffix of ["-journal", "-wal", "-shm"]) {
      const input = fixture();
      const databasePath = whatISaidDatabasePath(input);
      expect(existsSync(databasePath)).toBe(false);
      writeFileSync(`${databasePath}${suffix}`, "orphaned-sidecar", { mode: 0o600 });

      expect(whatISaidStoreAllowsInitialKey(input), suffix).toBe(false);
      expect(() => whatISaidFeedRegistrationReadOnly(input)).toThrow(
        expect.objectContaining({ code: "WHAT_I_SAID_STORE_UNAVAILABLE" }),
      );

      const mock = memoryKeychainRunner();
      expect(() => loadOrCreateProductionWhatISaidKey({
        ...input,
        platform: "darwin",
        commandRunner: mock.runner,
        randomKey: () => Buffer.alloc(32, 0x7c),
      })).toThrow(expect.objectContaining({ code: "WHAT_I_SAID_KEY_MISSING" }));
      expect(mock.calls.some(call => call.args[0] === "add-generic-password")).toBe(false);
    }

    if (process.platform !== "win32") {
      for (const suffix of ["", "-wal"]) {
        const input = fixture();
        const databasePath = whatISaidDatabasePath(input);
        symlinkSync(join(input.appDataDir, "missing-symlink-target"), `${databasePath}${suffix}`);
        expect(whatISaidStoreAllowsInitialKey(input), `dangling symlink ${suffix || "db"}`).toBe(false);
      }
    }
  });

  test("rejects dangling app-data and storage-directory symlinks before Keychain creation", () => {
    if (process.platform === "win32") return;
    for (const target of ["app-data", "storage"] as const) {
      const input = fixture();
      if (target === "app-data") {
        rmSync(input.appDataDir, { recursive: true, force: true });
        symlinkSync(join(input.projectRoot, "missing-app-data"), input.appDataDir);
      } else {
        symlinkSync(join(input.projectRoot, "missing-storage"), join(input.appDataDir, "what-i-said"));
      }

      expect(whatISaidStoreAllowsInitialKey(input), target).toBe(false);
      const mock = memoryKeychainRunner();
      expect(() => loadOrCreateProductionWhatISaidKey({
        ...input,
        platform: "darwin",
        commandRunner: mock.runner,
        randomKey: () => Buffer.alloc(32, 0x7d),
      })).toThrow(expect.objectContaining({ code: "WHAT_I_SAID_KEY_MISSING" }));
      expect(mock.calls.some(call => call.args[0] === "add-generic-password"), target).toBe(false);
    }
  });

  test("allows the first OS key for an empty legacy-created store", () => {
    const mac = fixture();
    readWhatISaidStatus(mac);
    const macKey = Buffer.alloc(32, 0x7a);
    const macMock = memoryKeychainRunner();
    expect(loadOrCreateProductionWhatISaidKey({
      ...mac,
      platform: "darwin",
      commandRunner: macMock.runner,
      randomKey: () => macKey,
    })).toEqual(macKey);
    expect(macMock.calls.filter(call => call.args[0] === "find-generic-password")).toHaveLength(3);
    expect(macMock.calls.filter(call => call.args[0] === "add-generic-password")).toHaveLength(1);

    const windows = fixture();
    readWhatISaidStatus(windows);
    const windowsKey = Buffer.alloc(32, 0x7b);
    expect(loadOrCreateProductionWhatISaidKey({
      ...windows,
      platform: "win32",
      commandRunner: (_command, _args, stdin) => {
        expect(stdin).toBe(windowsKey.toString("base64"));
        return { status: 0, stdout: Buffer.from("protected-legacy-empty-store").toString("base64") };
      },
      randomKey: () => windowsKey,
    })).toEqual(windowsKey);
  });

  test("never replaces a missing Keychain or DPAPI key after encrypted evidence exists", () => {
    const createBoundStore = (input: ReturnType<typeof fixture>) => {
      configureWhatISaidCapture({
        ...input,
        enabled: true,
        retention: "forever",
        analysisAllowed: false,
        now: "2026-08-30T10:00:00Z",
      });
      captureWhatISaidPrompt({
        ...input,
        key: Buffer.alloc(32, 0x55),
        agent: "codex",
        sourceIdentity: "session.jsonl",
        sourceEventIdentity: "event-1",
        recordedAt: "2026-08-30T10:01:00Z",
        text: "durable encrypted evidence",
        now: "2026-08-30T10:01:01Z",
      });
    };

    const mac = fixture();
    createBoundStore(mac);
    const macMock = memoryKeychainRunner();
    expect(() => loadOrCreateProductionWhatISaidKey({
      ...mac,
      platform: "darwin",
      commandRunner: macMock.runner,
      randomKey: () => Buffer.alloc(32, 0x7a),
    })).toThrow(expect.objectContaining({ code: "WHAT_I_SAID_KEY_MISSING" }));
    expect(macMock.calls.filter(call => call.args[0] === "find-generic-password")).toHaveLength(2);
    expect(macMock.calls.some(call => call.args[0] === "add-generic-password")).toBe(false);

    const windows = fixture();
    createBoundStore(windows);
    let windowsCalls = 0;
    expect(() => loadOrCreateProductionWhatISaidKey({
      ...windows,
      platform: "win32",
      commandRunner: () => {
        windowsCalls += 1;
        return { status: 0, stdout: "" };
      },
      randomKey: () => Buffer.alloc(32, 0x7b),
    })).toThrow(expect.objectContaining({ code: "WHAT_I_SAID_KEY_MISSING" }));
    expect(windowsCalls).toBe(0);
  });

  test("writes only a DPAPI blob and decrypts it on the next load", () => {
    const input = fixture();
    const key = Buffer.alloc(32, 0x53);
    const protectedBlob = Buffer.from("protected-current-user-value").toString("base64");
    const protect: WhatISaidKeyCommandRunner = (_command, args, stdin) => {
      expect(args).toContain("-NonInteractive");
      expect(stdin).toBe(key.toString("base64"));
      return { status: 0, stdout: protectedBlob };
    };
    expect(loadOrCreateProductionWhatISaidKey({
      ...input,
      platform: "win32",
      commandRunner: protect,
      randomKey: () => key,
    })).toEqual(key);
    expect(existsSync(join(input.appDataDir, "what-i-said-keys"))).toBe(true);

    const unprotect: WhatISaidKeyCommandRunner = (_command, _args, stdin) => {
      expect(stdin).toBe(protectedBlob);
      return { status: 0, stdout: key.toString("base64") };
    };
    expect(loadOrCreateProductionWhatISaidKey({
      ...input,
      platform: "win32",
      commandRunner: unprotect,
    })).toEqual(key);
  });

  test("uses the same Keychain account after a project folder move", () => {
    const input = fixture();
    const key = Buffer.alloc(32, 0x64);
    const accounts: string[] = [];
    const runner: WhatISaidKeyCommandRunner = (_command, args) => {
      accounts.push(args[args.indexOf("-a") + 1]!);
      return { status: 0, stdout: key.toString("base64"), stderr: "" };
    };
    loadOrCreateProductionWhatISaidKey({ ...input, platform: "darwin", commandRunner: runner });
    const movedRoot = join(join(input.projectRoot, ".."), "moved-project");
    renameSync(input.projectRoot, movedRoot);
    loadOrCreateProductionWhatISaidKey({
      ...input,
      projectRoot: movedRoot,
      platform: "darwin",
      commandRunner: runner,
    });
    expect(accounts).toHaveLength(2);
    expect(accounts[0]).toBe(accounts[1]);
  });
});
