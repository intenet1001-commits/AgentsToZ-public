import {randomUUID, createHash} from 'node:crypto';
import {lstatSync, mkdirSync, realpathSync} from 'node:fs';
import {isAbsolute, join} from 'node:path';
import {withOwnedPortalFileLock} from './portalFileLock';
import {pathEntryExists, readPrivateFileStrict, writePrivateFileAtomically} from './remoteControlHostVault';
import {CLI_ACCOUNT_MAX_PROFILES, HOST_CLI_ACCOUNT_ID, cliAccountAgent, cliAccountId, cliAccountLabel, type CliAccountAgent} from './cliAccountProtocol';

export interface CliAccountRecord {id: string; agent: CliAccountAgent; label: string; createdAt: string; directoryIdentity: string; archived: boolean}
interface Receipt {key: string; fingerprint: string; accountId: string; expiresAt: number}
interface Registry {schemaVersion: 1; profiles: CliAccountRecord[]; selections: Record<string, string>; receipts: Receipt[]}
const targetId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{8,160}$/.test(v);
/** Check every component we own. Never fix an unsafe directory by chmod or follow a replacement link. */
function privateDirectory(path: string, create = false): string {
  if (create && !pathEntryExists(path)) mkdirSync(path, {mode: 0o700});
  let s: ReturnType<typeof lstatSync>;
  try {s = lstatSync(path);} catch {throw new Error('계정 저장 폴더를 확인하지 못했습니다.');}
  if (!s.isDirectory() || s.isSymbolicLink() || process.platform !== 'win32' && ((s.mode & 0o077) !== 0 || s.uid !== process.getuid?.())) throw new Error('계정 저장 폴더의 접근 권한을 확인하세요.');
  return `${s.dev}:${s.ino}`;
}
/** App data metadata only; provider credentials stay in the provider's private directory/OS store. */
export class CliAccountStore {
  readonly root: string;
  readonly file: string;
  constructor(private readonly appDataDir: string) {
    if (!isAbsolute(appDataDir)) throw new Error('계정 저장 위치를 확인하세요.');
    this.root = join(appDataDir, 'cli-accounts-v1');
    this.file = join(this.root, 'registry.json');
  }
  #root(create = false) {
    if (!pathEntryExists(this.root) && !create) return false;
    let parent: ReturnType<typeof lstatSync>;
    try {parent = lstatSync(this.appDataDir);} catch {throw new Error('앱 데이터 폴더를 확인하지 못했습니다.');}
    if (!parent.isDirectory() || parent.isSymbolicLink() || process.platform !== 'win32' && ((parent.mode & 0o022) !== 0 || parent.uid !== process.getuid?.())) throw new Error('앱 데이터 폴더의 접근 권한을 확인하세요.');
    privateDirectory(this.root, create); return true;
  }
  #read(): Registry {
    if (!this.#root()) return {schemaVersion: 1, profiles: [], selections: {}, receipts: []};
    const text = readPrivateFileStrict(this.file);
    if (text === null) {
      if (pathEntryExists(this.file)) throw new Error('계정 목록을 읽을 수 없습니다. 기존 로그인은 보존됩니다.');
      return {schemaVersion: 1, profiles: [], selections: {}, receipts: []};
    }
    if (text.length > 256 * 1024) throw new Error('계정 저장소 크기 한도를 초과했습니다.');
    let r: Registry;
    try {r = JSON.parse(text);} catch {throw new Error('계정 저장소 형식을 확인하세요.');}
    if (r.schemaVersion !== 1 || !Array.isArray(r.profiles) || r.profiles.length > CLI_ACCOUNT_MAX_PROFILES || !r.selections || typeof r.selections !== 'object' || Array.isArray(r.selections)
      || Object.keys(r.selections).length > 2048 || !Array.isArray(r.receipts) || r.receipts.length > 512) throw new Error('계정 저장소 형식을 확인하세요.');
    for (const p of r.profiles) if (!p || !cliAccountId(p.id) || p.id === HOST_CLI_ACCOUNT_ID || !cliAccountAgent(p.agent) || !cliAccountLabel(p.label)
      || typeof p.archived !== 'boolean' || !Number.isFinite(Date.parse(p.createdAt)) || typeof p.directoryIdentity !== 'string' || !/^\d+:\d+$/.test(p.directoryIdentity)) throw new Error('계정 저장소 형식을 확인하세요.');
    if (new Set(r.profiles.map(p => p.id)).size !== r.profiles.length) throw new Error('중복 계정 기록이 있습니다.');
    for (const [key, id] of Object.entries(r.selections)) if (!/^[a-f0-9]{64}$/.test(key) || !cliAccountId(id) || id !== HOST_CLI_ACCOUNT_ID && !r.profiles.some(p => p.id === id && !p.archived)) throw new Error('계정 선택 기록을 확인하세요.');
    for (const entry of r.receipts) if (!entry || !/^[a-f0-9]{64}$/.test(entry.key) || !/^[a-f0-9]{64}$/.test(entry.fingerprint) || !cliAccountId(entry.accountId) || !Number.isSafeInteger(entry.expiresAt)) throw new Error('계정 요청 기록을 확인하세요.');
    return r;
  }
  #key(target: string, agent: CliAccountAgent) {
    if (!targetId(target) || !cliAccountAgent(agent)) throw new Error('등록 프로젝트와 CLI를 선택하세요.');
    return createHash('sha256').update(JSON.stringify([target, agent])).digest('hex');
  }
  profiles(agent: CliAccountAgent) { return this.#read().profiles.filter(p => p.agent === agent && !p.archived).map(p => ({...p})); }
  record(id: string): CliAccountRecord {
    if (!cliAccountId(id) || id === HOST_CLI_ACCOUNT_ID) throw new Error('등록된 추가 계정을 선택하세요.');
    const p = this.#read().profiles.find(p => p.id === id && !p.archived);
    if (!p) throw new Error('사용할 수 없는 계정입니다. 계정 목록을 다시 확인하세요.');
    return {...p};
  }
  selected(target: string, agent: CliAccountAgent) { return this.#read().selections[this.#key(target, agent)] ?? HOST_CLI_ACCOUNT_ID; }
  directory(id: string) {
    const p = this.record(id); this.#root();
    const path = join(this.root, p.id);
    if (privateDirectory(path) !== p.directoryIdentity || realpathSync(path) !== join(realpathSync(this.root), p.id)) throw new Error('계정 폴더가 변경되었습니다. 기존 세션은 유지하고 계정을 확인하세요.');
    for (const name of ['config.toml','settings.json','auth.json','.credentials.json']) {
      const file = join(path, name);
      if (!pathEntryExists(file)) continue;
      const s = lstatSync(file);
      if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || process.platform !== 'win32' && (s.uid !== process.getuid?.() || s.mode & (name === 'auth.json' || name === '.credentials.json' ? 0o077 : 0o022))) throw new Error('계정 설정·로그인 파일의 접근 권한을 확인하세요.');
    }
    return path;
  }
  async #change<T>(operation: string, owner: string, requestId: string, input: unknown, mutate: (r: Registry) => {result: T; accountId: string}): Promise<{replayed: boolean; result?: T; accountId: string}> {
    if (!/^[A-Za-z0-9_-]{8,160}$/.test(requestId)) throw new Error('계정 요청 ID를 확인하세요.');
    this.#root(true);
    return withOwnedPortalFileLock(this.file + '.lock', () => {
      const r = this.#read(), now = Date.now();
      const key = createHash('sha256').update(JSON.stringify([owner, requestId])).digest('hex');
      const fingerprint = createHash('sha256').update(JSON.stringify([operation, input])).digest('hex');
      r.receipts = r.receipts.filter(e => e.expiresAt > now);
      const old = r.receipts.find(e => e.key === key);
      if (old) { if (old.fingerprint !== fingerprint) throw new Error('같은 요청 ID에 다른 계정 동작을 보낼 수 없습니다.'); return {replayed: true, accountId: old.accountId}; }
      // Receipts are not evicted while valid: a retry must never repeat an earlier switch.
      if (r.receipts.length >= 512) throw new Error('계정 요청 기록 한도에 도달했습니다. 잠시 후 다시 시도하세요.');
      const value = mutate(r);
      r.receipts.push({key, fingerprint, accountId: value.accountId, expiresAt: now + 24 * 60 * 60_000});
      writePrivateFileAtomically(this.root, this.file, JSON.stringify(r));
      return {replayed: false, ...value};
    }, {label: 'CLI accounts', attempts: 50, retryMs: 20, deadOwnerRecoveryClass: 'manual', canRecoverDeadOwner: () => false});
  }
  async create(agent: CliAccountAgent, label: string, requestId: string) {
    if (!cliAccountAgent(agent) || !cliAccountLabel(label)) throw new Error('CLI와 계정 이름을 확인하세요.');
    const result = await this.#change('create', 'local', requestId, [agent,label], r => {
      if (r.profiles.length >= CLI_ACCOUNT_MAX_PROFILES) throw new Error('추가 계정은 최대 24개까지 등록할 수 있습니다.');
      if (r.profiles.some(p => !p.archived && p.agent === agent && p.label === label)) throw new Error('같은 CLI에 같은 계정 이름이 있습니다.');
      const id = 'acct_' + randomUUID(), path = join(this.root, id);
      const identity = privateDirectory(path, true);
      const profile: CliAccountRecord = {id, agent, label, directoryIdentity: identity, createdAt: new Date().toISOString(), archived: false};
      r.profiles.push(profile); return {result: profile, accountId: id};
    });
    return this.record(result.accountId);
  }
  async select(target: string, agent: CliAccountAgent, id: string, requestId: string, owner = 'local', authorized = () => true) {
    const key = this.#key(target, agent);
    if (!cliAccountId(id)) throw new Error('등록된 계정을 선택하세요.');
    return this.#change('select', owner, requestId, [target, agent, id], r => {
      if (!authorized()) throw new Error('계정 선택 권한이 해제되었습니다.');
      if (id !== HOST_CLI_ACCOUNT_ID && !r.profiles.some(p => p.id === id && p.agent === agent && !p.archived)) throw new Error('이 CLI에 등록된 계정을 선택하세요.');
      if (!Object.hasOwn(r.selections, key) && Object.keys(r.selections).length >= 2048) throw new Error('프로젝트 계정 선택 한도에 도달했습니다.');
      r.selections[key] = id; return {result: id, accountId: id};
    });
  }
  async edit(id: string, label: string | null, requestId: string, inUse: () => boolean) {
    this.record(id);
    return this.#change(label === null ? 'archive' : 'rename', 'local', requestId, [id,label], r => {
      const p = r.profiles.find(p => p.id === id && !p.archived);
      if (!p) throw new Error('사용할 수 없는 계정입니다.');
      if (label === null) {
        if (inUse()) throw new Error('이 계정의 실행 중인 작업과 로그인을 먼저 종료하세요.');
        p.archived = true;
        for (const [key, value] of Object.entries(r.selections)) if (value === id) delete r.selections[key];
      } else {
        if (!cliAccountLabel(label) || r.profiles.some(other => !other.archived && other.id !== id && other.agent === p.agent && other.label === label)) throw new Error('중복되지 않는 계정 이름을 입력하세요.');
        p.label = label;
      }
      return {result: id, accountId: id};
    });
  }
}
