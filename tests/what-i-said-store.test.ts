import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  advanceWhatISaidScan,
  captureWhatISaidPrompt,
  captureWhatISaidWithheldTranscriptRecord,
  commitWhatISaidTranscriptClassifications,
  commitWhatISaidDiscoveryCursor,
  commitWhatISaidTranscriptCursor,
  configureWhatISaidCapture,
  createWhatISaidFeedAuthorization,
  createWhatISaidFeedResponseProof,
  disableWhatISaidCapture,
  enableWhatISaidCapture,
  enableWhatISaidFeed,
  hasActiveWhatISaidEntry,
  listRecentWhatISaidEntries,
  listWhatISaidEntries,
  probeWhatISaidLastCaptureReadOnly,
  purgeAllWhatISaidEntries,
  purgeExpiredWhatISaidDatabases,
  purgeExpiredWhatISaidEntries,
  purgeWhatISaidEntries,
  readWhatISaidFeed,
  readWhatISaidDiscoveryCursor,
  readWhatISaidStatus,
  readWhatISaidTranscriptClassifications,
  readWhatISaidTranscriptCursor,
  resetWhatISaidFeedEpoch,
  rebindWhatISaidFeedRegistration,
  revokeWhatISaidFeed,
  revokeWhatISaidFeedByRegistrationId,
  rotateWhatISaidFeedToken,
  setWhatISaidAnalysisAllowed,
  setWhatISaidRetention,
  softDeleteAllWhatISaidEntries,
  softDeleteWhatISaidEntries,
  verifyWhatISaidFeedProof,
  verifyWhatISaidFeedResponseProof,
  verifyWhatISaidStoreKey,
  verifyWhatISaidTranscriptCursorAnchor,
  deriveWhatISaidTranscriptSourceId,
  whatISaidDatabasePath,
  WhatISaidStoreError,
  type WhatISaidLocation,
  type WhatISaidRetention,
} from "../src/whatISaidStore";

const temporaryRoots: string[] = [];
const KEY = Buffer.alloc(32, 0x41);

afterEach(() => {
  for (const path of temporaryRoots.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture(memoryId = "memory-what-i-said"): WhatISaidLocation {
  const parent = mkdtempSync(join(tmpdir(), "agentstoz-what-i-said-"));
  temporaryRoots.push(parent);
  const projectRoot = join(parent, "project");
  const appDataDir = join(parent, "app-data");
  mkdirSync(projectRoot);
  mkdirSync(appDataDir);
  return { projectRoot, appDataDir, memoryId };
}

function prompt(location: WhatISaidLocation, overrides: Partial<Parameters<typeof captureWhatISaidPrompt>[0]> = {}) {
  return captureWhatISaidPrompt({
    ...location,
    key: KEY,
    agent: "codex",
    sourceIdentity: "rollout-a.jsonl",
    sourceEventIdentity: "1",
    recordedAt: "2026-08-30T10:01:00.000Z",
    text: "원문은 암호화되어야 합니다",
    now: "2026-08-30T10:02:00.000Z",
    ...overrides,
  });
}

describe("encrypted local What-I-said authority", () => {
  /**
   * VOC 2026-09-01: "내가한말도 단말베이스인데 단말정보를 포함해서 기록이 되는지".
   * 오늘은 한 저장소 안에서 모두 같은 값이지만, 아카이브·복원·원격 적재로 여러
   * 기기의 기록이 합쳐진 뒤에는 이 값이 출처를 되찾는 유일한 근거다.
   */
  test("records the capturing device on each prompt and never invents one", () => {
    const location = fixture();
    configureWhatISaidCapture({
      ...location,
      enabled: true,
      retention: 90,
      analysisAllowed: false,
      now: "2026-08-30T10:00:00.000Z",
    });

    prompt(location, {
      sourceEventIdentity: "1",
      deviceId: "  9f1c-mac  ",
      deviceName: "  cs-work MacBookPro  ",
      promptOrigin: "agentstoz",
    });
    // 기기를 모르는 경우(포털 설정 전)에도 프롬프트는 그대로 저장돼야 한다 —
    // 부가 정보 하나 때문에 기록을 잃는 쪽이 훨씬 나쁘다.
    prompt(location, { sourceEventIdentity: "2", text: "두 번째 프롬프트" });
    // 빈 문자열은 "이름 없는 기기"가 아니라 모른다는 뜻이다.
    prompt(location, { sourceEventIdentity: "3", text: "세 번째", deviceId: "   ", deviceName: "" });

    const listed = listWhatISaidEntries({ ...location, key: KEY, now: "2026-08-30T10:05:00Z" });
    expect(listed.items.map(item => [item.deviceId, item.deviceName])).toEqual([
      ["9f1c-mac", "cs-work MacBookPro"],
      [null, null],
      [null, null],
    ]);
    expect(listed.items.map(item => item.promptOrigin)).toEqual(["agentstoz", "unknown", "unknown"]);
    const recent = listRecentWhatISaidEntries({ ...location, key: KEY, now: "2026-08-30T10:05:00Z" });
    expect(recent.items.at(-1)?.deviceName).toBe("cs-work MacBookPro");
  });

  test("is OFF by default, enables from now, and keeps analysis consent separate", () => {
    const location = fixture();
    const initial = readWhatISaidStatus({ ...location, now: "2026-08-30T10:00:00Z" });
    expect(initial).toMatchObject({
      enabled: false,
      enabledAt: null,
      lastScanAt: null,
      lastCaptureAt: null,
      retention: 90,
      analysisAllowed: false,
      counts: { active: 0, softDeleted: 0, purgedReceipts: 0 },
      feed: { enabled: false },
    });
    expect(prompt(location)).toMatchObject({ stored: false, reason: "disabled" });

    const enabled = enableWhatISaidCapture({
      ...location,
      retention: 30,
      now: "2026-08-30T10:00:00Z",
    });
    expect(enabled.enabledAt).toBe("2026-08-30T10:00:00.000Z");
    expect(enabled.lastScanAt).toBe(enabled.enabledAt);
    expect(enabled.lastCaptureAt).toBeNull();
    expect(enabled.analysisAllowed).toBe(false);
    expect(prompt(location, {
      sourceEventIdentity: "old",
      recordedAt: "2026-08-30T09:59:59Z",
    })).toMatchObject({ stored: false, reason: "before-enabled" });

    expect(setWhatISaidAnalysisAllowed({
      ...location,
      allowed: true,
      now: "2026-08-30T10:03:00Z",
    }).analysisAllowed).toBe(true);
    expect(disableWhatISaidCapture({ ...location, now: "2026-08-30T10:04:00Z" }).analysisAllowed).toBe(true);
  });

  test("encrypts exact text and enforces source-event HMAC idempotency", () => {
    const location = fixture();
    enableWhatISaidCapture({ ...location, retention: "forever", now: "2026-08-30T10:00:00Z" });
    const exact = "같은 말도 다른 이벤트면 보존합니다 🔐\nsecond line";
    const first = prompt(location, { text: exact });
    expect(first).toMatchObject({ stored: true, duplicate: false });
    if (!first.stored) throw new Error("expected stored fixture");
    expect(typeof first.seq).toBe("string");
    expect(first.id).toMatch(/^wis_[0-9a-f]{64}$/);

    expect(prompt(location, { text: exact })).toEqual({ ...first, duplicate: true });
    let conflict: unknown;
    try {
      prompt(location, { text: "different-sensitive-body" });
    } catch (error) {
      conflict = error;
    }
    expect(conflict).toBeInstanceOf(WhatISaidStoreError);
    expect((conflict as WhatISaidStoreError).code).toBe("WHAT_I_SAID_SOURCE_EVENT_CONFLICT");
    expect((conflict as Error).message).not.toContain("different-sensitive-body");

    const repeated = prompt(location, { text: exact, sourceEventIdentity: "2" });
    expect(repeated).toMatchObject({ stored: true, duplicate: false });
    const listed = listWhatISaidEntries({ ...location, key: KEY, now: "2026-08-30T10:05:00Z" });
    expect(listed.items.map(item => item.text)).toEqual([exact, exact]);
    expect(listed.items.every(item => typeof item.seq === "string")).toBe(true);

    const recent = listRecentWhatISaidEntries({
      ...location,
      key: KEY,
      limit: 1,
      now: "2026-08-30T10:05:00Z",
    });
    expect(recent.items[0]?.id).toBe(repeated.stored ? repeated.id : "");
    expect(typeof recent.nextBeforeSeq).toBe("string");
    const older = listRecentWhatISaidEntries({
      ...location,
      key: KEY,
      beforeSeq: recent.nextBeforeSeq,
      limit: 10,
      now: "2026-08-30T10:05:00Z",
    });
    expect(older.items.map(item => item.id)).toEqual([first.id]);

    const bytes = readFileSync(whatISaidDatabasePath(location));
    expect(bytes.includes(Buffer.from(exact, "utf8"))).toBe(false);
    expect(bytes.includes(Buffer.from(createHash("sha256").update(exact).digest("hex"), "utf8"))).toBe(false);
    let wrongKey: unknown;
    try {
      listWhatISaidEntries({ ...location, key: Buffer.alloc(32, 0x7f), now: "2026-08-30T10:05:00Z" });
    } catch (error) {
      wrongKey = error;
    }
    expect((wrongKey as WhatISaidStoreError).code).toBe("WHAT_I_SAID_KEY_INVALID");
    expect((wrongKey as Error).message).not.toContain(exact);
  });

  test("binds one key before the first insert and rejects a valid-looking replacement without mutation", () => {
    const location = fixture("memory-key-binding");
    enableWhatISaidCapture({ ...location, retention: "forever", now: "2026-08-30T10:00:00Z" });
    const stored = prompt(location, { sourceEventIdentity: "key-a" });
    expect(stored).toMatchObject({ stored: true, duplicate: false });

    const db = new Database(whatISaidDatabasePath(location), { readonly: true });
    const settings = db.query(`SELECT key_version, key_verifier FROM what_i_said_settings`).get() as any;
    expect(settings.key_version).toBe(1);
    expect(settings.key_verifier).toMatch(/^[0-9a-f]{64}$/);
    const before = Number((db.query(`SELECT count(*) AS count FROM what_i_said_events`).get() as any).count);
    db.close();

    const replacement = Buffer.alloc(32, 0x7f);
    expect(() => verifyWhatISaidStoreKey({ ...location, key: replacement }))
      .toThrow(expect.objectContaining({ code: "WHAT_I_SAID_KEY_INVALID" }));
    expect(() => captureWhatISaidPrompt({
      ...location,
      key: replacement,
      agent: "codex",
      sourceIdentity: "rollout-b.jsonl",
      sourceEventIdentity: "key-b",
      recordedAt: "2026-08-30T10:02:00Z",
      text: "must never be inserted",
      now: "2026-08-30T10:03:00Z",
    })).toThrow(expect.objectContaining({ code: "WHAT_I_SAID_KEY_INVALID" }));

    const restored = listWhatISaidEntries({ ...location, key: KEY, now: "2026-08-30T10:05:00Z" });
    expect(restored.items.map(item => item.text)).toEqual(["원문은 암호화되어야 합니다"]);
    const afterDb = new Database(whatISaidDatabasePath(location), { readonly: true });
    const after = Number((afterDb.query(`SELECT count(*) AS count FROM what_i_said_events`).get() as any).count);
    afterDb.close();
    expect(after).toBe(before);
  });

  test("migrates the pre-fingerprint schema and binds only after proving a key", () => {
    const location = fixture("memory-key-schema-migration");
    const path = whatISaidDatabasePath(location);
    const identityHash = createHash("sha256")
      .update(`what-i-said-memory-v1\0${location.memoryId}`, "utf8")
      .digest("hex");
    const db = new Database(path, { create: true });
    db.exec(`
      CREATE TABLE what_i_said_settings (
        singleton INTEGER PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        identity_hash TEXT NOT NULL,
        memory_id TEXT NOT NULL,
        capture_enabled INTEGER NOT NULL,
        capture_enabled_at TEXT,
        last_scan_at TEXT,
        last_capture_at TEXT,
        retention_policy TEXT NOT NULL,
        analysis_allowed INTEGER NOT NULL,
        feed_enabled INTEGER NOT NULL,
        feed_token_hash TEXT,
        feed_token_updated_at TEXT,
        index_epoch TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE what_i_said_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        source_agent TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        captured_at TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        nonce BLOB,
        ciphertext BLOB,
        auth_tag BLOB,
        retention_until TEXT,
        deleted_at TEXT,
        purged_at TEXT
      );
      PRAGMA user_version = 1;
    `);
    db.query(`
      INSERT INTO what_i_said_settings VALUES (
        1, 1, ?, ?, 0, NULL, NULL, NULL, '90', 0, 0, NULL, NULL, ?, ?
      )
    `).run(identityHash, location.memoryId, "legacy-index-epoch", "2026-08-30T00:00:00.000Z");
    db.close();

    expect(readWhatISaidStatus(location).enabled).toBe(false);
    verifyWhatISaidStoreKey({ ...location, key: KEY });
    const migrated = new Database(path, { readonly: true });
    expect((migrated.query(`PRAGMA user_version`).get() as any).user_version).toBe(6);
    // v5는 수집 기기를 행에 남긴다. 기존 행은 소급해 채우지 않는다 — 그 프롬프트가
    // 어느 기기에서 왔는지는 지나간 사실이고, 지금 기기를 박으면 추측이 기록이 된다.
    {
      const columns = (migrated.query(`PRAGMA table_info(what_i_said_events)`).all() as Array<{ name: string }>)
        .map(column => column.name);
      expect(columns).toContain('device_id');
      expect(columns).toContain('device_name');
      expect(columns).toContain('prompt_origin');
    }
    const row = migrated.query(`SELECT schema_version, key_version, key_verifier, feed_registration_id FROM what_i_said_settings`).get() as any;
    expect(row.schema_version).toBe(6);
    expect(row.key_version).toBe(1);
    expect(row.key_verifier).toMatch(/^[0-9a-f]{64}$/);
    expect(row.feed_registration_id).toBeNull();
    migrated.close();
  });

  test("revokes legacy v2 feed verifiers instead of carrying a forgeable key into v3", () => {
    const location = fixture("memory-feed-v2-migration");
    const path = whatISaidDatabasePath(location);
    const identityHash = createHash("sha256")
      .update(`what-i-said-memory-v1\0${location.memoryId}`, "utf8")
      .digest("hex");
    const token = "ab".repeat(32);
    const legacyVerifier = createHash("sha256").update(token, "utf8").digest("hex");
    const db = new Database(path, { create: true });
    db.exec(`
      CREATE TABLE what_i_said_settings (
        singleton INTEGER PRIMARY KEY, schema_version INTEGER NOT NULL,
        identity_hash TEXT NOT NULL, memory_id TEXT NOT NULL,
        key_version INTEGER NOT NULL, key_verifier TEXT,
        capture_enabled INTEGER NOT NULL, capture_enabled_at TEXT,
        last_scan_at TEXT, last_capture_at TEXT, retention_policy TEXT NOT NULL,
        analysis_allowed INTEGER NOT NULL, feed_enabled INTEGER NOT NULL,
        feed_token_hash TEXT, feed_token_updated_at TEXT,
        index_epoch TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE what_i_said_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE,
        source_agent TEXT NOT NULL, recorded_at TEXT NOT NULL, captured_at TEXT NOT NULL,
        content_hash TEXT NOT NULL, nonce BLOB, ciphertext BLOB, auth_tag BLOB,
        retention_until TEXT, deleted_at TEXT, purged_at TEXT
      );
      PRAGMA user_version = 2;
    `);
    db.query(`INSERT INTO what_i_said_settings VALUES (
      1, 2, ?, ?, 1, NULL, 0, NULL, NULL, NULL, '90', 0,
      1, ?, '2026-08-30T00:00:00.000Z', 'legacy-feed-epoch', '2026-08-30T00:00:00.000Z'
    )`).run(identityHash, location.memoryId, legacyVerifier);
    db.close();

    verifyWhatISaidStoreKey({ ...location, key: KEY });
    const migrated = new Database(path, { readonly: true });
    const row = migrated.query(`SELECT * FROM what_i_said_settings WHERE singleton = 1`).get() as any;
    expect((migrated.query(`PRAGMA user_version`).get() as any).user_version).toBe(6);
    // v5는 수집 기기를 행에 남긴다. 기존 행은 소급해 채우지 않는다 — 그 프롬프트가
    // 어느 기기에서 왔는지는 지나간 사실이고, 지금 기기를 박으면 추측이 기록이 된다.
    {
      const columns = (migrated.query(`PRAGMA table_info(what_i_said_events)`).all() as Array<{ name: string }>)
        .map(column => column.name);
      expect(columns).toContain('device_id');
      expect(columns).toContain('device_name');
    }
    expect(row.feed_enabled).toBe(0);
    expect(row.feed_token_hash).toBeNull();
    expect(row.feed_key_ciphertext).toBeNull();
    expect(row.feed_registration_id).toBeNull();
    migrated.close();
    const requestTarget = "/api/what-i-said/feed";
    expect(verifyWhatISaidFeedProof({
      ...location,
      key: KEY,
      expectedRegistrationId: "legacy-registration",
      authorization: createWhatISaidFeedAuthorization({
        token,
        challenge: "56".repeat(32),
        requestTarget,
      }),
      requestTarget,
    })).toBe(false);
  });

  test("rejects mixed legacy ciphertext before binding and never purges its last key evidence", () => {
    const keyB = Buffer.alloc(32, 0x42);
    const locationA = fixture("memory-mixed-key-lineage");
    const locationB = fixture("memory-mixed-key-lineage");
    for (const location of [locationA, locationB]) {
      configureWhatISaidCapture({
        ...location,
        enabled: true,
        retention: 30,
        analysisAllowed: false,
        now: "2025-12-31T00:00:00Z",
      });
    }
    const eventA = captureWhatISaidPrompt({
      ...locationA,
      key: KEY,
      agent: "codex",
      sourceIdentity: "key-a.jsonl",
      sourceEventIdentity: "a",
      recordedAt: "2026-01-01T00:00:00Z",
      text: "encrypted with key A",
      now: "2026-01-01T00:00:01Z",
    });
    captureWhatISaidPrompt({
      ...locationB,
      key: keyB,
      agent: "claude",
      sourceIdentity: "key-b.jsonl",
      sourceEventIdentity: "b",
      recordedAt: "2026-01-01T00:00:00Z",
      text: "encrypted with key B",
      now: "2026-01-01T00:00:01Z",
    });
    if (!eventA.stored) throw new Error("expected key-A fixture");

    const source = new Database(whatISaidDatabasePath(locationB), { readonly: true });
    const foreign = source.query(`
      SELECT event_id, source_agent, recorded_at, captured_at, content_hash,
             nonce, ciphertext, auth_tag, retention_until, deleted_at, purged_at
      FROM what_i_said_events LIMIT 1
    `).get() as any;
    source.close();
    const target = new Database(whatISaidDatabasePath(locationA), { readwrite: true });
    target.query(`
      INSERT INTO what_i_said_events (
        event_id, source_agent, recorded_at, captured_at, content_hash,
        nonce, ciphertext, auth_tag, retention_until, deleted_at, purged_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      foreign.event_id,
      foreign.source_agent,
      foreign.recorded_at,
      foreign.captured_at,
      foreign.content_hash,
      foreign.nonce,
      foreign.ciphertext,
      foreign.auth_tag,
      foreign.retention_until,
      foreign.deleted_at,
      foreign.purged_at,
    );
    target.query(`UPDATE what_i_said_settings SET key_verifier = NULL WHERE singleton = 1`).run();
    target.close();

    expect(() => verifyWhatISaidStoreKey({ ...locationA, key: KEY }))
      .toThrow(expect.objectContaining({ code: "WHAT_I_SAID_KEY_INVALID" }));
    expect(() => purgeWhatISaidEntries({
      ...locationA,
      ids: [eventA.id],
      now: "2026-02-02T00:00:00Z",
    })).toThrow(expect.objectContaining({ code: "WHAT_I_SAID_KEY_INVALID" }));
    expect(() => purgeExpiredWhatISaidEntries({
      ...locationA,
      now: "2026-02-02T00:00:00Z",
    })).toThrow(expect.objectContaining({ code: "WHAT_I_SAID_KEY_INVALID" }));
    expect(() => purgeAllWhatISaidEntries({
      ...locationA,
      now: "2026-02-02T00:00:00Z",
    })).toThrow(expect.objectContaining({ code: "WHAT_I_SAID_KEY_INVALID" }));
    expect(purgeExpiredWhatISaidDatabases({
      appDataDir: locationA.appDataDir,
      now: "2026-02-02T00:00:00Z",
    })).toEqual({ databases: 1, purged: 0, unavailable: 1 });

    const unchanged = new Database(whatISaidDatabasePath(locationA), { readonly: true });
    expect((unchanged.query(`SELECT key_verifier FROM what_i_said_settings`).get() as any).key_verifier).toBeNull();
    expect(Number((unchanged.query(`
      SELECT count(*) AS count FROM what_i_said_events
      WHERE purged_at IS NULL AND ciphertext IS NOT NULL
    `).get() as any).count)).toBe(2);
    unchanged.close();
  });

  test("applies changed retention to existing entries and purges ciphertext without resurrecting receipts", () => {
    for (const retention of [30, 90, 365, "forever"] as const satisfies readonly WhatISaidRetention[]) {
      const location = fixture(`memory-retention-${retention}`);
      enableWhatISaidCapture({ ...location, retention, now: "2026-01-01T00:00:00Z" });
      prompt(location, {
        sourceEventIdentity: String(retention),
        recordedAt: "2026-01-02T00:00:00Z",
        now: "2026-01-02T00:00:01Z",
      });
      const item = listWhatISaidEntries({ ...location, key: KEY, now: "2026-01-03T00:00:00Z" }).items[0]!;
      expect(item.retentionUntil).toBe(retention === "forever"
        ? null
        : new Date(Date.parse(item.recordedAt) + retention * 86_400_000).toISOString());
    }

    const changedRetention = fixture("memory-retention-change");
    enableWhatISaidCapture({ ...changedRetention, retention: "forever", now: "2026-01-01T00:00:00Z" });
    prompt(changedRetention, {
      sourceEventIdentity: "existing",
      recordedAt: "2026-01-02T00:00:00Z",
      now: "2026-01-02T00:00:01Z",
    });
    setWhatISaidRetention({ ...changedRetention, retention: 30, now: "2026-01-03T00:00:00Z" });
    expect(listWhatISaidEntries({ ...changedRetention, key: KEY, now: "2026-01-03T00:00:00Z" }).items[0]?.retentionUntil)
      .toBe("2026-02-01T00:00:00.000Z");
    expect(purgeExpiredWhatISaidDatabases({ appDataDir: changedRetention.appDataDir, now: "2026-02-02T00:00:00Z" }))
      .toMatchObject({ databases: 1, purged: 1, unavailable: 0 });

    const atomic = fixture("memory-atomic-config");
    expect(configureWhatISaidCapture({
      ...atomic,
      enabled: true,
      retention: "forever",
      analysisAllowed: true,
      now: "2026-08-30T10:00:00Z",
    })).toMatchObject({ enabled: true, retention: "forever", analysisAllowed: true });

    const location = fixture("memory-delete");
    enableWhatISaidCapture({ ...location, retention: "forever", now: "2026-08-30T10:00:00Z" });
    const stored = prompt(location);
    if (!stored.stored) throw new Error("expected stored fixture");
    expect(hasActiveWhatISaidEntry({ ...location, id: stored.id })).toBe(true);
    expect(hasActiveWhatISaidEntry({ ...location, id: `wis_${'f'.repeat(64)}` })).toBe(false);
    expect(softDeleteWhatISaidEntries({ ...location, ids: [stored.id], now: "2026-08-30T10:03:00Z" }))
      .toEqual({ softDeleted: 1 });
    expect(hasActiveWhatISaidEntry({ ...location, id: stored.id })).toBe(false);
    expect(listWhatISaidEntries({ ...location, key: KEY, now: "2026-08-30T10:04:00Z" }).items).toEqual([]);

    const path = whatISaidDatabasePath(location);
    let db = new Database(path, { readonly: true });
    expect((db.query("SELECT ciphertext IS NOT NULL AS present FROM what_i_said_events").get() as any).present).toBe(1);
    db.close();
    expect(purgeWhatISaidEntries({ ...location, ids: [stored.id], now: "2026-08-30T10:05:00Z" }))
      .toEqual({ purged: 1 });
    db = new Database(path, { readonly: true });
    expect((db.query("SELECT ciphertext IS NULL AS absent FROM what_i_said_events").get() as any).absent).toBe(1);
    db.close();
    expect(prompt(location)).toMatchObject({ stored: true, duplicate: true, id: stored.id });
    expect(readWhatISaidStatus({ ...location, now: "2026-08-30T10:06:00Z" }).counts.purgedReceipts).toBe(1);

    const deleteAll = fixture("memory-delete-all");
    enableWhatISaidCapture({ ...deleteAll, retention: "forever", now: "2026-08-30T10:00:00Z" });
    prompt(deleteAll, { sourceEventIdentity: "one" });
    prompt(deleteAll, { sourceEventIdentity: "two" });
    expect(softDeleteAllWhatISaidEntries(deleteAll, { now: "2026-08-30T10:07:00Z" }))
      .toEqual({ softDeleted: 2 });
    expect(purgeAllWhatISaidEntries({ ...deleteAll, now: "2026-08-30T10:07:01Z" }))
      .toEqual({ purged: 2 });
    expect(listWhatISaidEntries({ ...deleteAll, key: KEY, now: "2026-08-30T10:08:00Z" }).items).toEqual([]);

    const expiring = fixture("memory-expiry");
    enableWhatISaidCapture({ ...expiring, retention: 30, now: "2026-01-01T00:00:00Z" });
    prompt(expiring, { recordedAt: "2026-01-01T00:01:00Z", now: "2026-01-01T00:02:00Z" });
    expect(purgeExpiredWhatISaidEntries({ ...expiring, now: "2026-02-01T00:02:00Z" })).toEqual({ purged: 1 });
  });

  test("stores only an OS-key-encrypted feed key, redacts identifiers, and withholds secrets", () => {
    const location = fixture();
    enableWhatISaidCapture({ ...location, retention: "forever", now: "2026-08-30T10:00:00Z" });
    prompt(location, {
      sourceEventIdentity: "clean",
      text: "메일 a.person@example.com 전화 +82 10-1234-5678 파일 /Users/alice/private/note.md",
    });
    prompt(location, {
      sourceEventIdentity: "secret",
      text: `이 키는 공유 금지 ghp_${"A".repeat(30)}`,
    });

    const enabled = enableWhatISaidFeed({
      ...location,
      key: KEY,
      registrationId: "project-one",
      tokenBytes: Buffer.alloc(32, 0x11),
      now: "2026-08-30T10:03:00Z",
    });
    const requestTarget = "/api/what-i-said/feed";
    const authorization = createWhatISaidFeedAuthorization({
      token: enabled.token,
      challenge: "12".repeat(32),
      requestTarget,
    });
    expect(verifyWhatISaidFeedProof({ ...location, key: KEY, expectedRegistrationId: "project-one", authorization, requestTarget })).toBe(true);
    expect(verifyWhatISaidFeedProof({
      ...location,
      key: KEY,
      expectedRegistrationId: "project-one",
      authorization,
      requestTarget: `${requestTarget}?limit=1`,
    })).toBe(false);
    expect(verifyWhatISaidFeedProof({
      ...location,
      key: KEY,
      expectedRegistrationId: "project-one",
      authorization: `Bearer ${enabled.token}`,
      requestTarget,
    })).toBe(false);
    const databaseBytes = readFileSync(whatISaidDatabasePath(location));
    const derivedFeedKey = createHash("sha256").update(enabled.token, "utf8").digest();
    expect(databaseBytes.includes(Buffer.from(enabled.token))).toBe(false);
    expect(databaseBytes.includes(derivedFeedKey)).toBe(false);
    expect(databaseBytes.includes(Buffer.from(derivedFeedKey.toString("hex"), "utf8"))).toBe(false);
    const feedDb = new Database(whatISaidDatabasePath(location), { readonly: true });
    const feedSettings = feedDb.query(`
      SELECT feed_token_hash, feed_key_nonce, feed_key_ciphertext,
             feed_key_auth_tag, feed_registration_id
      FROM what_i_said_settings WHERE singleton = 1
    `).get() as any;
    feedDb.close();
    expect(feedSettings.feed_token_hash).toBe("encrypted-v3");
    expect(feedSettings.feed_key_nonce).toBeInstanceOf(Uint8Array);
    expect(feedSettings.feed_key_ciphertext).toBeInstanceOf(Uint8Array);
    expect(feedSettings.feed_key_auth_tag).toBeInstanceOf(Uint8Array);
    expect(feedSettings.feed_registration_id).toBe("project-one");
    expect(() => verifyWhatISaidFeedProof({
      ...location,
      key: Buffer.alloc(32, 0x7f),
      expectedRegistrationId: "project-one",
      authorization,
      requestTarget,
    })).toThrow(expect.objectContaining({ code: "WHAT_I_SAID_KEY_INVALID" }));

    const page = readWhatISaidFeed({
      ...location,
      key: KEY,
      expectedRegistrationId: "project-one",
      authorization,
      requestTarget,
      now: "2026-08-30T10:04:00Z",
    });
    expect(page.items).toHaveLength(1);
    expect(page.scan.withheld).toBe(1);
    expect(page.items[0]?.text).not.toContain("a.person@example.com");
    expect(page.items[0]?.text).not.toContain("10-1234-5678");
    expect(page.items[0]?.text).not.toContain("/Users/alice");
    expect(page.items[0]?.redaction.state).toBe("redacted");
    expect(page.nextCursor).toContain(".");
    expect(page.nextCursor).not.toMatch(/^\d+$/);
    const responseBody = JSON.stringify(page);
    const responseProof = createWhatISaidFeedResponseProof({
      ...location,
      key: KEY,
      expectedRegistrationId: "project-one",
      authorization,
      requestTarget,
      responseBody,
    });
    expect(verifyWhatISaidFeedResponseProof({
      token: enabled.token,
      authorization,
      requestTarget,
      responseBody,
      responseProof,
    })).toBe(true);
    expect(verifyWhatISaidFeedResponseProof({
      token: enabled.token,
      authorization,
      requestTarget,
      responseBody: `${responseBody} `,
      responseProof,
    })).toBe(false);
    expect(verifyWhatISaidFeedResponseProof({
      token: enabled.token,
      authorization,
      requestTarget,
      responseBody,
      responseProof: null,
    })).toBe(false);

    const rotated = rotateWhatISaidFeedToken({
      ...location,
      key: KEY,
      tokenBytes: Buffer.alloc(32, 0x22),
      now: "2026-08-30T10:05:00Z",
    });
    expect(verifyWhatISaidFeedProof({ ...location, key: KEY, expectedRegistrationId: "project-one", authorization, requestTarget })).toBe(false);
    const rotatedAuthorization = createWhatISaidFeedAuthorization({
      token: rotated.token,
      challenge: "23".repeat(32),
      requestTarget,
    });
    expect(verifyWhatISaidFeedProof({ ...location, key: KEY, expectedRegistrationId: "project-one", authorization: rotatedAuthorization, requestTarget })).toBe(true);
    resetWhatISaidFeedEpoch({ ...location, now: "2026-08-30T10:06:00Z" });
    const cursorTarget = `${requestTarget}?after=${encodeURIComponent(page.nextCursor)}`;
    expect(() => readWhatISaidFeed({
      ...location,
      key: KEY,
      expectedRegistrationId: "project-one",
      authorization: createWhatISaidFeedAuthorization({
        token: rotated.token,
        challenge: "34".repeat(32),
        requestTarget: cursorTarget,
      }),
      requestTarget: cursorTarget,
      cursor: page.nextCursor,
      now: "2026-08-30T10:07:00Z",
    })).toThrow(expect.objectContaining({ code: "WHAT_I_SAID_CURSOR_STALE" }));

    expect(revokeWhatISaidFeed({ ...location, now: "2026-08-30T10:08:00Z" }).enabled).toBe(false);
    expect(() => readWhatISaidFeed({
      ...location,
      key: KEY,
      expectedRegistrationId: "project-one",
      authorization: rotatedAuthorization,
      requestTarget,
      now: "2026-08-30T10:09:00Z",
    })).toThrow(expect.objectContaining({ code: "WHAT_I_SAID_FEED_DISABLED" }));
  });

  test("permanently revokes a feed when the current registration identity changes", () => {
    const location = fixture("memory-registration-rebind");
    const enabled = enableWhatISaidFeed({
      ...location,
      key: KEY,
      registrationId: "registration-a",
      tokenBytes: Buffer.alloc(32, 0x31),
      now: "2026-08-30T11:00:00Z",
    });
    const requestTarget = "/api/what-i-said/feed";
    const authorization = createWhatISaidFeedAuthorization({
      token: enabled.token,
      challenge: "45".repeat(32),
      requestTarget,
    });
    expect(verifyWhatISaidFeedProof({
      ...location,
      key: KEY,
      expectedRegistrationId: "registration-b",
      authorization,
      requestTarget,
    })).toBe(false);
    expect(readWhatISaidStatus(location).feed.enabled).toBe(false);
    expect(verifyWhatISaidFeedProof({
      ...location,
      key: KEY,
      expectedRegistrationId: "registration-a",
      authorization,
      requestTarget,
    })).toBe(false);
  });

  test("explicitly rebinds an enabled feed to a surviving registration without rotating its secret", () => {
    const location = fixture("memory-registration-survivor");
    const enabled = enableWhatISaidFeed({
      ...location,
      key: KEY,
      registrationId: "registration-a",
      tokenBytes: Buffer.alloc(32, 0x32),
      now: "2026-08-30T11:00:00Z",
    });
    expect(rebindWhatISaidFeedRegistration({
      ...location,
      key: KEY,
      registrationId: "registration-b",
      now: "2026-08-30T11:01:00Z",
    }).enabled).toBe(true);

    const requestTarget = "/api/what-i-said/feed";
    const authorization = createWhatISaidFeedAuthorization({
      token: enabled.token,
      challenge: "46".repeat(32),
      requestTarget,
    });
    expect(verifyWhatISaidFeedProof({
      ...location,
      key: KEY,
      expectedRegistrationId: "registration-b",
      authorization,
      requestTarget,
    })).toBe(true);

    const database = new Database(whatISaidDatabasePath(location), { readonly: true });
    try {
      expect(database.query(`
        SELECT feed_registration_id FROM what_i_said_settings WHERE singleton = 1
      `).get()).toEqual({ feed_registration_id: "registration-b" });
    } finally {
      database.close();
    }
  });

  test("advances scan checkpoints monotonically and keeps five-minute replay authority", () => {
    const location = fixture();
    enableWhatISaidCapture({ ...location, now: "2026-08-30T10:00:00Z" });
    const advanced = advanceWhatISaidScan({ ...location, scannedThrough: "2026-08-30T10:10:00Z" });
    expect(advanced.lastScanAt).toBe("2026-08-30T10:10:00.000Z");
    expect(advanced.lastCaptureAt).toBe("2026-08-30T10:10:00.000Z");
    expect(advanceWhatISaidScan({ ...location, scannedThrough: "2026-08-30T10:05:00Z" }).lastScanAt)
      .toBe("2026-08-30T10:10:00.000Z");
  });

  test("reports capture freshness read-only, and never invents a store to answer it", () => {
    const location = fixture("memory-capture-freshness");
    // 아직 저장소가 없다 = 정말로 한 번도 수집한 적이 없다. 이것은 아는 사실이므로
    // readable 이고, 조회했다는 이유만으로 저장소가 생겨서는 안 된다.
    expect(probeWhatISaidLastCaptureReadOnly(location)).toEqual({ readable: true, lastCaptureAt: null });
    expect(existsSync(whatISaidDatabasePath(location))).toBe(false);

    // 저장소는 있는데 아직 스캔이 없었다 = 「아직 수집 전」. 위와 화면이 갈려야 한다.
    enableWhatISaidCapture({ ...location, now: "2026-08-30T10:00:00Z" });
    expect(probeWhatISaidLastCaptureReadOnly(location)).toEqual({ readable: true, lastCaptureAt: null });

    advanceWhatISaidScan({ ...location, scannedThrough: "2026-08-30T10:10:00Z" });
    expect(probeWhatISaidLastCaptureReadOnly(location))
      .toEqual({ readable: true, lastCaptureAt: "2026-08-30T10:10:00.000Z" });

    // 읽을 수 없는 저장소를 「수집한 적 없음」으로 강등하면, 화면이 멀쩡한 기기에
    // 대해 거짓말을 하게 된다. 그때는 readable=false 로 아무 주장도 하지 않는다.
    writeFileSync(whatISaidDatabasePath(location), "not a database");
    expect(probeWhatISaidLastCaptureReadOnly(location)).toEqual({ readable: false, lastCaptureAt: null });
  });

  test("persists keyed transcript and discovery cursors without raw paths and rejects stale CAS", () => {
    const location = fixture("memory-cursor-v4");
    enableWhatISaidCapture({ ...location, now: "2026-08-30T10:00:00Z" });
    const sourceIdentity = "/Users/private/.codex/sessions/secret-rollout.jsonl";
    const sourceId = deriveWhatISaidTranscriptSourceId({
      ...location,
      key: KEY,
      agent: "codex",
      sourceIdentity,
    });
    const first = commitWhatISaidTranscriptCursor({
      ...location,
      key: KEY,
      agent: "codex",
      sourceIdentity,
      expected: null,
      next: {
        generation: 0,
        fileIdentity: "1:2:3",
        byteOffset: 4,
        lineNumber: 1,
        anchor: Buffer.from("abc\n"),
      },
      now: "2026-08-30T10:01:00Z",
    });
    expect(first.committed).toBe(true);
    expect(first.cursor.sourceId).toBe(sourceId);
    expect(verifyWhatISaidTranscriptCursorAnchor({
      ...location,
      key: KEY,
      cursor: first.cursor,
      anchor: Buffer.from("abc\n"),
    })).toBe(true);
    expect(verifyWhatISaidTranscriptCursorAnchor({
      ...location,
      key: KEY,
      cursor: first.cursor,
      anchor: Buffer.from("abd\n"),
    })).toBe(false);
    expect(commitWhatISaidTranscriptCursor({
      ...location,
      key: KEY,
      agent: "codex",
      sourceIdentity,
      expected: null,
      next: {
        generation: 0,
        fileIdentity: "1:2:3",
        byteOffset: 4,
        lineNumber: 1,
        anchor: Buffer.from("abc\n"),
      },
    }).committed).toBe(false);
    expect(readWhatISaidTranscriptCursor({ ...location, key: KEY, agent: "codex", sourceIdentity }))
      .toEqual(first.cursor);

    expect(readWhatISaidDiscoveryCursor({ ...location, key: KEY, scope: "codex" })).toBeNull();
    expect(commitWhatISaidDiscoveryCursor({
      ...location, key: KEY, scope: "codex", expected: null, next: sourceId,
    })).toEqual({ committed: true, cursor: sourceId });
    expect(commitWhatISaidDiscoveryCursor({
      ...location, key: KEY, scope: "codex", expected: null, next: sourceId,
    }).committed).toBe(false);
    expect(readWhatISaidDiscoveryCursor({ ...location, key: KEY, scope: "codex" })).toBe(sourceId);

    const databaseBytes = readFileSync(whatISaidDatabasePath(location));
    expect(databaseBytes.includes(Buffer.from(sourceIdentity, "utf8"))).toBe(false);
  });

  test("persists bounded transcript ownership classifications without raw transcript paths", () => {
    const location = fixture("memory-classification-cache");
    enableWhatISaidCapture({ ...location, now: "2026-08-30T10:00:00Z" });
    const rawPath = "/Users/private/.codex/sessions/secret-rollout.jsonl";
    const sourceId = deriveWhatISaidTranscriptSourceId({
      ...location,
      key: KEY,
      agent: "codex",
      sourceIdentity: rawPath,
    });
    commitWhatISaidTranscriptClassifications({
      ...location,
      key: KEY,
      items: [{ sourceId, fileIdentity: "1048576:73:9001", classifiedSize: 4096, owned: true }],
      now: "2026-08-30T10:02:00Z",
    });
    expect(readWhatISaidTranscriptClassifications({ ...location, key: KEY })).toEqual({
      [sourceId]: { sourceId, fileIdentity: "1048576:73:9001", classifiedSize: 4096, owned: true },
    });
    expect(readWhatISaidTranscriptClassifications({ ...location, key: KEY, sourceIds: [] })).toEqual({});
    expect(readWhatISaidTranscriptClassifications({ ...location, key: KEY, sourceIds: [sourceId] }))
      .toEqual(readWhatISaidTranscriptClassifications({ ...location, key: KEY }));
    const missingSource = deriveWhatISaidTranscriptSourceId({
      ...location, key: KEY, agent: "codex", sourceIdentity: "/synthetic/missing.jsonl",
    });
    expect(readWhatISaidTranscriptClassifications({ ...location, key: KEY, sourceIds: [missingSource] })).toEqual({});
    expect(() => readWhatISaidTranscriptClassifications({ ...location, key: KEY, sourceIds: ["invalid"] }))
      .toThrow();
    expect(() => readWhatISaidTranscriptClassifications({ ...location, key: KEY, sourceIds: Array(257).fill(sourceId) }))
      .toThrow();
    expect(readFileSync(whatISaidDatabasePath(location)).includes(Buffer.from(rawPath, "utf8"))).toBe(false);
  });

  test("stores a content-free durable receipt for an over-limit transcript record", () => {
    const location = fixture("memory-withheld-record");
    enableWhatISaidCapture({ ...location, now: "2026-08-30T10:00:00Z" });
    const receipt = captureWhatISaidWithheldTranscriptRecord({
      ...location,
      key: KEY,
      agent: "codex",
      sourceIdentity: "keyed-source",
      sourceEventIdentity: "1",
      recordBytes: 5 * 1024 * 1024,
      reason: "record-too-large",
      now: "2026-08-30T10:01:00Z",
    });
    expect(receipt).toMatchObject({ stored: true, duplicate: false });
    expect(captureWhatISaidWithheldTranscriptRecord({
      ...location,
      key: KEY,
      agent: "codex",
      sourceIdentity: "keyed-source",
      sourceEventIdentity: "1",
      recordBytes: 5 * 1024 * 1024,
      reason: "record-too-large",
      now: "2026-08-30T10:02:00Z",
    })).toMatchObject({ stored: true, duplicate: true });
    const db = new Database(whatISaidDatabasePath(location), { readonly: true });
    const row = db.query(`SELECT nonce, ciphertext, auth_tag, withheld_reason FROM what_i_said_events`).get() as any;
    expect(row).toEqual({ nonce: null, ciphertext: null, auth_tag: null, withheld_reason: "record-too-large" });
    db.close();
    expect(readWhatISaidStatus(location).counts.withheld).toBe(1);
  });

  test("a purged prompt cannot revive under a rotated transcript generation", () => {
    const location = fixture("memory-purge-generation");
    enableWhatISaidCapture({ ...location, now: "2026-08-30T10:00:00Z" });
    const first = captureWhatISaidPrompt({
      ...location,
      key: KEY,
      agent: "codex",
      sourceIdentity: "rollout:g0",
      sourceEventIdentity: "2",
      replayIdentity: "stable-rollout:2",
      recordedAt: "2026-08-30T10:01:00Z",
      text: "삭제 후 다시 살아나면 안 됨",
      now: "2026-08-30T10:02:00Z",
    });
    expect(first.stored).toBe(true);
    purgeWhatISaidEntries({ ...location, ids: [first.id], now: "2026-08-30T10:03:00Z" });
    const replay = captureWhatISaidPrompt({
      ...location,
      key: KEY,
      agent: "codex",
      sourceIdentity: "rollout:g1",
      sourceEventIdentity: "2",
      replayIdentity: "stable-rollout:2",
      recordedAt: "2026-08-30T10:01:00Z",
      text: "삭제 후 다시 살아나면 안 됨",
      now: "2026-08-30T10:04:00Z",
    });
    expect(replay).toMatchObject({ stored: true, duplicate: true, id: first.id });
    expect(listWhatISaidEntries({ ...location, key: KEY, now: "2026-08-30T10:05:00Z" }).items)
      .toEqual([]);
  });

  test("fails closed when pathless revocation sees a hash-named unsafe database entry", () => {
    if (process.platform === "win32") return;
    const location = fixture("memory-unsafe-revocation");
    readWhatISaidStatus(location);
    const directory = join(location.appDataDir, "what-i-said");
    const victim = join(location.appDataDir, "outside.sqlite");
    writeFileSync(victim, "not-a-database");
    symlinkSync(victim, join(directory, `${"f".repeat(64)}.sqlite`));
    expect(() => revokeWhatISaidFeedByRegistrationId({
      appDataDir: location.appDataDir,
      registrationId: "removed-project",
    })).toThrow(expect.objectContaining({ code: "WHAT_I_SAID_FEED_REGISTRATION_AMBIGUOUS" }));
  });

  test("retention sweep refuses an unsafe SQLite sidecar before its read-write open", () => {
    if (process.platform === "win32") return;
    const location = fixture("memory-unsafe-retention-sidecar");
    readWhatISaidStatus(location);
    const databasePath = whatISaidDatabasePath(location);
    const victim = join(location.appDataDir, "outside-wal");
    writeFileSync(victim, "do-not-touch");
    symlinkSync(victim, `${databasePath}-wal`);
    expect(purgeExpiredWhatISaidDatabases({
      appDataDir: location.appDataDir,
      now: "2026-08-30T10:10:00Z",
    })).toMatchObject({ databases: 1, purged: 0, unavailable: 1 });
    expect(readFileSync(victim, "utf8")).toBe("do-not-touch");
  });

  test("uses memory lineage across folder moves and enforces private real storage paths", () => {
    const location = fixture("stable-memory-id");
    const before = whatISaidDatabasePath(location);
    readWhatISaidStatus(location);
    if (process.platform !== "win32") {
      expect(statSync(before).mode & 0o777).toBe(0o600);
      expect(statSync(join(before, "..")).mode & 0o777).toBe(0o700);
    }
    const movedRoot = join(join(location.projectRoot, ".."), "renamed-project");
    renameSync(location.projectRoot, movedRoot);
    const moved = { ...location, projectRoot: movedRoot };
    expect(whatISaidDatabasePath(moved)).toBe(before);
    expect(readWhatISaidStatus(moved).enabled).toBe(false);

    const symlinkFixture = fixture("symlink-memory");
    const outside = join(join(symlinkFixture.appDataDir, ".."), "outside-store");
    mkdirSync(outside);
    symlinkSync(outside, join(symlinkFixture.appDataDir, "what-i-said"));
    expect(() => readWhatISaidStatus(symlinkFixture))
      .toThrow(expect.objectContaining({ code: "WHAT_I_SAID_PATH_UNSAFE" }));

    const dbFixture = fixture("db-link-memory");
    const databasePath = whatISaidDatabasePath(dbFixture);
    const victim = join(join(dbFixture.appDataDir, ".."), "victim.sqlite");
    writeFileSync(victim, "do-not-touch");
    symlinkSync(victim, databasePath);
    expect(() => readWhatISaidStatus(dbFixture))
      .toThrow(expect.objectContaining({ code: "WHAT_I_SAID_PATH_UNSAFE" }));
    expect(readFileSync(victim, "utf8")).toBe("do-not-touch");

    const rootFixture = fixture("root-link-memory");
    const rootAlias = join(join(rootFixture.projectRoot, ".."), "project-alias");
    symlinkSync(rootFixture.projectRoot, rootAlias);
    expect(() => readWhatISaidStatus({ ...rootFixture, projectRoot: rootAlias }))
      .toThrow(expect.objectContaining({ code: "WHAT_I_SAID_PATH_UNSAFE" }));
  });
});
