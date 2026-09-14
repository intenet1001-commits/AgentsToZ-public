import {createHash, randomUUID} from 'node:crypto';
import {chmodSync, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {withOwnedPortalFileLock} from './portalFileLock';

const MAX_RECEIPTS = 4096;
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_AGE = 30 * 24 * 60 * 60_000;
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,160}$/.test(value);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const hashValue = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

export class ProjectLaunchReceiptError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export interface ProjectCreationReceipt {
  controllerId: string;
  requestId: string;
  fingerprint: string;
  projectId: string;
  workspaceRootId: string;
  rootIdentityHash: string;
  projectIdentityHash: string | null;
  state: 'reserved' | 'materialized' | 'registered';
  createdAt: string;
  expiresAt: string;
}

export function projectLaunchDirectoryIdentity(path: string): string {
  const canonical = realpathSync(path), info = statSync(canonical);
  if (!info.isDirectory()) throw new ProjectLaunchReceiptError('PROJECT_DIRECTORY_UNAVAILABLE', '등록된 프로젝트 폴더를 확인할 수 없습니다.');
  return hash(JSON.stringify([canonical, String(info.dev), String(info.ino)]));
}

function validate(value: unknown): ProjectCreationReceipt {
  const r = value as ProjectCreationReceipt;
  if (!r || typeof r !== 'object' || Array.isArray(r)
    || Object.keys(r).sort().join() !== ['controllerId','requestId','fingerprint','projectId','workspaceRootId','rootIdentityHash','projectIdentityHash','state','createdAt','expiresAt'].sort().join()
    || !id(r.controllerId) || !id(r.requestId) || !id(r.projectId) || !id(r.workspaceRootId)
    || !hashValue(r.fingerprint) || !hashValue(r.rootIdentityHash)
    || !(r.projectIdentityHash === null || hashValue(r.projectIdentityHash))
    || !['reserved','materialized','registered'].includes(r.state)
    || typeof r.createdAt !== 'string' || typeof r.expiresAt !== 'string'
    || !Number.isFinite(Date.parse(r.createdAt)) || !Number.isFinite(Date.parse(r.expiresAt))
    || Date.parse(r.expiresAt) <= Date.parse(r.createdAt) || Date.parse(r.expiresAt) - Date.parse(r.createdAt) > MAX_AGE
    || (r.state !== 'reserved' && r.projectIdentityHash === null)) {
    throw new ProjectLaunchReceiptError('PROJECT_RECEIPT_UNAVAILABLE', '기존 프로젝트 생성 결과를 안전하게 확인하지 못했습니다. 새 프로젝트를 중복 생성하지 않았습니다.');
  }
  return {...r};
}

/** Bounded private receipts. No name, path, prompt, token, or transcript is persisted. */
export class FileProjectLaunchReceiptStore {
  readonly #directory: string;
  readonly #file: string;
  constructor(appDataDir: string, readonly now: () => number = Date.now, readonly limit = MAX_RECEIPTS) {
    this.#directory = join(appDataDir, 'remote-control');
    this.#file = join(this.#directory, 'project-launch-receipts.json');
  }
  #key(controllerId: string, requestId: string) { return hash(`${controllerId}\0${requestId}`); }
  #read(): Record<string, ProjectCreationReceipt> {
    try {
      const info = lstatSync(this.#file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_BYTES) throw new Error('unsafe receipt file');
      const raw = JSON.parse(readFileSync(this.#file, 'utf8'));
      if (raw.schemaVersion !== 1 || Object.keys(raw).sort().join() !== 'entries,schemaVersion' || !raw.entries || typeof raw.entries !== 'object' || Array.isArray(raw.entries)) throw new Error('invalid receipt schema');
      const entries = Object.entries(raw.entries);
      if (entries.length > MAX_RECEIPTS) throw new Error('receipt capacity exceeded');
      return Object.fromEntries(entries.map(([key, value]) => {
        const receipt = validate(value);
        if (key !== this.#key(receipt.controllerId, receipt.requestId)) throw new Error('receipt key mismatch');
        return [key, receipt];
      }));
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return {};
      throw new ProjectLaunchReceiptError('PROJECT_RECEIPT_UNAVAILABLE', '프로젝트 생성 기록을 확인하지 못했습니다. 기존 폴더를 보존하고 실행을 중단했습니다.');
    }
  }
  async #mutate<T>(action: (entries: Record<string, ProjectCreationReceipt>) => {result: T; write: boolean}): Promise<T> {
    mkdirSync(this.#directory, {recursive: true, mode: 0o700});
    if (lstatSync(this.#directory).isSymbolicLink()) throw new ProjectLaunchReceiptError('PROJECT_RECEIPT_UNAVAILABLE', '프로젝트 생성 기록의 저장 위치를 확인하세요.');
    return withOwnedPortalFileLock(`${this.#file}.lock`, () => {
      const entries = this.#read(), {result, write} = action(entries);
      if (write) {
        const temporary = `${this.#file}.${randomUUID()}.tmp`;
        try {
          const data = JSON.stringify({schemaVersion: 1, entries});
          if (Buffer.byteLength(data) > MAX_BYTES) throw new Error('receipt size exceeded');
          const descriptor = openSync(temporary, 'wx', 0o600);
          try { writeFileSync(descriptor, data); fsyncSync(descriptor); } finally { closeSync(descriptor); }
          renameSync(temporary, this.#file);
          chmodSync(this.#file, 0o600);
          if (process.platform !== 'win32') {
            const directory = openSync(this.#directory, 'r');
            try { fsyncSync(directory); } finally { closeSync(directory); }
          }
        } finally { try { unlinkSync(temporary); } catch {} }
      }
      return result;
    }, {label: 'project launch receipts', attempts: 50, retryMs: 20});
  }
  async reserve(input: Omit<ProjectCreationReceipt, 'projectId' | 'projectIdentityHash' | 'state' | 'createdAt'>): Promise<{receipt: ProjectCreationReceipt; created: boolean}> {
    return this.#mutate<{receipt: ProjectCreationReceipt; created: boolean}>(entries => {
      const key = this.#key(input.controllerId, input.requestId), prior = entries[key];
      if (prior) {
        if (prior.fingerprint !== input.fingerprint || prior.workspaceRootId !== input.workspaceRootId || prior.rootIdentityHash !== input.rootIdentityHash) throw new ProjectLaunchReceiptError('ACTION_ID_REUSED', '같은 생성 요청을 다른 프로젝트에 사용할 수 없습니다.');
        if (Date.parse(prior.expiresAt) <= this.now()) throw new ProjectLaunchReceiptError('PROJECT_RECEIPT_EXPIRED', '프로젝트 생성 요청의 확인 기간이 끝났습니다. 기존 프로젝트 목록에서 확인하세요.');
        return {result: {receipt: {...prior}, created: false}, write: false};
      }
      // Only expired confirmed records can be removed: pending outcomes keep their fence.
      for (const [entryKey, record] of Object.entries(entries)) if (record.state === 'registered' && Date.parse(record.expiresAt) <= this.now()) delete entries[entryKey];
      if (Object.keys(entries).length >= this.limit) throw new ProjectLaunchReceiptError('PROJECT_RECEIPT_CAPACITY', '미확정 프로젝트 생성 결과를 먼저 확인하세요. 기존 프로젝트는 계속 사용할 수 있습니다.');
      const now = this.now();
      const receipt = validate({...input, projectId: randomUUID(), projectIdentityHash: null, state: 'reserved', createdAt: new Date(now).toISOString(), expiresAt: new Date(Math.min(Date.parse(input.expiresAt), now + MAX_AGE)).toISOString()});
      entries[key] = receipt;
      return {result: {receipt: {...receipt}, created: true}, write: true};
    });
  }
  async record(receipt: ProjectCreationReceipt, state: 'materialized' | 'registered', projectIdentityHash: string): Promise<ProjectCreationReceipt> {
    return this.#mutate(entries => {
      const key = this.#key(receipt.controllerId, receipt.requestId), current = entries[key];
      if (!current || current.projectId !== receipt.projectId || current.fingerprint !== receipt.fingerprint
        || (current.projectIdentityHash !== null && current.projectIdentityHash !== projectIdentityHash)) throw new ProjectLaunchReceiptError('PROJECT_RECEIPT_CONFLICT', '프로젝트 생성 대상이 변경되었습니다. 기존 결과를 확인하세요.');
      const next = validate({...current, state: current.state === 'registered' ? 'registered' : state, projectIdentityHash});
      entries[key] = next;
      return {result: {...next}, write: true};
    });
  }
  async findCreatedProject(input: {controllerId: string; projectId: string; workspaceRootId: string; rootIdentityHash: string}): Promise<ProjectCreationReceipt | null> {
    return this.#mutate(entries => ({result: Object.values(entries).find(r => r.state === 'registered'
      && r.controllerId === input.controllerId && r.projectId === input.projectId && r.workspaceRootId === input.workspaceRootId
      && r.rootIdentityHash === input.rootIdentityHash && Date.parse(r.expiresAt) > this.now()) ?? null, write: false}));
  }
}

export function projectCreationFingerprint(workspaceRootId: string, rootIdentityHash: string, name: string) {
  return hash(JSON.stringify([workspaceRootId, rootIdentityHash, name]));
}

export class ProjectCreationCoordinator {
  readonly #inflight = new Map<string, {fingerprint: string; promise: Promise<{internalId: string}>}>();
  constructor(readonly store: FileProjectLaunchReceiptStore) {}
  create(input: Omit<ProjectCreationReceipt, 'projectId' | 'projectIdentityHash' | 'state' | 'createdAt'>,
    dependencies: {
      create(receipt: ProjectCreationReceipt, retainDirectory: (identity: string) => Promise<void>, retainRegistration: (identity: string) => Promise<void>): Promise<void>;
      verifyRegistered(receipt: ProjectCreationReceipt): Promise<boolean>;
    }): Promise<{internalId: string}> {
    const key = `${input.controllerId}\0${input.requestId}`, prior = this.#inflight.get(key);
    if (prior) return prior.fingerprint === input.fingerprint ? prior.promise : Promise.reject(new ProjectLaunchReceiptError('ACTION_ID_REUSED', '같은 생성 요청의 내용이 변경되었습니다.'));
    const promise = (async () => {
      const {receipt, created} = await this.store.reserve(input);
      if (!created) {
        if (!receipt.projectIdentityHash || !await dependencies.verifyRegistered(receipt)) throw new ProjectLaunchReceiptError('PROJECT_CREATE_RECOVERY_REQUIRED', '이전에 요청한 프로젝트의 생성 결과를 아직 확인하지 못했습니다. 새 폴더를 중복 생성하지 않았습니다.');
        await this.store.record(receipt, 'registered', receipt.projectIdentityHash);
      } else {
        let registered = false;
        await dependencies.create(receipt,
          async identity => { await this.store.record(receipt, 'materialized', identity); },
          async identity => { await this.store.record(receipt, 'registered', identity); registered = true; });
        if (!registered) throw new ProjectLaunchReceiptError('PROJECT_CREATE_RECOVERY_REQUIRED', '프로젝트 등록 결과를 확인하지 못했습니다. 같은 요청으로 다시 확인하세요.');
      }
      return {internalId: receipt.projectId};
    })().finally(() => this.#inflight.delete(key));
    this.#inflight.set(key, {fingerprint: input.fingerprint, promise});
    return promise;
  }
}
