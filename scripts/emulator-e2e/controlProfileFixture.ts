/**
 * WP10 — 공유 제어 폴더(OPS) 프로필 픽스처 레시피: 샌드박스 사이드카 두 대(Mac A·B)가 **같은 운영 프로필**을 쓰고, 서로 다른
 * portal deviceId로 PGlite shim을 거쳐 커뮤니티에 들어가 서로의 엔드포인트를 「활성」으로 본다. 레인 `j4-fixture`와 J4 레인(WP11)이 쓴다.
 * 설계: docs/design/emulator-e2e-2026-11-01/DESIGN.md §3 J4-COMMUNITY-WEB(「프로필 픽스처 레시피는 실제 ControlProfileStore.sharedProfileId()가
 * 픽스처 id를 돌려주는지로 증명한다 — 손으로 추정한 파일 형식을 믿지 않는다」). 레시피 설명: docs/claude/community.md의 「에뮬레이터 픽스처」 절.
 *
 * 레시피(Mac마다 — 파일 형식을 손으로 쓰지 않는다):
 *   1. ports.json에 스크래치 OPS 폴더 `<격리 루트>/projects/AgentsToZ-OPS`를 OPS로 등록(이 Mac 자신의 id), portal.json에 이 Mac의
 *      deviceId·deviceName·shim 주소, supabase-service.json을 준비한다.
 *   2. 그 OPS 폴더를 **샌드박스 자식**이 실제 `initializeProjectMemory`(project-memory-server.ts — createControlProfileHost.initialize와
 *      같은 호출, 합류 경로 memoryId)로 만들고, 공유 프로필 표식(`CONTROL_PROFILE_MARKER`, {schemaVersion:1, profileId, memoryId})을 둔다.
 *      실제 두 Mac에서는 이 폴더가 git clone으로 같다 — 같은 memoryId·같은 표식. 표식 형식은 실제 코드가 두 번 검증한다(candidates()·
 *      prepare의 MARKER_MISMATCH). 사이드카 시작 전에 seed하여 실제 시작 순서를 따른다.
 *   3. **그 사이드카 자신의** `POST /api/control-profile/prepare {projectId}`가 binding.json·access.json을 쓴다
 *      (ControlProfileStore.prepare — 실제 형식, Mac마다 다른 연결 키).
 *   4. 샌드박스 검증 자식이 그 앱 데이터로 실제 `new ControlProfileStore(…).sharedProfileId()`를 불러 픽스처 profileId인지 본다.
 *   5. 대화 공개(enable ops, consent) → 커뮤니티 입장(community-join) — Mac 화면 클릭의 대역으로 관리 API를 부르고 scriptedApproval 영수증을 남긴다.
 * 그 뒤 레인은 양 끝(A·B)을 같이 단언한다: 서로를 controlDevices로 보고, A→B·B→A 제어 우편함 왕복(`{kind:'projects'}`)이 답하고, shim의
 * 대화 DB에 같은 profile_id·다른 device_id의 활성 OPS 엔드포인트 둘이 같은 커뮤니티 방에 joined로 있다.
 *
 * 대역(증거 labels.standIn): Supabase → PGlite shim(http loopback) · 키체인의 대화 기기 키 → 스크래치 파일(dialogue-keychain-entry.ts —
 * 정확히 그 security 호출 두 가지만) · git으로 공유되는 OPS 폴더 → 같은 memoryId·표식의 스크래치 폴더 두 개 · Mac 화면 클릭 → 관리 API.
 * 휴대폰 끝은 이 레인 범위가 아니다(WP11 j4-web이 Mac A를 통해 몬다).
 *
 * 이 파일은 오케스트레이터 안에서 호스트 코드(src/, project-memory-server)를 import하지 않는다. `seed`·`verify` 하위 명령은 샌드박스 자식으로만 돌고
 * 그때만 호스트 코드를 동적으로 읽는다:
 *   bun scripts/emulator-e2e/controlProfileFixture.ts seed --ops-folder <dir> --profile-id <uuid> --memory-id <uuid>
 *   bun scripts/emulator-e2e/controlProfileFixture.ts verify --app-data <dir>
 */
import {createHash, randomUUID} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync} from 'node:fs';
import {basename, isAbsolute, join, resolve} from 'node:path';
import type {LaneContext, LaneDefinition} from '../emulator-e2e';
import type {IsolatedProfile} from './environment';
import type {LaneOutcome, PathLabels} from './evidence';
import type {IsolatedRoot, RunningSidecar} from './isolatedSidecar';
import type {WrittenSandboxProfile} from './sandbox';
import type {RunningSupabaseShim} from './supabaseShimHost';
import {
  KEYCHAIN_STANDIN_ENV,
  readKeychainStandInLog,
  summarizeKeychainStandIn,
  writeKeychainStandIn,
  type KeychainStandIn,
  type KeychainStandInSummary,
} from './dialogueKeychainStandIn';

export const LANE_ID = 'j4-fixture' as const;
export const CONTROL_PROFILE_FIXTURE_SCRIPT = resolve(import.meta.dir, 'controlProfileFixture.ts');
export const DIALOGUE_KEYCHAIN_ENTRY = resolve(import.meta.dir, 'dialogue-keychain-entry.ts');
/** src/opsFolderName.ts의 OPS_FOLDER_NAME(테스트가 같은지 확인한다). candidates()가 이 이름으로 OPS 등록을 알아본다. */
export const OPS_FOLDER_NAME = 'AgentsToZ-OPS';
/** src/controlProfileContract.ts의 controlProfileId와 같은 형식(UUID v1–8). */
export const PROFILE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** 샌드박스 자식 한 번(seed·verify)의 상한. 측정: 수 초. */
export const FIXTURE_CHILD_TIMEOUT_MS = 120_000;

/** 이 레인의 「실제 경로」·「대역」 표기(설계 §1). J4 레인은 여기에 휴대폰 쪽을 더한다. */
export const J4_FIXTURE_LABELS: PathLabels = Object.freeze({
  real: [
    'two sandboxed isolated source sidecars (api-server.ts) A and B — own scratch HOME/app data, different portal deviceIds',
    "each sidecar's own POST /api/control-profile/prepare (createControlProfileHost → ControlProfileStore.prepare) writes binding.json/access.json from the registered AgentsToZ-OPS folder and its marker",
    "ControlProfileStore.sharedProfileId() (src/controlProfileStore.ts) on each Mac's app data, read by a sandboxed probe",
    'OPS project memory by the real initializeProjectMemory (project-memory-server.ts, join path with the shared memoryId)',
    'AgentDialogueHost enable(ops) · community-join · community-status · controlDevices · controlCall through each sidecar\'s management routes',
    "community control mailbox both ways (A→B and B→A {kind:'projects'}) answered by the other sidecar's poll loop",
    'dialogue database = canonical agent dialogue SQL (src/schemaSql.ts) with RLS/grants on PGlite',
    'device key: production provider path (createProductionPromptGuideKeyProvider → spawn security → decodeKey → HMAC) — only the storage is a stand-in',
  ],
  standIn: [
    'Supabase → PGlite shim at http://127.0.0.1:<port> (service-role key from the shim, loopback http allowed by normalizeServerSupabaseUrl)',
    'macOS login Keychain (agent-dialogue device master key) → scratch file via the lane entry wrapper dialogue-keychain-entry.ts — only `security find|add-generic-password -a device-master-v1 -s com.portmanager.portmanager.agent-dialogue.v1 -w`; every other security exec still hits the sandbox',
    'the shared OPS folder (a git clone on each real Mac) → two scratch folders seeded with the same memoryId and the same profile marker before startup',
    'Mac-side clicks (prepare, 대화 공개 동의, 커뮤니티 입장) → each fixture host\'s management API (scriptedApproval:true receipts)',
    'AI CLIs → fake shell CLIs; PATH `ps` → empty stub (setuid /bin/ps is refused inside sandbox-exec)',
  ],
}) as PathLabels;

// ───────────────────────── 픽스처 명세(순수) ─────────────────────────

export interface SharedProfileFixture {
  /** 두 Mac이 공유하는 운영 프로필 id(표식). memoryId와 다르게 둔다 — 표식이 이겼다는 증거가 된다. */
  profileId: string;
  memoryId: string;
}

export interface CommunityMacSpec {
  label: string;
  /** portal.json deviceId(UUID). Mac마다 다르다. */
  deviceId: string;
  deviceName: string;
  /** 이 Mac이 공유 OPS 폴더를 등록한 ports.json id(Mac마다 다르다 — 실제로도 Mac마다 따로 등록한다). */
  opsProjectId: string;
  /** 이 Mac의 일반 픽스처 프로젝트(상대 Mac이 제어 우편함으로 목록을 받는다). */
  projectId: string;
  projectName: string;
}

export function newSharedProfileFixture(): SharedProfileFixture {
  const fixture = {profileId: randomUUID(), memoryId: randomUUID()};
  if (fixture.profileId === fixture.memoryId) throw new Error('profile and memory ids collided');
  return fixture;
}

export function communityMacSpecs(labels: readonly string[] = ['a', 'b']): CommunityMacSpec[] {
  const specs = labels.map(label => {
    if (!/^[a-z][a-z0-9]{0,7}$/.test(label)) throw new Error(`invalid Mac label ${label}`);
    const upper = label.toUpperCase();
    return {label, deviceId: randomUUID(), deviceName: `Fixture Mac ${upper}`, opsProjectId: randomUUID(), projectId: randomUUID(), projectName: `Fixture project ${upper}`};
  });
  assertDistinctMacs(specs);
  return specs;
}

/** 두 Mac이 같은 deviceId·등록 id를 쓰면 「두 대」가 아니다. */
export function assertDistinctMacs(specs: readonly CommunityMacSpec[]): void {
  if (specs.length < 2) throw new Error('the community fixture needs at least two Macs');
  for (const key of ['label', 'deviceId', 'opsProjectId', 'projectId'] as const) {
    if (new Set(specs.map(spec => spec[key])).size !== specs.length) throw new Error(`Mac fixtures share a ${key}`);
  }
  for (const spec of specs) if (!PROFILE_ID_PATTERN.test(spec.deviceId)) throw new Error(`deviceId ${spec.deviceId} is not a runtime UUID`);
}

/** 이 Mac의 ports.json(공유 OPS 폴더 + 일반 프로젝트 하나). */
export function communityMacPorts(spec: CommunityMacSpec, folders: {opsFolder: string; projectFolder: string}): Array<Record<string, unknown>> {
  return [
    {id: spec.opsProjectId, name: OPS_FOLDER_NAME, role: 'ops', folderPath: folders.opsFolder, category: '프로젝트'},
    {id: spec.projectId, name: spec.projectName, folderPath: folders.projectFolder, category: '프로젝트'},
  ];
}

/** 이 Mac의 portal.json. supabaseUrl은 shim(loopback) — writeSidecarFixtures가 다시 검사한다. */
export function communityMacPortal(spec: CommunityMacSpec, supabase: {url: string; anonKey: string}): Record<string, unknown> {
  return {supabaseUrl: supabase.url, supabaseAnonKey: supabase.anonKey, deviceId: spec.deviceId, deviceName: spec.deviceName};
}

export const FAKE_AGENT_CLIS = Object.freeze(['claude', 'codex', 'hermes', 'agy']);
const FAKE_AGENT_SCRIPT = '#!/bin/sh\n# emulator stand-in AI CLI (j4-fixture)\nstty -echo 2>/dev/null\nprintf REMOTE_READY\nwhile read l; do printf "RESULT:%s\\n" "$l"; done\n';
/** setuid /bin/ps는 sandbox-exec 안에서 EPERM이다(WP5 실측) — PATH 기준 `ps`는 빈 출력. 절대 경로 /bin/ps 호출에는 영향이 없다. */
export const SANDBOX_PS_STUB = '#!/bin/sh\n# emulator stand-in: /bin/ps is setuid and cannot run inside sandbox-exec\nexit 0\n';

// ───────────────────────── 판정(순수) ─────────────────────────

export interface MacEndpointExpectation {label: string; deviceId: string; endpointId: string}
export interface ControlExpectation {from: string; to: string; kind: string}

export interface DialogueDumpFacts {
  deviceKeys: number;
  activeOpsEndpoints: number;
  communityRooms: number;
  joinedMembers: number;
  controlsDone: number;
  otherProfileRows: number;
}

type Row = Record<string, unknown>;
const rowsOf = (dump: unknown, table: string): Row[] => {
  const tables = (dump as {tables?: Record<string, unknown>} | null)?.tables;
  const rows = tables?.[table];
  return Array.isArray(rows) ? rows.filter((row): row is Row => !!row && typeof row === 'object' && !Array.isArray(row)) : [];
};

/**
 * shim의 dialogue-db.json(가린 덤프)을 판정한다 — 호스트 끝의 영수증. 두 Mac이 **같은 profile_id**로 기기 키를 등록했고, Mac마다 활성 OPS
 * 엔드포인트가 정확히 하나이며, 그 엔드포인트들이 그 프로필의 커뮤니티 방 하나에 joined이고, 기대한 제어 요청이 각각 정확히 한 번 실행됐는가.
 */
export function judgeDialogueDump(dump: unknown, expected: {profileId: string; macs: readonly MacEndpointExpectation[]; controls?: readonly ControlExpectation[]}): {problems: string[]; facts: DialogueDumpFacts} {
  const problems: string[] = [];
  const profile = expected.profileId;
  const keys = rowsOf(dump, 'portmgr_agent_dialogue_device_keys');
  const endpoints = rowsOf(dump, 'portmgr_agent_dialogue_endpoints');
  const rooms = rowsOf(dump, 'portmgr_agent_dialogue_rooms');
  const members = rowsOf(dump, 'portmgr_agent_dialogue_members');
  const otherProfileRows = [...keys, ...endpoints, ...rooms].filter(row => row.profile_id !== profile).length;
  if (otherProfileRows) problems.push(`${otherProfileRows} dialogue row(s) carry a profile other than the fixture profile`);

  const liveKeys = keys.filter(row => row.profile_id === profile && (row.revoked_at === null || row.revoked_at === undefined));
  const keyDevices = new Set(liveKeys.map(row => String(row.device_id)));
  for (const mac of expected.macs) if (!keyDevices.has(mac.deviceId)) problems.push(`Mac ${mac.label}: no live device key under the fixture profile`);
  if (keyDevices.size !== expected.macs.length) problems.push(`device keys for ${keyDevices.size} device(s), expected ${expected.macs.length}`);

  const active = endpoints.filter(row => row.profile_id === profile && row.state === 'active' && row.kind === 'ops');
  for (const mac of expected.macs) {
    const mine = active.filter(row => row.device_id === mac.deviceId);
    if (mine.length !== 1) problems.push(`Mac ${mac.label}: ${mine.length} active OPS endpoint(s), expected 1`);
    else if (mine[0]!.endpoint_id !== mac.endpointId) problems.push(`Mac ${mac.label}: the active OPS endpoint is not the one enable() returned`);
  }

  const community = rooms.filter(row => row.profile_id === profile && row.kind === 'community');
  if (community.length !== 1 || community[0]!.state !== 'active') problems.push(`${community.length} community room(s) for the fixture profile (expected one active)`);
  const roomId = community[0]?.room_id;
  const joined = members.filter(row => row.room_id === roomId && row.state === 'joined');
  const joinedEndpoints = new Set(joined.map(row => String(row.endpoint_id)));
  for (const mac of expected.macs) if (!joinedEndpoints.has(mac.endpointId)) problems.push(`Mac ${mac.label}: its OPS endpoint is not a joined community member`);
  if (joined.length !== expected.macs.length) problems.push(`${joined.length} joined member(s), expected ${expected.macs.length}`);

  const audit = Array.isArray((dump as {audit?: {dialogue_controls?: unknown}} | null)?.audit?.dialogue_controls)
    ? ((dump as {audit: {dialogue_controls: unknown[]}}).audit.dialogue_controls.filter((row): row is Row => !!row && typeof row === 'object'))
    : [];
  const endpointOf = (label: string) => expected.macs.find(mac => mac.label === label)?.endpointId;
  let controlsDone = 0;
  for (const control of expected.controls ?? []) {
    const from = endpointOf(control.from);
    const to = endpointOf(control.to);
    const inserted = audit.filter(row => row.event === 'insert' && row.from_endpoint_id === from && row.to_endpoint_id === to && row.request_kind === control.kind);
    if (inserted.length !== 1) { problems.push(`control ${control.from}→${control.to} ${control.kind}: ${inserted.length} request row(s), expected exactly 1`); continue; }
    const id = inserted[0]!.control_id;
    const states = audit.filter(row => row.control_id === id).map(row => String(row.state));
    const taken = states.filter(state => state === 'taken').length;
    const done = states.filter(state => state === 'done').length;
    if (taken !== 1 || done !== 1) problems.push(`control ${control.from}→${control.to} ${control.kind}: taken ${taken}× · done ${done}× (expected once each — executed exactly once)`);
    else controlsDone += 1;
  }
  return {problems, facts: {deviceKeys: liveKeys.length, activeOpsEndpoints: active.length, communityRooms: community.length, joinedMembers: joined.length, controlsDone, otherProfileRows}};
}

/** 한 Mac의 controlDevices 답: 커뮤니티 안이고, 자기 자신은 빼고, 상대 Mac들의 OPS 엔드포인트가 보인다. */
export function judgeControlDevices(answer: Record<string, any>, self: MacEndpointExpectation, others: readonly MacEndpointExpectation[]): string[] {
  const problems: string[] = [];
  if (answer.inside !== true) problems.push(`Mac ${self.label}: controlDevices says it is not inside the community`);
  if (answer.deviceId !== self.deviceId) problems.push(`Mac ${self.label}: controlDevices reports another deviceId for itself`);
  const devices = Array.isArray(answer.devices) ? answer.devices as Array<Record<string, unknown>> : [];
  if (devices.some(device => device.deviceId === self.deviceId)) problems.push(`Mac ${self.label}: lists itself as a device to control`);
  for (const other of others) {
    const row = devices.find(device => device.deviceId === other.deviceId);
    if (!row) problems.push(`Mac ${self.label}: does not see Mac ${other.label}`);
    else if (row.endpointId !== other.endpointId || row.kind !== 'ops') problems.push(`Mac ${self.label}: sees Mac ${other.label} through another endpoint (${String(row.kind)})`);
  }
  if (devices.length !== others.length) problems.push(`Mac ${self.label}: ${devices.length} device(s), expected ${others.length}`);
  return problems;
}

/** 관측 래퍼 기록 요약 — 사람의 데스크톱을 건드리려는 실행(거절됨)과 security 실행 결과. */
export function summarizeHostSideEffects(entries: ReadonlyArray<Record<string, unknown>>): {refusedByWrapper: string[]; security: Record<string, number>; total: number} {
  const refusedByWrapper: string[] = [];
  const security: Record<string, number> = {};
  let total = 0;
  for (const entry of entries) {
    if (entry.api === 'guard') continue;
    total += 1;
    if (entry.outcome === 'refused-by-wrapper') refusedByWrapper.push(`${String(entry.command)} via ${String(entry.api)}`);
    if (entry.command === 'security') {
      // 어느 API로 불렀는지까지 남긴다 — 관측 래퍼는 실행 API마다 한 줄을 쓰므로 대역 기록(호출 수)과 개수가 다를 수 있다.
      const key = `${String(entry.api)} ${String(entry.outcome)}${entry.code ? `:${String(entry.code)}` : ''}`;
      security[key] = (security[key] ?? 0) + 1;
    }
  }
  return {refusedByWrapper, security, total};
}

// ───────────────────────── 샌드박스 자식(seed·verify) ─────────────────────────

export interface SeedReport {event: 'seeded'; opsFolder: string; memoryId: string | null; markerFile: string; memoryInitialized: boolean}
export interface VerifyReport {
  event: 'verified';
  appDataDir: string;
  /** 실제 ControlProfileStore.sharedProfileId(). */
  sharedProfileId: string | null;
  status: {state: string; profileId: string | null; memoryId: string | null; backend: string | null; projectId: string | null; problem: string | null};
  location: {state: string; backend: string; projectId: string | null; rootIsOpsFolder: boolean} | null;
  accessProfileId: string | null;
  /** 연결 키(access.json token)의 SHA-256 앞 12자 — 값은 내보내지 않는다. Mac마다 달라야 한다. */
  accessTokenSha256Prefix: string | null;
}

function flag(args: readonly string[], name: string): string {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value || value.startsWith('--')) throw new Error(`missing ${name}`);
  return value;
}

/** 자식은 자기 격리 루트(APP_DATA_DIR의 부모) 안에서만 쓰고 읽는다 — 다른 Mac·실제 홈의 앱 데이터를 가리키면 거절한다. */
function isolatedRootFromEnv(): string {
  const appData = process.env.APP_DATA_DIR;
  if (!appData || !isAbsolute(appData)) throw new Error('APP_DATA_DIR must be the isolated app data folder');
  return realpathSync(resolve(appData, '..'));
}

async function seedChild(args: readonly string[]): Promise<SeedReport> {
  const opsFolder = realpathSync(flag(args, '--ops-folder'));
  const profileId = flag(args, '--profile-id');
  const memoryId = flag(args, '--memory-id');
  if (!PROFILE_ID_PATTERN.test(profileId) || !PROFILE_ID_PATTERN.test(memoryId)) throw new Error('profile and memory ids must be UUIDs');
  if (basename(opsFolder) !== OPS_FOLDER_NAME) throw new Error(`the OPS folder must be named ${OPS_FOLDER_NAME}`);
  if (!opsFolder.startsWith(`${isolatedRootFromEnv()}/`)) throw new Error('the OPS folder must live inside this host\'s isolated root');
  const memory = await import('../../project-memory-server');
  const contract = await import('../../src/controlProfileContract');
  // createControlProfileHost.initialize와 같은 호출(합류 경로: 다른 Mac이 쓰던 memoryId를 그대로).
  memory.initializeProjectMemory({folderPath: opsFolder, projectName: 'AgentsToZ', memoryId, agent: 'codex', autoBackup: false});
  // 공유 OPS 폴더가 실어 나르는 프로필 표식 — candidates()가 profileId를 여기서 읽고, prepare가 binding과 같은지 다시 본다.
  const markerFile = join(opsFolder, contract.CONTROL_PROFILE_MARKER);
  writeFileSync(markerFile, `${JSON.stringify({schemaVersion: 1, profileId, memoryId}, null, 2)}\n`, {mode: 0o600, flag: 'wx'});
  const identity = await memory.detectProjectMemoryIdentity(opsFolder);
  const seeded = identity.config?.memoryId ?? null;
  return {event: 'seeded', opsFolder, memoryId: seeded, markerFile: contract.CONTROL_PROFILE_MARKER, memoryInitialized: seeded === memoryId};
}

async function verifyChild(args: readonly string[]): Promise<VerifyReport> {
  const appDataDir = realpathSync(flag(args, '--app-data'));
  if (appDataDir !== realpathSync(process.env.APP_DATA_DIR ?? '/nonexistent')) throw new Error('verify reads only this host\'s own APP_DATA_DIR');
  const {ControlProfileStore, readControlProfileAccess} = await import('../../src/controlProfileStore');
  const memory = await import('../../project-memory-server');
  const unused = async (): Promise<never> => { throw new Error('not used by the fixture verifier'); };
  // 의존성은 읽기 전용 확인에 필요한 snapshot(실제 readProjectMemorySnapshot)만 실제다 — sharedProfileId()는 아무 의존성도 부르지 않는다.
  const store = new ControlProfileStore(appDataDir, {
    candidates: unused, seed: unused, restore: unused, initialize: unused, save: unused,
    snapshot: root => memory.readProjectMemorySnapshot(root),
  });
  const sharedProfileId = store.sharedProfileId();
  const status = store.status();
  const location = store.boundLocation();
  let access: {profileId: string; token: string} | null = null;
  try { access = readControlProfileAccess(appDataDir); } catch { access = null; }
  return {
    event: 'verified',
    appDataDir,
    sharedProfileId,
    status: {state: status.state, profileId: status.profileId, memoryId: status.memoryId, backend: status.backend, projectId: status.projectId, problem: status.problem},
    location: location ? {state: location.state, backend: location.backend, projectId: location.projectId, rootIsOpsFolder: basename(location.root) === OPS_FOLDER_NAME} : null,
    accessProfileId: access?.profileId ?? null,
    accessTokenSha256Prefix: access ? createHash('sha256').update(access.token).digest('hex').slice(0, 12) : null,
  };
}

/** `bun controlProfileFixture.ts seed|verify …` — 마지막 stdout 줄이 JSON 결과다. 비밀은 출력하지 않는다. */
export async function fixtureChildMain(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  try {
    const result = command === 'seed' ? await seedChild(rest) : command === 'verify' ? await verifyChild(rest) : null;
    if (!result) { process.stderr.write('usage: controlProfileFixture.ts seed|verify …\n'); return 2; }
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`[control-profile-fixture] ${(error as Error)?.stack ?? error}\n`);
    return 1;
  }
}

// ───────────────────────── 오케스트레이터 쪽(호스트 코드 import 없음) ─────────────────────────

/**
 * 하네스 런처 모듈은 오케스트레이터 쪽에서만 동적으로 읽는다. isolatedSidecar.ts는 import될 때 실제 홈을 디렉터리
 * 서비스(dscl)로 확인하는데, seed·verify 자식은 샌드박스 안이라 그 확인이 필요 없고 하지도 않아야 한다.
 */
async function harness() {
  const [sidecar, sandbox] = await Promise.all([import('./isolatedSidecar'), import('./sandbox')]);
  return {...sidecar, sandboxedArgv: sandbox.sandboxedArgv};
}

type FixtureContext = Pick<LaneContext, 'hostSandbox' | 'allowlistedEnv'>;

/** seed·verify를 샌드박스 자식으로 돌린다(호스트 프로필·그 Mac의 허용 목록 환경). */
export async function runFixtureChild<T>(ctx: FixtureContext, profile: IsolatedProfile, args: string[], options: {sandbox?: WrittenSandboxProfile; timeoutMs?: number} = {}): Promise<T> {
  const {sandboxedArgv, trackChild} = await harness();
  const argv = sandboxedArgv(options.sandbox ?? ctx.hostSandbox, [process.execPath, '--env-file=/dev/null', CONTROL_PROFILE_FIXTURE_SCRIPT, ...args]);
  const child = Bun.spawn(argv, {cwd: profile.root, env: ctx.allowlistedEnv({profile}), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe'});
  trackChild(child);
  const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, options.timeoutMs ?? FIXTURE_CHILD_TIMEOUT_MS);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    const last = stdout.trim().split('\n').filter(Boolean).pop();
    if (exitCode !== 0 || !last) throw new Error(`fixture ${args[0]} child exited ${exitCode}: ${stderr.trim().slice(-1_200)}`);
    return JSON.parse(last) as T;
  } finally {
    clearTimeout(timer);
  }
}

export interface CommunityMac {
  spec: CommunityMacSpec;
  root: IsolatedRoot;
  opsFolder: string;
  projectFolder: string;
  keychain: KeychainStandIn;
  sidecar: RunningSidecar;
  seed: SeedReport;
}

/** 관리 요청 한 번 + 영수증(scriptedApproval:true — Mac 화면 클릭의 대역). */
async function scripted(ctx: Pick<LaneContext, 'evidence'>, mac: CommunityMac, action: string, path: string, body: unknown, method: 'POST' | 'GET' = 'POST'): Promise<{status: number; json: Record<string, any>}> {
  const response = await (await harness()).managementRequest(mac.sidecar, path, body, method);
  ctx.evidence.appendJsonl(`${LANE_ID}/receipts.jsonl`, {
    at: new Date().toISOString(), mac: mac.spec.label, action, status: response.status,
    success: response.json.success === true, code: typeof response.json.code === 'string' ? response.json.code : null, scriptedApproval: true,
  });
  return response;
}

export interface StartCommunityMacsInput {
  shim: RunningSupabaseShim;
  /** 사이드카가 부를 shim 주소(J4 web은 https, 이 레인은 http). loopback이어야 한다. */
  supabaseUrl: string;
  /** https shim을 쓰면 그 실행용 CA. */
  extraCaCerts?: string;
  shared: SharedProfileFixture;
  specs: readonly CommunityMacSpec[];
}

/** Wait for every startup before returning failure, so a late success cannot leak. */
export async function settleCommunityStartups<T>(promises: Promise<T>[], started: Array<{stop(): Promise<unknown>}>): Promise<T[]> {
  const outcomes = await Promise.allSettled(promises);
  const failure = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
  if (failure) {
    const cleanup = await Promise.allSettled(started.map(sidecar => sidecar.stop()));
    const errors = cleanup.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => result.reason);
    if (errors.length) throw new AggregateError([failure.reason, ...errors], 'community fixture startup and cleanup failed');
    throw failure.reason;
  }
  return outcomes.map(outcome => (outcome as PromiseFulfilledResult<T>).value);
}

/**
 * 레시피 1–2단계 + 사이드카 기동(Mac마다). prepare·입장은 하지 않는다 — 레인이 단계별로 단언한다.
 *
 * OPS 기억은 시작 전에 seed한다. shim은 이 빈 픽스처의 공유 정책 읽기를 별도로 지원한다.
 */
export async function startCommunityMacs(ctx: LaneContext, input: StartCommunityMacsInput): Promise<CommunityMac[]> {
  assertDistinctMacs(input.specs);
  const {isolatedRoot, writeSidecarFixtures} = await harness();
  const credentials = input.shim.credentials();
  const prepared = input.specs.map(spec => {
    const root = isolatedRoot(ctx.scratchRoot, `j4-mac-${spec.label}`);
    const opsFolder = join(root.root, 'projects', OPS_FOLDER_NAME);
    const projectFolder = join(root.root, 'projects', `fixture-project-${spec.label}`);
    mkdirSync(opsFolder, {recursive: true, mode: 0o700});
    mkdirSync(projectFolder, {recursive: true, mode: 0o700});
    writeSidecarFixtures(root, {
      ports: communityMacPorts(spec, {opsFolder, projectFolder}),
      portal: communityMacPortal(spec, {url: input.supabaseUrl, anonKey: credentials.anonKey}),
      fakeClis: {...Object.fromEntries(FAKE_AGENT_CLIS.map(name => [name, FAKE_AGENT_SCRIPT])), ps: SANDBOX_PS_STUB},
    }, {scratchRoot: ctx.scratchRoot});
    writeFileSync(join(root.appDataDir, 'supabase-service.json'), JSON.stringify({serviceRoleKey: credentials.serviceRoleKey}), {mode: 0o600});
    const keychain = writeKeychainStandIn(join(root.root, 'keychain-standin'));
    return {spec, root, opsFolder, projectFolder, keychain};
  });
  const started: RunningSidecar[] = [];
  return settleCommunityStartups(prepared.map(async entry => {
    const seed = await runFixtureChild<SeedReport>(ctx, entry.root, ['seed', '--ops-folder', entry.opsFolder, '--profile-id', input.shared.profileId, '--memory-id', input.shared.memoryId]);
    if (!seed.memoryInitialized) throw new Error(`Mac ${entry.spec.label}: the OPS memory did not take the shared memoryId`);
    const profile = ctx.sandboxProfile(`j4-fixture-${entry.spec.label}`, {allowedLoopbackPorts: input.shim.loopbackPorts});
    const sidecar = await ctx.startSidecar(entry.root, 'source', {
      profile,
      entryWrapper: DIALOGUE_KEYCHAIN_ENTRY,
      laneOverrides: {[KEYCHAIN_STANDIN_ENV]: entry.keychain.scriptPath},
      ...(input.extraCaCerts ? {extraCaCerts: input.extraCaCerts} : {}),
      observeSideEffects: true,
      checkOpenFiles: true,
      healthTimeoutMs: 90_000,
    });
    started.push(sidecar);
    return {...entry, sidecar, seed};
  }), started);
}

export interface MacProfileReceipts {
  label: string;
  /** prepare 전 대화 status — 공유 프로필이 없으니 거절이어야 한다(음성 대조). */
  beforePrepare: {status: number; code: string | null};
  prepare: {state: string | null; profileId: string | null; memoryId: string | null; backend: string | null; projectId: string | null};
  verify: VerifyReport;
  afterPrepare: {status: number; success: boolean};
}

/** 레시피 3–4단계: 사이드카 자신의 prepare → 실제 store로 sharedProfileId() 확인. 문제는 problems에 쌓는다. */
export async function prepareSharedProfile(ctx: LaneContext, mac: CommunityMac, shared: SharedProfileFixture, problems: string[]): Promise<MacProfileReceipts> {
  const label = mac.spec.label;
  const before = await scripted(ctx, mac, 'dialogue-status-before-prepare', '/api/agent-dialogue/manage', {operation: 'status'});
  const beforeCode = typeof before.json.code === 'string' ? before.json.code : null;
  if (before.status === 200 || beforeCode !== 'AGENT_DIALOGUE_SHARED_PROFILE_REQUIRED') {
    problems.push(`Mac ${label}: before prepare the dialogue host answered ${before.status} ${beforeCode} (expected AGENT_DIALOGUE_SHARED_PROFILE_REQUIRED — no shared profile yet)`);
  }
  const prepare = await scripted(ctx, mac, 'control-profile-prepare', '/api/control-profile/prepare', {projectId: mac.spec.opsProjectId});
  const profile = (prepare.json.profile ?? {}) as Record<string, unknown>;
  const str = (value: unknown) => typeof value === 'string' ? value : null;
  const prepared = {state: str(profile.state), profileId: str(profile.profileId), memoryId: str(profile.memoryId), backend: str(profile.backend), projectId: str(profile.projectId)};
  if (prepare.status !== 200 || prepared.state !== 'ready') problems.push(`Mac ${label}: prepare answered ${prepare.status} state ${prepared.state} (${str(profile.problem) ?? str(prepare.json.error) ?? 'no problem text'})`);
  if (prepared.profileId !== shared.profileId) problems.push(`Mac ${label}: prepare bound profile ${prepared.profileId}, not the fixture profile`);
  if (prepared.memoryId !== shared.memoryId) problems.push(`Mac ${label}: prepare bound memory ${prepared.memoryId}, not the fixture memory`);
  if (prepared.backend !== 'control-folder') problems.push(`Mac ${label}: backend ${prepared.backend}, expected control-folder`);
  if (prepared.projectId !== mac.spec.opsProjectId) problems.push(`Mac ${label}: bound OPS registration ${prepared.projectId}, expected this Mac's own`);
  const verify = await runFixtureChild<VerifyReport>(ctx, mac.root, ['verify', '--app-data', mac.root.appDataDir]);
  if (verify.sharedProfileId !== shared.profileId) problems.push(`Mac ${label}: ControlProfileStore.sharedProfileId() = ${verify.sharedProfileId}, not the fixture profile`);
  if (verify.status.state !== 'ready' || verify.status.profileId !== shared.profileId) problems.push(`Mac ${label}: ControlProfileStore.status() ${verify.status.state} ${verify.status.profileId} (${verify.status.problem ?? ''})`);
  if (verify.accessProfileId !== shared.profileId || !verify.accessTokenSha256Prefix) problems.push(`Mac ${label}: access.json does not hold a key for the fixture profile`);
  if (!verify.location?.rootIsOpsFolder || verify.location.backend !== 'control-folder') problems.push(`Mac ${label}: the binding does not point at the registered OPS folder`);
  const after = await scripted(ctx, mac, 'dialogue-status-after-prepare', '/api/agent-dialogue/manage', {operation: 'status'});
  if (after.status !== 200 || after.json.success !== true) problems.push(`Mac ${label}: after prepare the dialogue host still answered ${after.status} ${String(after.json.code ?? '')} — sharedProfileId() did not reach it`);
  return {label, beforePrepare: {status: before.status, code: beforeCode}, prepare: prepared, verify, afterPrepare: {status: after.status, success: after.json.success === true}};
}

export interface MacCommunityReceipts {label: string; endpointId: string | null; joined: boolean; roomId: string | null; alreadyIn: boolean | null}

/** 레시피 5단계: 대화 공개(OPS, 동의) → 커뮤니티 입장. Mac 화면 클릭의 대역 — scriptedApproval 영수증. */
export async function enterCommunity(ctx: LaneContext, mac: CommunityMac, problems: string[]): Promise<MacCommunityReceipts> {
  const label = mac.spec.label;
  const enable = await scripted(ctx, mac, 'dialogue-enable-ops', '/api/agent-dialogue/manage', {operation: 'enable', source: {target: 'ops'}, consent: true});
  const endpointId = typeof enable.json.endpointId === 'string' ? enable.json.endpointId : null;
  if (enable.status !== 200 || !endpointId || enable.json.kind !== 'ops') {
    problems.push(`Mac ${label}: enable(ops) answered ${enable.status} ${String(enable.json.code ?? '')} ${String(enable.json.error ?? '')}`.trim());
    return {label, endpointId, joined: false, roomId: null, alreadyIn: null};
  }
  const join = await scripted(ctx, mac, 'community-join', '/api/agent-dialogue/manage', {operation: 'community-join', source: {target: 'ops'}});
  const joined = join.status === 200 && join.json.joined === true;
  if (!joined) problems.push(`Mac ${label}: community-join answered ${join.status} ${String(join.json.code ?? '')} ${String(join.json.error ?? '')}`.trim());
  return {label, endpointId, joined, roomId: typeof join.json.roomId === 'string' ? join.json.roomId : null, alreadyIn: typeof join.json.alreadyIn === 'boolean' ? join.json.alreadyIn : null};
}

/**
 * A가 B에게 `{kind:'projects'}`를 보낸다(제어 우편함). controlCall이 상대의 폴(입장 뒤 첫 폴 ≤5초, 유휴 3초 간격)을 20초까지
 * 기다린다. 시간 초과는 「실행됐는지 알 수 없음」이므로 **다시 보내지 않는다**(결과를 모르는 요청은 재전송 금지) — 그대로 실패로 남긴다.
 */
async function controlProjects(ctx: LaneContext, from: CommunityMac, toEndpointId: string): Promise<{status: number; json: Record<string, any>}> {
  return scripted(ctx, from, 'community-control-projects', '/api/agent-dialogue/control', {operation: 'call', targetEndpointId: toEndpointId, request: {kind: 'projects'}});
}

/**
 * 상대 Mac이 제어 우편함으로 돌려준 `{kind:'projects'}` 답(controlPoll의 봉투 `{ok, body|error}`)이 정말 그 Mac의 것인가:
 * 기기 이름 · 그 Mac이 묶은 OPS 등록 id · 그 Mac의 픽스처 프로젝트.
 */
export function judgeProjectsAnswer(envelope: unknown, to: Pick<CommunityMacSpec, 'label' | 'deviceName' | 'opsProjectId' | 'projectId' | 'projectName'>, from: string): {problems: string[]; summary: Record<string, unknown>} {
  const route = `control ${from}→${to.label}`;
  const value = (envelope && typeof envelope === 'object' && !Array.isArray(envelope) ? envelope : {}) as Record<string, unknown>;
  if (value.ok !== true) return {problems: [`${route}: the other Mac answered ok=${String(value.ok)} ${String(value.error ?? '')}`.trim()], summary: {ok: value.ok ?? null, error: value.error ?? null}};
  const body = (value.body && typeof value.body === 'object' && !Array.isArray(value.body) ? value.body : {}) as Record<string, unknown>;
  const projects = Array.isArray(body.projects) ? body.projects as Array<Record<string, unknown>> : [];
  const problems: string[] = [];
  if (body.deviceName !== to.deviceName) problems.push(`${route}: answered by "${String(body.deviceName)}", not Mac ${to.label}`);
  if (body.opsTargetId !== to.opsProjectId) problems.push(`${route}: the answer's OPS target is not Mac ${to.label}'s registration`);
  if (!projects.some(project => project.targetId === to.projectId && project.label === to.projectName)) problems.push(`${route}: Mac ${to.label}'s fixture project is missing from the answer`);
  return {problems, summary: {ok: true, deviceName: body.deviceName ?? null, opsTargetIsOwnRegistration: body.opsTargetId === to.opsProjectId, projectLabels: projects.map(project => project.label)}};
}

// ───────────────────────── 레인 ─────────────────────────

async function readJson(path: string): Promise<unknown> {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}

export async function runJ4FixtureLane(ctx: LaneContext): Promise<LaneOutcome> {
  const labels = J4_FIXTURE_LABELS;
  const problems: string[] = [];
  const details: Record<string, unknown> = {phone: 'not in this lane — WP11 (j4-web) drives Mac B from the phone through Mac A'};
  const shared = newSharedProfileFixture();
  const specs = communityMacSpecs();
  const fail = (reason: string): LaneOutcome => {
    ctx.evidence.writeJson(`${LANE_ID}/summary.json`, {status: 'fail', reason, problems, details});
    return {status: 'fail', reason, labels, details, artifacts: [`${LANE_ID}/summary.json`]};
  };
  let shim: RunningSupabaseShim;
  try {
    shim = await ctx.startSupabaseShim({label: LANE_ID, https: false});
  } catch (error) {
    return fail(`supabase shim did not start: ${(error as Error).message}`);
  }
  if (!shim.ready.httpUrl) return fail('supabase shim has no http door');
  let macs: CommunityMac[];
  try {
    macs = await startCommunityMacs(ctx, {shim, supabaseUrl: shim.ready.httpUrl, shared, specs});
  } catch (error) {
    return fail(`sandboxed hosts did not start: ${(error as Error).message}`);
  }
  details.macs = macs.map(mac => ({label: mac.spec.label, deviceId: mac.spec.deviceId, opsProjectId: mac.spec.opsProjectId, sidecarReadyMs: Math.round(mac.sidecar.readyMs), sandboxed: mac.sidecar.sandboxed}));
  details.sharedProfile = {...shared};

  // ── 프로필: 사이드카마다 prepare → 실제 store의 sharedProfileId() ──
  const profileReceipts: MacProfileReceipts[] = [];
  for (const mac of macs) profileReceipts.push(await prepareSharedProfile(ctx, mac, shared, problems));
  details.profile = profileReceipts.map(receipt => ({...receipt, verify: {...receipt.verify, appDataDir: undefined}}));
  const tokenPrefixes = profileReceipts.map(receipt => receipt.verify.accessTokenSha256Prefix);
  if (new Set(tokenPrefixes).size !== tokenPrefixes.length) problems.push('both Macs hold the same access key (each Mac must mint its own)');
  if (new Set(specs.map(spec => spec.deviceId)).size !== specs.length) problems.push('the Macs share a portal deviceId');
  if (problems.length) return finish();

  // ── 커뮤니티 입장 ──
  const community: MacCommunityReceipts[] = [];
  for (const mac of macs) community.push(await enterCommunity(ctx, mac, problems));
  details.community = community;
  if (problems.length) return finish();
  const expectations: MacEndpointExpectation[] = macs.map((mac, index) => ({label: mac.spec.label, deviceId: mac.spec.deviceId, endpointId: community[index]!.endpointId!}));
  if (new Set(community.map(entry => entry.roomId)).size !== 1) problems.push('the Macs joined different community rooms');

  // ── 양 끝: 서로를 controlDevices로 보고, 제어 우편함이 양쪽으로 답한다 ──
  const devices: Record<string, unknown> = {};
  const controls: Record<string, unknown> = {};
  for (const [index, mac] of macs.entries()) {
    const self = expectations[index]!;
    const others = expectations.filter(entry => entry.label !== self.label);
    const answer = await scripted(ctx, mac, 'control-devices', '/api/agent-dialogue/control', {operation: 'devices'});
    devices[self.label] = {status: answer.status, inside: answer.json.inside, devices: Array.isArray(answer.json.devices) ? answer.json.devices.map((device: Record<string, unknown>) => ({deviceId: device.deviceId, kind: device.kind, displayName: device.displayName})) : null};
    if (answer.status !== 200) problems.push(`Mac ${self.label}: controlDevices answered ${answer.status} ${String(answer.json.code ?? '')}`);
    else problems.push(...judgeControlDevices(answer.json, self, others));
  }
  const pairs: Array<[CommunityMac, CommunityMac]> = [[macs[0]!, macs[1]!], [macs[1]!, macs[0]!]];
  for (const [from, to] of pairs) {
    const toExpectation = expectations.find(entry => entry.label === to.spec.label)!;
    const call = await controlProjects(ctx, from, toExpectation.endpointId);
    const route = `${from.spec.label}->${to.spec.label}`;
    if (call.status !== 200) {
      controls[route] = {status: call.status, code: call.json.code ?? null};
      problems.push(`control ${from.spec.label}→${to.spec.label}: ${call.status} ${String(call.json.code ?? '')} ${String(call.json.error ?? '')}`.trim());
      continue;
    }
    const judged = judgeProjectsAnswer(call.json.response, to.spec, from.spec.label);
    controls[route] = {status: call.status, ...judged.summary};
    problems.push(...judged.problems);
  }
  details.controlDevices = devices;
  details.controls = controls;
  return finish(expectations);

  async function finish(expected?: MacEndpointExpectation[]): Promise<LaneOutcome> {
    // 호스트 끝의 관측: 실제 앱 데이터를 열지 않았고, 데스크톱을 건드리려는 실행이 없었고, 대역 키체인은 대화 기기 키만 받았다.
    const {forbiddenOpenFiles, readSideEffectLog} = await harness();
    const observed: Record<string, unknown> = {};
    for (const mac of macs) {
      const leaks = mac.sidecar.child.exitCode === null ? forbiddenOpenFiles(mac.sidecar.pid) : [];
      if (leaks.length) problems.push(`Mac ${mac.spec.label}: opened real user files ${leaks.slice(0, 3).join(', ')}`);
      const effects = summarizeHostSideEffects(readSideEffectLog(mac.sidecar));
      if (effects.refusedByWrapper.length) problems.push(`Mac ${mac.spec.label}: tried to run ${effects.refusedByWrapper.join(', ')}`);
      const keychain: KeychainStandInSummary = summarizeKeychainStandIn(readKeychainStandInLog(mac.keychain.logPath));
      if (keychain.refused) problems.push(`Mac ${mac.spec.label}: the keychain stand-in refused ${keychain.refused} call(s)`);
      if (expected && !keychain.createdOnce) problems.push(`Mac ${mac.spec.label}: the device key was not created exactly once (${JSON.stringify(keychain.byOutcome)})`);
      observed[mac.spec.label] = {sideEffects: effects, keychainStandIn: keychain};
    }
    details.hostObservation = observed;
    // 사이드카(shim을 부르는 쪽)를 먼저, 그다음 shim — shim이 멈추며 덤프·보고서를 쓴다.
    for (const mac of macs) await mac.sidecar.stop();
    const stopped = await shim.stop();
    details.shimStop = {exitCode: stopped.exitCode, forced: stopped.forced};
    const shimProblems = shim.problems();
    if (shimProblems.length) problems.push(...shimProblems.map(line => `supabase shim: ${line}`));
    const report = await readJson(join(shim.evidenceDir, 'supabase-shim-report.json')) as Record<string, any> | null;
    details.shimReport = report ? {ok: report.ok, unknownRoutes: report.unknownRoutes?.length ?? null, rejectedOrigins: report.rejectedOrigins?.length ?? null, rpcCalls: report.rpcCalls?.portmgr_agent_dialogue_call ?? null} : null;
    if (!report) problems.push('supabase shim left no report');
    if (expected) {
      const dump = await readJson(join(shim.evidenceDir, 'dialogue-db.json'));
      if (!dump) problems.push('supabase shim left no dialogue dump');
      else {
        const judged = judgeDialogueDump(dump, {profileId: shared.profileId, macs: expected, controls: [{from: 'a', to: 'b', kind: 'projects'}, {from: 'b', to: 'a', kind: 'projects'}]});
        details.dialogueDb = judged.facts;
        problems.push(...judged.problems);
      }
    }
    const status = problems.length ? 'fail' : 'pass';
    const artifacts = [`${LANE_ID}/summary.json`, `${LANE_ID}/receipts.jsonl`, ctx.evidence.relative(join(shim.evidenceDir, 'dialogue-db.json')), ctx.evidence.relative(join(shim.evidenceDir, 'supabase-shim-report.json'))];
    ctx.evidence.writeJson(`${LANE_ID}/summary.json`, {status, problems, labels, details});
    return status === 'pass'
      ? {status: 'pass', labels, details, artifacts}
      : {status: 'fail', reason: problems.slice(0, 8).join('; '), labels, details, artifacts};
  }
}

export const lane: LaneDefinition = {
  id: LANE_ID,
  title: 'J4 fixture (WP10) — two sandboxed sidecars share one control-folder profile and enter the community through the shim',
  run: runJ4FixtureLane,
};

if (import.meta.main) {
  process.exit(await fixtureChildMain(process.argv.slice(2)));
}
