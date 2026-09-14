import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import {
  createProductionPromptGuideKeyProvider, type PromptGuideKeyProvider,
} from "./promptGuideKeyProvider";
import {
  nextMissionState, normalizeMissionCreate, normalizeMissionEvent,
  type OrchestrationMission, type OrchestrationMissionEvent,
} from "./orchestrationMissionModel";

export const ORCHESTRATION_MISSION_KEYCHAIN_SERVICE = "com.portmanager.portmanager.orchestration-missions.v1";
export const ORCHESTRATION_MISSION_KEYCHAIN_ACCOUNT = "orchestration-missions-v1";
export const ORCHESTRATION_MISSION_DPAPI_FILE = "orchestration-missions.v1.key.dpapi";
const DATABASE_FILE = "orchestration-missions.v1.sqlite";

export class OrchestrationMissionStoreError extends Error {
  constructor(readonly code: string) { super(code); this.name = "OrchestrationMissionStoreError"; }
}
function fail(code: string): never { throw new OrchestrationMissionStoreError(code); }

function directory(appDataDir: string): string {
  if (!isAbsolute(appDataDir) || appDataDir.includes("\0")) fail("MISSION_PATH_UNSAFE");
  const path = resolve(appDataDir);
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o700 });
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink()) fail("MISSION_PATH_UNSAFE");
  return realpathSync(path);
}
function aad(id: string): Buffer { return Buffer.from(`agentstoz-orchestration-mission-v1\0${id}`, "utf8"); }
function encrypt(key: Buffer, id: string, value: unknown): { nonce: Buffer; ciphertext: Buffer; tag: Buffer } {
  const plain = Buffer.from(JSON.stringify(value), "utf8");
  try {
    const nonce = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", key, nonce); cipher.setAAD(aad(id));
    return { nonce, ciphertext: Buffer.concat([cipher.update(plain), cipher.final()]), tag: cipher.getAuthTag() };
  } finally { plain.fill(0); }
}
function decrypt<T>(key: Buffer, id: string, nonce: Buffer, ciphertext: Buffer, tag: Buffer): T {
  let plain: Buffer | undefined;
  try {
    const cipher = createDecipheriv("aes-256-gcm", key, nonce); cipher.setAAD(aad(id)); cipher.setAuthTag(tag);
    plain = Buffer.concat([cipher.update(ciphertext), cipher.final()]);
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plain)) as T;
  } catch { return fail("MISSION_DECRYPT_FAILED"); }
  finally { plain?.fill(0); }
}

type MissionRow = { id: string; state: string; created_at: string; updated_at: string; nonce: Uint8Array; ciphertext: Uint8Array; tag: Uint8Array };
type EventRow = { id: string; mission_id: string; request_id: string; occurred_at: string; nonce: Uint8Array; ciphertext: Uint8Array; tag: Uint8Array };
export interface OrchestrationMissionEventPage {
  events: OrchestrationMissionEvent[];
  nextEventId: string | null;
  hasMore: boolean;
}

export class OrchestrationMissionStore {
  readonly #keys: PromptGuideKeyProvider;
  readonly #databasePath: string;
  constructor(input: { appDataDir: string; keyProvider?: PromptGuideKeyProvider }) {
    const root = directory(input.appDataDir);
    this.#databasePath = join(root, DATABASE_FILE);
    this.#keys = input.keyProvider ?? createProductionPromptGuideKeyProvider({ appDataDir: root, namespace: {
      keychainService: ORCHESTRATION_MISSION_KEYCHAIN_SERVICE,
      keychainAccount: ORCHESTRATION_MISSION_KEYCHAIN_ACCOUNT,
      dpapiFile: ORCHESTRATION_MISSION_DPAPI_FILE,
      dpapiEntropy: "agentstoz-orchestration-missions-key-v1",
    } });
  }
  #open(): Database {
    if (existsSync(this.#databasePath)) {
      const info = lstatSync(this.#databasePath);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) fail("MISSION_PATH_UNSAFE");
    }
    const db = new Database(this.#databasePath, { create: true, strict: true });
    if (process.platform !== "win32") chmodSync(this.#databasePath, 0o600);
    db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;");
    db.exec(`CREATE TABLE IF NOT EXISTS metadata(schema_version INTEGER NOT NULL, key_verifier TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS missions(id TEXT PRIMARY KEY, state TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, nonce BLOB NOT NULL, ciphertext BLOB NOT NULL, tag BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY, mission_id TEXT NOT NULL REFERENCES missions(id), request_id TEXT NOT NULL UNIQUE, occurred_at TEXT NOT NULL, nonce BLOB NOT NULL, ciphertext BLOB NOT NULL, tag BLOB NOT NULL);
      CREATE INDEX IF NOT EXISTS mission_events_order ON events(mission_id, occurred_at, id);`);
    return db;
  }
  async #key(db: Database): Promise<Buffer> {
    const metadata = db.query("SELECT schema_version, key_verifier FROM metadata LIMIT 2").all() as { schema_version: number; key_verifier: string }[];
    if (metadata.length > 1) fail("MISSION_METADATA_INVALID");
    const meta = metadata[0] ?? null;
    if (!meta && (db.query("SELECT 1 FROM missions LIMIT 1").get() || db.query("SELECT 1 FROM events LIMIT 1").get())) fail("MISSION_METADATA_INVALID");
    if (meta && meta.schema_version > 1) fail("MISSION_SCHEMA_UNSUPPORTED");
    let key = await this.#keys.read();
    if (!key && meta) fail("MISSION_KEY_MISSING");
    if (!key) key = await this.#keys.create();
    if (!Buffer.isBuffer(key) || key.length !== 32) fail("MISSION_KEY_INVALID");
    const verifier = createHash("sha256").update("agentstoz-orchestration-mission-key-v1\0").update(key).digest("hex");
    if (meta && meta.key_verifier !== verifier) { key.fill(0); fail("MISSION_KEY_INVALID"); }
    if (!meta) db.query("INSERT INTO metadata(schema_version,key_verifier) VALUES(1,?)").run(verifier);
    return key;
  }
  async create(value: unknown): Promise<OrchestrationMission> {
    const input = normalizeMissionCreate(value); const db = this.#open(); let key: Buffer | undefined;
    try {
      key = await this.#key(db);
      const prior = db.query("SELECT * FROM events WHERE request_id=?").get(input.requestId) as EventRow | null;
      if (prior) {
        const payload = decrypt<Pick<OrchestrationMissionEvent, "kind">>(key, prior.id, Buffer.from(prior.nonce), Buffer.from(prior.ciphertext), Buffer.from(prior.tag));
        if (payload.kind !== "mission-created") fail("MISSION_REQUEST_CONFLICT");
        const mission = await this.read(prior.mission_id);
        if (mission.title !== input.title || mission.goal !== input.goal) fail("MISSION_REQUEST_CONFLICT");
        return mission;
      }
      const now = new Date().toISOString(); const mission: OrchestrationMission = { id: `mission_${randomUUID()}`, title: input.title, goal: input.goal, state: "active", createdAt: now, updatedAt: now, checkpoint: null };
      const body = encrypt(key, mission.id, { title: mission.title, goal: mission.goal, checkpoint: mission.checkpoint });
      const eventId = `event_${randomUUID()}`; const event = encrypt(key, eventId, { kind: "mission-created", projectIds: [], summary: "Mission created", whatISaidEventId: null });
      db.transaction(() => {
        db.query("INSERT INTO missions VALUES(?,?,?,?,?,?,?)").run(mission.id, mission.state, now, now, body.nonce, body.ciphertext, body.tag);
        db.query("INSERT INTO events VALUES(?,?,?,?,?,?,?)").run(eventId, mission.id, input.requestId, now, event.nonce, event.ciphertext, event.tag);
      })();
      return mission;
    } finally { key?.fill(0); db.close(); }
  }
  async read(missionId: string): Promise<OrchestrationMission> {
    if (!existsSync(this.#databasePath)) fail("MISSION_NOT_FOUND");
    const db = this.#open(); let key: Buffer | undefined;
    try {
      key = await this.#key(db); const row = db.query("SELECT * FROM missions WHERE id=?").get(missionId) as MissionRow | null;
      if (!row) fail("MISSION_NOT_FOUND");
      const body = decrypt<{ title: string; goal: string; checkpoint: string | null }>(key, row.id, Buffer.from(row.nonce), Buffer.from(row.ciphertext), Buffer.from(row.tag));
      return { id: row.id, state: row.state as OrchestrationMission["state"], createdAt: row.created_at, updatedAt: row.updated_at, ...body };
    } finally { key?.fill(0); db.close(); }
  }
  async list(limit = 20): Promise<OrchestrationMission[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail("MISSION_INPUT_INVALID");
    if (!existsSync(this.#databasePath)) return [];
    const db = this.#open(); let key: Buffer | undefined;
    try {
      key = await this.#key(db);
      const rows = db.query("SELECT * FROM missions ORDER BY updated_at DESC, id DESC LIMIT ?").all(limit) as MissionRow[];
      return rows.map(row => {
        const body = decrypt<{ title: string; goal: string; checkpoint: string | null }>(key!, row.id, Buffer.from(row.nonce), Buffer.from(row.ciphertext), Buffer.from(row.tag));
        return { id: row.id, state: row.state as OrchestrationMission["state"], createdAt: row.created_at, updatedAt: row.updated_at, ...body };
      });
    } finally { key?.fill(0); db.close(); }
  }
  async interruptActiveMissions(): Promise<string[]> {
    if (!existsSync(this.#databasePath)) return [];
    const db = this.#open(); let key: Buffer | undefined;
    try {
      const rows = db.query("SELECT id FROM missions WHERE state='active' ORDER BY id").all() as { id: string }[];
      if (rows.length === 0) return [];
      key = await this.#key(db);
      const occurredAt = new Date().toISOString();
      db.transaction(() => {
        for (const row of rows) {
          const eventId = `event_${randomUUID()}`;
          const requestId = `runtime-restart-${randomUUID()}`;
          const payload = encrypt(key!, eventId, {
            kind: "mission-interrupted", projectIds: [],
            summary: "Runtime restarted; explicit resume required", whatISaidEventId: null,
          });
          db.query("INSERT INTO events VALUES(?,?,?,?,?,?,?)").run(eventId, row.id, requestId, occurredAt, payload.nonce, payload.ciphertext, payload.tag);
          db.query("UPDATE missions SET state=?,updated_at=? WHERE id=?").run(nextMissionState("active", "mission-interrupted"), occurredAt, row.id);
        }
      })();
      return rows.map(row => row.id);
    } finally { key?.fill(0); db.close(); }
  }
  async events(missionId: string, limit = 100): Promise<OrchestrationMissionEvent[]> {
    return (await this.eventPage(missionId, { limit })).events;
  }
  async eventPage(missionId: string, options: { limit?: number; afterEventId?: string | null } = {}): Promise<OrchestrationMissionEventPage> {
    const limit = options.limit ?? 100;
    const afterEventId = options.afterEventId ?? null;
    if (!/^mission_[0-9a-f-]{36}$/.test(missionId) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100
      || (afterEventId !== null && !/^event_[0-9a-f-]{36}$/.test(afterEventId))) fail("MISSION_INPUT_INVALID");
    if (!existsSync(this.#databasePath)) fail("MISSION_NOT_FOUND");
    const db = this.#open(); let key: Buffer | undefined;
    try {
      key = await this.#key(db);
      if (!db.query("SELECT 1 FROM missions WHERE id=?").get(missionId)) fail("MISSION_NOT_FOUND");
      const cursor = afterEventId
        ? db.query("SELECT occurred_at FROM events WHERE id=? AND mission_id=?").get(afterEventId, missionId) as { occurred_at: string } | null
        : null;
      if (afterEventId && !cursor) fail("MISSION_EVENT_CURSOR_INVALID");
      const rows = (cursor
        ? db.query("SELECT * FROM events WHERE mission_id=? AND (occurred_at>? OR (occurred_at=? AND id>?)) ORDER BY occurred_at,id LIMIT ?").all(missionId, cursor.occurred_at, cursor.occurred_at, afterEventId, limit + 1)
        : db.query("SELECT * FROM events WHERE mission_id=? ORDER BY occurred_at,id LIMIT ?").all(missionId, limit + 1)) as EventRow[];
      const hasMore = rows.length > limit;
      const pageRows = rows.slice(0, limit);
      const events = pageRows.map(row => ({ id: row.id, missionId: row.mission_id, occurredAt: row.occurred_at,
        requestId: row.request_id, ...decrypt<Omit<OrchestrationMissionEvent,"id"|"missionId"|"occurredAt"|"requestId">>(key!, row.id, Buffer.from(row.nonce), Buffer.from(row.ciphertext), Buffer.from(row.tag)) }));
      return { events, nextEventId: events.at(-1)?.id ?? afterEventId, hasMore };
    } finally { key?.fill(0); db.close(); }
  }
  async append(value: unknown): Promise<{ mission: OrchestrationMission; event: OrchestrationMissionEvent }> {
    const input = normalizeMissionEvent(value); const db = this.#open(); let key: Buffer | undefined;
    try {
      key = await this.#key(db);
      const prior = db.query("SELECT * FROM events WHERE request_id=?").get(input.requestId) as EventRow | null;
      if (prior) {
        const payload = decrypt<Omit<OrchestrationMissionEvent,"id"|"missionId"|"occurredAt"|"requestId">>(key, prior.id, Buffer.from(prior.nonce), Buffer.from(prior.ciphertext), Buffer.from(prior.tag));
        if (prior.mission_id !== input.missionId || JSON.stringify(payload) !== JSON.stringify({ kind: input.kind, projectIds: input.projectIds, summary: input.summary, whatISaidEventId: input.whatISaidEventId })) fail("MISSION_REQUEST_CONFLICT");
        return { mission: await this.read(prior.mission_id), event: { id: prior.id, missionId: prior.mission_id, occurredAt: prior.occurred_at, requestId: input.requestId, ...payload } };
      }
      const row = db.query("SELECT * FROM missions WHERE id=?").get(input.missionId) as MissionRow | null;
      if (!row) fail("MISSION_NOT_FOUND");
      const state = nextMissionState(row.state as OrchestrationMission["state"], input.kind);
      const id = `event_${randomUUID()}`; const occurredAt = new Date().toISOString();
      const payload = encrypt(key, id, { kind: input.kind, projectIds: input.projectIds, summary: input.summary, whatISaidEventId: input.whatISaidEventId });
      db.transaction(() => {
        db.query("INSERT INTO events VALUES(?,?,?,?,?,?,?)").run(id, input.missionId, input.requestId, occurredAt, payload.nonce, payload.ciphertext, payload.tag);
        db.query("UPDATE missions SET state=?,updated_at=? WHERE id=?").run(state, occurredAt, input.missionId);
      })();
      const body = decrypt<{ title: string; goal: string; checkpoint: string | null }>(key, row.id, Buffer.from(row.nonce), Buffer.from(row.ciphertext), Buffer.from(row.tag));
      return { mission: { id: row.id, state, createdAt: row.created_at, updatedAt: occurredAt, ...body }, event: { id, occurredAt, ...input } };
    } finally { key?.fill(0); db.close(); }
  }
}
