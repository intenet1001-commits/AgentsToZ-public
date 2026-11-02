import {expect, test} from 'bun:test';
import {readFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';

// SR-26 and SR-29 (docs/design/mac-to-mac-2026-11-01/DESIGN.md): AgentsToZ Viewer and Screen take only this Mac's
// hardware input (native/screen-control ScreenInputOrigin.swift) by the Control bar's hardware rule
// (native/computer-use ControlBarRules.swift): pid 0, one second. The two Swift packages do not depend on each other,
// so this file holds both sources and the shared vectors (Tests/InputOriginContract/vectors.json) to one set of values.
// InputOriginChecks.swift runs every vector against the Swift code (bun run test:screen-control).

type Rules = {hardwareSourcePid: number; freshSeconds: number; appleRemoteDesktop: string[]; teamRemoteDesktop: Record<string, string[]>};
type Poster = {identifier: string; team: string | null; apple: boolean};
type InputEvent = {kind: string; ageSeconds: number; sourcePid: number; keyboardType: number; sourceState: number; poster?: string};
type Vector = {
  case: string; expect: string; premise?: string; measured?: boolean; residualRisk?: string; device?: string;
  sourcePid?: number; poster?: string; inControl?: boolean; event?: InputEvent | null;
};
type Vectors = {
  rules: Rules; posters: Record<string, Poster>; forward: Vector[]; humanClick: Vector[]; humanKey: Vector[];
  calibration: {status: string; hardwareSourceStates: number[] | null; virtualKeyboardTypes: number[]};
};

const root = join(import.meta.dir, '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');
const controlBar = read('native/computer-use/Sources/ComputerUseControlCore/ControlBarRules.swift');
const origin = read('native/screen-control/Sources/ScreenControlCore/ScreenInputOrigin.swift');
const vectors: Vectors = JSON.parse(read('native/screen-control/Tests/InputOriginContract/vectors.json'));
const lists = ['forward', 'humanClick', 'humanKey'] as const;

/** The single capture of a pattern that must occur exactly once. */
function one(source: string, pattern: RegExp, what: string): string {
  const found = [...source.matchAll(new RegExp(pattern.source, 'g'))];
  if (found.length !== 1) throw Error(`${what}: expected one match, found ${found.length}`);
  return found[0]![1]!;
}
const quoted = (text: string) => [...text.matchAll(/"([^"]+)"/g)].map(m => m[1]!).sort();
function teams(body: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const m of body.matchAll(/"([^"]+)"\s*:\s*\[([^\]]*)\]/g)) out[m[1]!] = quoted(m[2]!);
  return out;
}
function rules(source: string, hardwarePid: RegExp): Rules {
  return {
    hardwareSourcePid: Number(one(source, hardwarePid, 'hardware pid')),
    freshSeconds: Number(one(source, /static let freshSeconds = ([0-9.]+)\b/, 'freshSeconds')),
    appleRemoteDesktop: quoted(one(source, /static let appleRemoteDesktop: Set<String> = \[([^\]]*)\]/, 'Apple remote desktop')),
    teamRemoteDesktop: teams(one(source, /static let teamRemoteDesktop: \[String: Set<String>\] = \[((?:[^[\]]|\[[^\]]*\])*)\]/, 'team remote desktop')),
  };
}
const sorted = (r: Rules): Rules => ({
  ...r, appleRemoteDesktop: [...r.appleRemoteDesktop].sort(),
  teamRemoteDesktop: Object.fromEntries(Object.entries(r.teamRemoteDesktop).map(([team, ids]) => [team, [...ids].sort()])),
});

test('the hardware rule constants are the Control bar\'s, in the Swift core and the vectors', () => {
  const bar = rules(controlBar, /if sourcePid == (\d+) \{ return nil \}/);
  const screen = rules(origin, /static let hardwareSourcePid: Int64 = (\d+)/);
  expect(bar.hardwareSourcePid).toBe(0);
  expect(bar.freshSeconds).toBe(1);
  expect(screen).toEqual(bar);
  expect(sorted(vectors.rules)).toEqual(bar);
  // The constant is what decides, not a second literal beside it.
  expect(origin).toContain('if sourcePid == hardwareSourcePid {');
});

test('both judge the age the same way: one second inclusive, never a future event', () => {
  const rule = /(?:event\.)?ageSeconds >= 0, (?:event\.)?ageSeconds <= freshSeconds/;
  one(controlBar, new RegExp(`(${rule.source})`), 'Control bar age rule');
  one(origin, new RegExp(`(${rule.source})`), 'ScreenInputOrigin age rule');
  expect(vectors.humanClick.find(v => v.case === 'hardware-click-at-limit')).toMatchObject({event: {ageSeconds: 1}, expect: 'accept'});
});

test('the vectors cover every case the design names', () => {
  const cases = (list: typeof lists[number]) => vectors[list].map(v => v.case);
  expect(cases('forward')).toEqual(expect.arrayContaining([
    'hardware-key', 'hardware-pointer', 'own-pid', 'screen-pid', 'other-app-ai', 'other-app-terminal', 'unsigned-tool',
    'remote-desktop-apple', 'remote-desktop-jump', 'virtual-hid-hanyeong', 'virtual-hid-jumpjamorelay', 'virtual-hid-karabiner',
    'synthetic-pid-0', 'remote-desktop-pid-0',
  ]));
  expect(cases('humanClick')).toEqual(expect.arrayContaining([
    'hardware-click', 'stale-click', 'outside-control', 'ax-press', 'osascript-click-button', 'ax-press-after-old-click',
    'script-click', 'ai-click', 'screen-injection-click', 'remote-desktop-click-apple', 'remote-desktop-click-jump',
    'synthetic-click-pid-0', 'remote-desktop-click-pid-0',
  ]));
  expect(cases('humanKey')).toEqual(expect.arrayContaining([
    'hardware-keydown', 'keyup', 'ax-press', 'osascript-keystroke', 'remote-desktop-key-jump', 'stale-key',
    'synthetic-keystroke-pid-0', 'remote-desktop-key-pid-0',
  ]));
  for (const list of lists) expect(new Set(cases(list)).size).toBe(cases(list).length);
  // The two remote desktop agents the design names are real entries of the shared list.
  const {screensharingd, jump} = vectors.posters;
  expect(screensharingd).toMatchObject({identifier: 'com.apple.screensharing.daemon', apple: true});
  expect(vectors.rules.appleRemoteDesktop).toContain(screensharingd!.identifier);
  expect(vectors.rules.teamRemoteDesktop[jump!.team ?? '']).toContain(jump!.identifier);
});

test('accept only ever means hardware, and every refusal is one the Swift code can return', () => {
  const enumBody = one(origin, /public enum ScreenInputRefusal: String, Sendable, CaseIterable \{([\s\S]*?)\n\}/, 'refusal enum');
  const codes = new Set([...enumBody.matchAll(/case \w+ = "([a-z-]+)"/g)].map(m => m[1]!));
  expect(codes.size).toBeGreaterThanOrEqual(9);
  const isRemote = (p: Poster) => p.apple ? vectors.rules.appleRemoteDesktop.includes(p.identifier)
    : (vectors.rules.teamRemoteDesktop[p.team ?? ''] ?? []).includes(p.identifier);
  const remote = new Set(Object.entries(vectors.posters).filter(([, p]) => isRemote(p)).map(([name]) => name));
  expect([...remote].sort()).toEqual(['jump', 'screensharing-agent', 'screensharingd']);
  for (const list of lists) {
    for (const v of vectors[list]) {
      const name = `${list}/${v.case}`;
      const pid = list === 'forward' ? v.sourcePid : v.event?.sourcePid;
      const poster = list === 'forward' ? v.poster : v.event?.poster;
      if (poster !== undefined && remote.has(poster)) expect(v.expect, name).toBe('remote-desktop');
      if (v.expect !== 'accept') { expect(codes.has(v.expect), name).toBe(true); continue; }
      expect(pid, name).toBe(vectors.rules.hardwareSourcePid);
      if (list === 'humanClick') expect([v.event?.kind, v.inControl], name).toEqual(['leftMouseUp', true]);
      if (list === 'humanKey') expect([v.event?.kind, v.inControl], name).toEqual(['keyDown', true]);
    }
  }
});

// The S-M3 premises (DESIGN 13절): sources other than the HID system that might also read as pid 0.
const premises = ['virtual-hid-pid-0', 'synthetic-pid-0', 'remote-desktop-pid-0'];

test('every unmeasured S-M3 premise stays a recorded residual risk, not only the virtual HID devices', () => {
  const all = lists.flatMap(list => vectors[list]);
  const onPremise = all.filter(v => v.premise !== undefined);
  for (const v of all) {
    if (v.premise === undefined) {
      expect([v.measured, v.residualRisk, v.device], `${v.case}: measured or residualRisk without a premise`).toEqual([undefined, undefined, undefined]);
    }
  }
  for (const v of onPremise) {
    expect(premises, v.case).toContain(v.premise!);
    expect(typeof v.measured, v.case).toBe('boolean');
    if (v.expect === 'accept') expect((v.residualRisk ?? '').startsWith(`${v.premise}: `) && (v.residualRisk ?? '').length > v.premise!.length + 2, v.case).toBe(true);
    else expect(v.measured, v.case).toBe(true);
    if (vectors.calibration.status === 'unmeasured') expect(v.measured, v.case).toBe(false);
  }
  if (vectors.calibration.status === 'unmeasured') {
    // Each premise is on record in all three judgements, and the three virtual HID devices the design names are there.
    for (const list of lists) expect(new Set(vectors[list].flatMap(v => v.premise ?? [])), list).toEqual(new Set(premises));
    const virtual = onPremise.filter(v => v.premise === 'virtual-hid-pid-0');
    for (const device of ['hanyeong', 'jumpjamorelay', 'karabiner']) expect(virtual.some(v => v.case.includes(device)), device).toBe(true);
  }
  // The control build flag is the S-M3 result (DESIGN 9절); until S-M3 runs the shipped rule is pid 0 alone.
  expect(origin).toContain('public var allowsControl: Bool { status == .passed }');
  if (vectors.calibration.status === 'unmeasured') {
    expect(origin).toContain('public static let current = uncalibrated');
    expect(vectors.calibration).toEqual({status: 'unmeasured', hardwareSourceStates: null, virtualKeyboardTypes: []});
  }
});

test('no other module can make a calibration that turns control on', () => {
  // Screen, the Viewer and the iOS app link this core; they must reach only `current`, never a `.passed` value of their own.
  const body = one(origin, /public struct ScreenInputCalibration: [^{]*\{([\s\S]*?)\n\}/, 'calibration struct');
  expect([...body.matchAll(/public static (?:let|var|func) (\w+)/g)].map(m => m[1])).toEqual(['current']);
  expect(body).not.toMatch(/public\s+(?:convenience\s+)?init\b/);
  expect(body).toContain('\n    init(status: Status, hardwareSourceStates: Set<Int64>?, virtualKeyboardTypes: Set<Int64>) {');
  expect(body).toContain('\n    static let uncalibrated = ');
  // Nor may another file of the module widen that with an extension.
  const sources = join(root, 'native/screen-control/Sources');
  const extensions = readdirSync(sources, {recursive: true}).map(String).filter(name => name.endsWith('.swift'))
    .filter(name => /extension\s+ScreenInputCalibration\b/.test(readFileSync(join(sources, name), 'utf8')));
  expect(extensions).toEqual([]);
});

test('neither Swift package depends on the other', () => {
  expect([...origin.matchAll(/^import (\w+)/gm)].map(m => m[1])).toEqual(['Foundation']);
  expect(read('native/screen-control/Package.swift')).not.toMatch(/computer-use|ComputerUseControlCore/);
  expect(read('native/computer-use/Package.swift')).not.toMatch(/screen-control|ScreenControlCore/);
});
