import {randomUUID} from 'node:crypto';
import {chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {isDesktopEffortMode,isWorkroomEffortMode,type DesktopEffortMode,type WorkroomEffortMode} from './workroomEffortMode';

/**
 * The shared auto/recommend/off Workroom preference (auto by default) is owned by the Mac whose
 * CLIs run: `<appData>/workroom-effort-auto.json`. This Mac's main window, popouts and dev web share it, and starts that
 * reach this Mac from a phone, the LAN page or another community device follow it — no phone wire key and no
 * capability-list slot. It is read on every use (a second sidecar on the same data folder sees a change at once).
 */
export const WORKROOM_EFFORT_SETTING_FILE = 'workroom-effort-auto.json';
export const DESKTOP_EFFORT_SETTING_FILE = 'desktop-effort-advice.json';
const MAX_BYTES = 4_096;

export interface WorkroomEffortSettingStore {
  /** Legacy boolean view: true only in auto mode. Missing or damaged settings default to auto. */
  get(): boolean;
  /** Persists the choice (0600, temp file + rename) and returns it. */
  set(auto: boolean): boolean;
  getMode?(): WorkroomEffortMode;
  setMode?(mode: WorkroomEffortMode): WorkroomEffortMode;
  getDesktopMode?(): DesktopEffortMode;
  setDesktopMode?(mode: DesktopEffortMode): DesktopEffortMode;
}

export function createWorkroomEffortSetting(appDataDir: string): WorkroomEffortSettingStore {
  const path = join(appDataDir, WORKROOM_EFFORT_SETTING_FILE);
  const getMode = (): WorkroomEffortMode => {
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.size > MAX_BYTES) return 'auto';
      const saved = JSON.parse(readFileSync(path, 'utf8'));
      if (saved?.version === 2 && isWorkroomEffortMode(saved.mode)) return saved.mode;
      return saved?.version === 1 && typeof saved.auto === 'boolean' ? (saved.auto ? 'auto' : 'off') : 'auto';
    } catch { return 'auto'; }
  };
  const write = (value: object, destination = path) => {
    mkdirSync(appDataDir, {recursive: true});
    const temp = `${destination}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify({...value, updatedAt: new Date().toISOString()}) + '\n', {mode: 0o600, flag: 'wx'});
      chmodSync(temp, 0o600); renameSync(temp, destination);
    } catch (error) { rmSync(temp, {force: true}); throw error; }
  };
  return {
    getMode,
    getDesktopMode() {
      try {
        const desktopPath = join(appDataDir,DESKTOP_EFFORT_SETTING_FILE), stat = lstatSync(desktopPath);
        if (!stat.isFile() || stat.size > MAX_BYTES) return 'recommend';
        const saved = JSON.parse(readFileSync(desktopPath,'utf8'));
        return saved?.version === 1 && isDesktopEffortMode(saved.mode) ? saved.mode : 'recommend';
      } catch {return 'recommend';}
    },
    setDesktopMode(mode) {
      if (!isDesktopEffortMode(mode)) throw Error('앱 에포트는 추천 또는 OFF만 선택할 수 있습니다.');
      write({version:1,mode},join(appDataDir,DESKTOP_EFFORT_SETTING_FILE));return mode;
    },
    setMode(mode) { if (!isWorkroomEffortMode(mode)) throw Error('워크룸 에포트 모드를 확인하세요.'); write({version: 2, mode}); return mode; },
    get() { return getMode() === 'auto'; },
    set(auto) {
      write({version: 1, auto});
      return auto;
    },
  };
}

/** Read-only context attached to normal memory recall; no extra model call or background job. */
export function projectEffortAdviceContext(appDataDir: string) {
  const setting=createWorkroomEffortSetting(appDataDir);
  return {cliMode:setting.getMode!(),desktopMode:setting.getDesktopMode!(),desktopControl:'advice-only' as const,
    scope:'this-execution-host' as const};
}

/** The local `effort` operation on the terminals route: read the setting and session records, or change the setting. */
export interface WorkroomEffortRequest {operation: 'effort'; set?: boolean; mode?: WorkroomEffortMode; effortModes?: true; desktopEffortModes?: true; desktopMode?: DesktopEffortMode; sessionIds?: string[]}
export const isWorkroomEffortOperation = (value: unknown) =>
  !!value && typeof value === 'object' && !Array.isArray(value) && (value as {operation?: unknown}).operation === 'effort';
export const WORKROOM_EFFORT_MAX_SESSION_IDS = 24;

export function normalizeWorkroomEffortRequest(value: unknown): WorkroomEffortRequest {
  const fail = (): never => { throw new Error('에포트 자동 요청이 올바르지 않습니다.'); };
  if (!isWorkroomEffortOperation(value)) return fail();
  const r = value as Record<string, unknown>;
  if (Object.keys(r).some(key => !['operation', 'requestId', 'set', 'mode', 'effortModes', 'desktopEffortModes', 'desktopMode', 'sessionIds'].includes(key))) return fail();
  if (r.requestId !== undefined && (typeof r.requestId !== 'string' || !/^[A-Za-z0-9_-]{8,160}$/.test(r.requestId))) return fail();
  if (r.set !== undefined && typeof r.set !== 'boolean') return fail();
  if (r.effortModes !== undefined && r.effortModes !== true || r.mode !== undefined && (!isWorkroomEffortMode(r.mode) || r.effortModes !== true || r.set !== undefined)) return fail();
  if (r.desktopEffortModes !== undefined && r.desktopEffortModes !== true
    || r.desktopMode !== undefined && (!isDesktopEffortMode(r.desktopMode) || r.desktopEffortModes !== true)
    || r.desktopEffortModes && (r.set !== undefined || r.mode !== undefined || r.effortModes !== undefined || r.sessionIds !== undefined)) return fail();
  if (r.sessionIds !== undefined && (!Array.isArray(r.sessionIds) || r.sessionIds.length > WORKROOM_EFFORT_MAX_SESSION_IDS
    || !r.sessionIds.every(id => typeof id === 'string' && /^[A-Za-z0-9_-]{8,160}$/.test(id)))) return fail();
  return {operation: 'effort', ...(r.set !== undefined ? {set: r.set as boolean} : {}), ...(r.mode !== undefined ? {mode: r.mode as WorkroomEffortMode} : {}), ...(r.effortModes ? {effortModes: true} : {}), ...(r.desktopEffortModes ? {desktopEffortModes:true} : {}), ...(r.desktopMode !== undefined ? {desktopMode:r.desktopMode as DesktopEffortMode} : {}), ...(r.sessionIds !== undefined ? {sessionIds: [...r.sessionIds as string[]]} : {})};
}
