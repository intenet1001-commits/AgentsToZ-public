import {closeSync,existsSync,fsyncSync,lstatSync,mkdirSync,openSync,readdirSync,renameSync,unlinkSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {readLocalMetadataFile} from './localMetadataFile';
import type {WeeklyUsage,WeeklyUsageRequest} from './weeklyUsage';
import {normalizeWeeklyUsageAlertState,stepWeeklyUsageAlerts,type WeeklyUsageAlert,type WeeklyUsageAlertState} from './weeklyUsageAlerts';
import {toRemoteWeeklyUsage} from './weeklyUsageRemote';
import type {WeeklyUsagePushScreen,WeeklyUsagePushStatus} from './weeklyUsagePush';

/** `<appData>/weekly-usage/push-alerts.json`: `{version: 1, enabled, state}` — the per-Mac switch and the alert state together. */
export const WEEKLY_USAGE_PUSH_FILE = 'push-alerts.json';
/** `<appData>/weekly-usage/push-outbox/`: one file per alert for AgentsToZ Screen (native/screen-control WeeklyUsageOutbox.swift). */
export const WEEKLY_USAGE_PUSH_OUTBOX = 'push-outbox';
/** Hand-offs left waiting at most (AgentsToZ Screen takes them every 30 seconds while screen control is on). */
export const WEEKLY_USAGE_PUSH_OUTBOX_LIMIT = 16;
/** The same age as Swift's `WeeklyUsageHandoff.maxAge` and the relay's `USAGE_MAX_AGE_MS`: older hand-offs are not news. */
export const WEEKLY_USAGE_PUSH_MAX_AGE_MS = 2 * 3600_000;
/** How often this Mac reads its weekly usage by itself while the switch is on; the dock and the phone also feed every read. */
export const WEEKLY_USAGE_PUSH_SAMPLE_MS = 5 * 60_000;

export type WeeklyUsagePushRequest = Extract<WeeklyUsageRequest, {operation: 'alerts'}>;
interface Stored {version: 1; enabled: boolean; state: WeeklyUsageAlertState | null}
interface Handoff {version: 1; provider: WeeklyUsageAlert['provider']; mark: WeeklyUsageAlert['mark']; windowKey: string; observedAt: number}

const HANDOFF_NAME = /^(\d{13})-(?:claude|codex|agy)-\d{1,2}-[0-9a-f]{8}\.json$/;

function ownedDirectory(path: string): void {
  const s = lstatSync(path);
  if (!s.isDirectory() || s.isSymbolicLink() || process.platform !== 'win32' && (s.uid !== process.getuid?.() || (s.mode & 0o077) !== 0)) {
    throw Error('주간 사용량 알림 폴더의 안전성을 확인하지 못했습니다.');
  }
}

/** Write, flush, rename into place, then flush the folder: the file is on disk before the caller goes on. */
function durableWrite(directory: string, name: string, text: string): void {
  const temporary = join(directory, `.${name}.${randomBytes(4).toString('hex')}.tmp`);
  try {
    const fd = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, join(directory, name));
    const folder = openSync(directory, 'r');
    try { fsyncSync(folder); } finally { closeSync(folder); }
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

/**
 * The Mac side of the weekly allowance push (docs/claude/remote-control.md 「문턱 알림 푸시」). Per Mac and OFF by default.
 * While on, every fresh `status()` reading goes through `stepWeeklyUsageAlerts`; its next state is stored durably **before**
 * any alert is handed over, and each alert is handed over once. A hand-off that fails, or that AgentsToZ Screen does not send,
 * is lost by design: nothing here ever re-sends an alert whose outcome is unknown.
 *
 * Delivery: one file per alert in `push-outbox/`, which AgentsToZ Screen reads, removes, signs with the Mac key the iPhone app
 * pinned at registration, and sends to the screen-push relay (kind `weekly-usage`). The main app holds no key and calls no relay.
 * Everything that touches the files runs one at a time, so a switch turned off is never turned back on by a reading in flight.
 */
export class WeeklyUsagePushHost {
  readonly root: string;
  readonly outbox: string;
  private queue: Promise<unknown> = Promise.resolve();
  private sampler: ReturnType<typeof setInterval> | null = null;
  private sampling = false;

  constructor(private readonly deps: {
    /** `<appData>/weekly-usage` (the folder WeeklyUsageHost keeps its statusline snapshots in). */
    root: string;
    /** AgentsToZ Screen's status.json; display only. */
    screenStatusPath?: string;
    now?: () => number;
    /** Hands one alert over. The default writes the outbox file; a test stands in here. Called after the state is stored. */
    deliver?: (alert: WeeklyUsageAlert, observedAt: number) => void;
    log?: (message: string) => void;
  }) {
    this.root = deps.root;
    this.outbox = join(deps.root, WEEKLY_USAGE_PUSH_OUTBOX);
  }

  private now() { return this.deps.now?.() ?? Date.now(); }

  private serial<T>(task: () => T | Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  private ensureRoot(): void {
    if (!existsSync(this.root)) mkdirSync(this.root, {mode: 0o700});
    ownedDirectory(this.root);
  }

  /** The stored switch and state. Missing or unreadable is OFF: a damaged file never turns alerts on. */
  private read(): Stored {
    const off: Stored = {version: 1, enabled: false, state: null};
    const text = readLocalMetadataFile(join(this.root, WEEKLY_USAGE_PUSH_FILE), 65536);
    if (text === null) return off;
    try {
      const value = JSON.parse(text);
      if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1 || typeof value.enabled !== 'boolean'
        || Object.keys(value).length !== 3 || !Object.hasOwn(value, 'state')) return off;
      return {version: 1, enabled: value.enabled, state: value.state === null ? null : normalizeWeeklyUsageAlertState(value.state)};
    } catch { return off; }
  }

  private write(stored: Stored): void {
    this.ensureRoot();
    durableWrite(this.root, WEEKLY_USAGE_PUSH_FILE, JSON.stringify(stored) + '\n');
  }

  /** What AgentsToZ Screen last said about itself, only to tell the person whether it can send now. */
  private screen(): WeeklyUsagePushScreen {
    const path = this.deps.screenStatusPath;
    const text = path ? readLocalMetadataFile(path, 4096) : null;
    if (text === null) return {state: 'missing'};
    try {
      const value = JSON.parse(text);
      const pid = value?.pid;
      if (value?.version !== 1 || !Number.isInteger(pid) || pid <= 0 || !['off', 'starting', 'waiting', 'on'].includes(value.power)
        || !Number.isInteger(value.devices) || value.devices < 0 || value.devices > 10_000) return {state: 'missing'};
      try { process.kill(pid, 0); } catch (error: any) { if (error?.code !== 'EPERM') return {state: 'missing'}; }
      return {state: value.power, devices: value.devices};
    } catch { return {state: 'missing'}; }
  }

  async status(): Promise<WeeklyUsagePushStatus> {
    return this.serial(() => ({enabled: this.read().enabled, screen: this.screen()}));
  }

  /** On or off. Either way the alert state starts over: turning on takes the next reading as a silent baseline (no alert for
   * what was used before), and turning off also drops hand-offs AgentsToZ Screen has not taken yet. */
  async setEnabled(enabled: boolean): Promise<WeeklyUsagePushStatus> {
    return this.serial(() => {
      this.write({version: 1, enabled, state: null});
      if (!enabled) this.clearOutbox();
      return {enabled, screen: this.screen()};
    });
  }

  async perform(request: WeeklyUsagePushRequest): Promise<WeeklyUsagePushStatus> {
    if (request.enabled !== undefined) {
      const status = await this.setEnabled(request.enabled);
      if (request.enabled) void this.sample();
      return status;
    }
    return this.status();
  }

  /**
   * One reading. While the switch is on: step, store the next state, then hand each alert over once. If storing fails nothing
   * is handed over (the next reading tries again, so the alert is not lost). If a hand-off fails it is not tried again.
   */
  observe(items: readonly WeeklyUsage[]): Promise<WeeklyUsageAlert[]> {
    return this.serial(() => {
      const stored = this.read();
      if (!stored.enabled) return [];
      const now = this.now();
      const {nextState, alerts} = stepWeeklyUsageAlerts(stored.state, toRemoteWeeklyUsage(items), now);
      this.write({version: 1, enabled: true, state: nextState});
      for (const alert of alerts) {
        try { (this.deps.deliver ?? this.handOff.bind(this))(alert, now); }
        catch (error) { this.deps.log?.(`[weekly-usage-push] ${alert.key} not handed over: ${error instanceof Error ? error.message : String(error)}`); }
      }
      return alerts;
    });
  }

  /** The default hand-off: a small file AgentsToZ Screen reads. Old leftovers are dropped first, and a full outbox (AgentsToZ
   * Screen has not been taking them) drops the alert instead of piling up more. */
  handOff(alert: WeeklyUsageAlert, observedAt: number): void {
    this.ensureRoot();
    if (!existsSync(this.outbox)) mkdirSync(this.outbox, {mode: 0o700});
    ownedDirectory(this.outbox);
    const waiting = this.pending(true);
    if (waiting >= WEEKLY_USAGE_PUSH_OUTBOX_LIMIT) throw Error('AgentsToZ Screen이 알림을 가져가지 않고 있습니다.');
    const handoff: Handoff = {version: 1, provider: alert.provider, mark: alert.mark, windowKey: alert.windowKey, observedAt};
    durableWrite(this.outbox, `${String(observedAt).padStart(13, '0')}-${alert.provider}-${alert.mark}-${randomBytes(4).toString('hex')}.json`, JSON.stringify(handoff));
  }

  /** How many hand-offs wait; with `prune`, ones older than AgentsToZ Screen would send are removed first. */
  private pending(prune: boolean): number {
    let count = 0;
    for (const name of readdirSync(this.outbox)) {
      const match = HANDOFF_NAME.exec(name);
      if (!match) continue;
      if (prune && this.now() - Number(match[1]) > WEEKLY_USAGE_PUSH_MAX_AGE_MS) {
        try { unlinkSync(join(this.outbox, name)); } catch { /* AgentsToZ Screen took it meanwhile. */ }
        continue;
      }
      count++;
    }
    return count;
  }

  private clearOutbox(): void {
    if (!existsSync(this.outbox)) return;
    ownedDirectory(this.outbox);
    for (const name of readdirSync(this.outbox)) {
      if (HANDOFF_NAME.test(name)) try { unlinkSync(join(this.outbox, name)); } catch { /* Already taken. */ }
    }
  }

  /**
   * Reads by itself every `WEEKLY_USAGE_PUSH_SAMPLE_MS` while the switch is on, so an alert does not wait for someone to open
   * the dock or the phone. `read` is WeeklyUsageHost.status(), which feeds `observe` itself. One read at a time; off costs nothing.
   */
  start(read: () => Promise<unknown>): void {
    if (this.sampler) return;
    this.readStatus = read;
    this.sampler = setInterval(() => { void this.sample(); }, WEEKLY_USAGE_PUSH_SAMPLE_MS);
    (this.sampler as {unref?: () => void}).unref?.();
    // The first one a minute after start, not during the server's own start-up.
    const first = setTimeout(() => { void this.sample(); }, 60_000);
    (first as {unref?: () => void}).unref?.();
  }

  private readStatus: (() => Promise<unknown>) | null = null;

  /** One sampler tick (also right after the switch is turned on). Exposed for tests. */
  async sample(): Promise<void> {
    if (this.sampling || !this.readStatus) return;
    this.sampling = true;
    try {
      if ((await this.serial(() => this.read().enabled))) await this.readStatus();
    } catch { /* A failed read is an unknown reading: nothing to say. */ }
    finally { this.sampling = false; }
  }

  stop(): void {
    if (this.sampler) clearInterval(this.sampler);
    this.sampler = null;
  }
}
