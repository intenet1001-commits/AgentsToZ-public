// The three iPhone fixtures that embed the shipped LANWorkroomView compile it with swiftc from a hand-picked file list
// (mobile/ios/scripts/workroomFixtureCompile.ts). That list broke silently before: LANWorkroomView gained
// `import ScreenControlCore` for 「Mac 화면」, no copy of the list followed, and check-workroom.ts failed with
// `no such module 'ScreenControlCore'` (2026-11-01 review of emu/wp3). These checks predict that failure without Xcode.
import {describe, expect, test} from 'bun:test';
import {readdirSync, readFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {
  WORKROOM_FIXTURE_APP_SOURCES, WORKROOM_FIXTURE_MODULES, WORKROOM_FIXTURE_PROBES,
  workroomFixtureCompileCommands, workroomFixtureTarget, type WorkroomFixtureProbe,
} from '../mobile/ios/scripts/workroomFixtureCompile';

const root = resolve(import.meta.dir, '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');
const APP_DIR = 'mobile/ios/App';
const LOCAL_PACKAGE_MANIFESTS = ['mobile/ios/AgentsToZCore/Package.swift', 'native/screen-control/Package.swift'];

/** Library targets of the repo's local Swift packages (`.target(name: "X")`); test and executable targets excluded. */
function localPackageModules(): Set<string> {
  const names = new Set<string>();
  for (const manifest of LOCAL_PACKAGE_MANIFESTS) for (const match of read(manifest).matchAll(/\.target\(name:\s*"([^"]+)"/g)) names.add(match[1]!);
  return names;
}

const withoutComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

function importsOf(text: string): string[] {
  return [...withoutComments(text).matchAll(/^[ \t]*(?:@[\w.]+(?:\([^)]*\))?[ \t]+)*import[ \t]+(?:(?:struct|class|enum|protocol|func|var|let|typealias)[ \t]+)?([A-Za-z_]\w*)/gm)].map(match => match[1]!);
}

/** Top-level type names an App file declares (column 0, attributes allowed on the same line). */
function topLevelTypes(text: string): string[] {
  return [...withoutComments(text).matchAll(/^(?:@[\w.]+(?:\([^)]*\))?[ \t]+)*(?:(?:public|private|fileprivate|internal|final|open|nonisolated|indirect)[ \t]+)*(?:struct|class|enum|protocol|actor|typealias)[ \t]+([A-Z]\w*)/gm)].map(match => match[1]!);
}

interface Recipe {modules: readonly string[]; appSources: readonly string[]}

/** Local-package imports of the compiled files that no `-l<Module>` provides. */
function missingModules(recipe: Recipe, probes: readonly string[]): Array<{file: string; module: string}> {
  const local = localPackageModules();
  const linked = new Set(recipe.modules);
  const missing: Array<{file: string; module: string}> = [];
  for (const file of [...recipe.appSources, ...probes]) {
    for (const module of importsOf(read(file))) if (local.has(module) && !linked.has(module)) missing.push({file, module});
  }
  return missing;
}

/** Types declared by App files outside the list that a listed file (or probe) names: swiftc would not find them. */
function missingAppTypes(recipe: Recipe, probes: readonly string[]): Array<{file: string; type: string; declaredIn: string}> {
  const listed = new Set(recipe.appSources);
  const declared = new Map<string, string>();
  for (const name of readdirSync(join(root, APP_DIR)).filter(name => name.endsWith('.swift')).sort()) {
    const path = `${APP_DIR}/${name}`;
    if (!listed.has(path)) for (const type of topLevelTypes(read(path))) declared.set(type, path);
  }
  const missing: Array<{file: string; type: string; declaredIn: string}> = [];
  for (const file of [...recipe.appSources, ...probes]) {
    const text = withoutComments(read(file));
    for (const [type, declaredIn] of declared) if (new RegExp(`\\b${type}\\b`).test(text)) missing.push({file, type, declaredIn});
  }
  return missing;
}

const CURRENT: Recipe = {modules: WORKROOM_FIXTURE_MODULES.map(module => module.name), appSources: WORKROOM_FIXTURE_APP_SOURCES};
const PROBES = Object.values(WORKROOM_FIXTURE_PROBES);
/** The list the three scripts carried before the fix (d093fa88). */
const BEFORE_THE_FIX: Recipe = {
  modules: ['AgentsToZCore'],
  appSources: ['mobile/ios/App/PortalSchemeHandler.swift', 'mobile/ios/App/WorkroomStoreWipe.swift', 'mobile/ios/App/LANWorkroomView.swift'],
};

describe('LANWorkroomView fixtures: one compile recipe that follows the app', () => {
  test('the drift checks catch the 2026-10 break: the old list misses ScreenControlCore and the Screen files', () => {
    expect(missingModules(BEFORE_THE_FIX, PROBES)).toContainEqual({file: 'mobile/ios/App/LANWorkroomView.swift', module: 'ScreenControlCore'});
    const types = missingAppTypes(BEFORE_THE_FIX, PROBES).filter(entry => entry.file === 'mobile/ios/App/LANWorkroomView.swift').map(entry => entry.declaredIn);
    expect(types).toContain('mobile/ios/App/ScreenMacsSection.swift');
  });

  test('every local-package import of the compiled files is linked', () => {
    expect(missingModules(CURRENT, PROBES)).toEqual([]);
  });

  test('every App type the listed files and probes name is compiled with them', () => {
    expect(missingAppTypes(CURRENT, PROBES)).toEqual([]);
  });

  test('common actions drift is detected and only the selected probe supplies @main', () => {
    const beforeActions: Recipe = {...CURRENT, appSources: CURRENT.appSources.filter(file => !/\/CommunityActions(?:View)?\.swift$/.test(file))};
    expect(missingAppTypes(beforeActions, PROBES)).toContainEqual({file: 'mobile/ios/App/ScreenMacsSection.swift', type: 'CommunityActionsView', declaredIn: 'mobile/ios/App/CommunityActionsView.swift'});
    for (const file of CURRENT.appSources) expect(withoutComments(read(file))).not.toMatch(/@main\b/);
    for (const probe of PROBES) expect(withoutComments(read(probe)).match(/@main\b/g)).toHaveLength(1);
  });

  test('each probe gets every module as a -l flag and every listed App file, for both targets', () => {
    for (const probe of Object.keys(WORKROOM_FIXTURE_PROBES) as WorkroomFixtureProbe[]) {
      for (const platform of ['simulator', 'device'] as const) {
        const commands = workroomFixtureCompileCommands({root, sdkPath: '/SDK', target: workroomFixtureTarget(platform), buildDir: '/build', probe, output: '/app/Fixture'});
        expect(commands).toHaveLength(WORKROOM_FIXTURE_MODULES.length + 1);
        const app = commands.at(-1)!;
        for (const module of WORKROOM_FIXTURE_MODULES) expect(app).toContain(`-l${module.name}`);
        for (const source of WORKROOM_FIXTURE_APP_SOURCES) expect(app).toContain(join(root, source));
        expect(app).toContain(join(root, WORKROOM_FIXTURE_PROBES[probe]));
        // Swift 6 like the app target, and PortalSchemeHandler before the view that uses it.
        expect(app.join(' ')).toContain('-swift-version 6');
        expect(app.indexOf(join(root, 'mobile/ios/App/PortalSchemeHandler.swift'))).toBeLessThan(app.indexOf(join(root, 'mobile/ios/App/LANWorkroomView.swift')));
        expect(app[app.indexOf('-target') + 1]).toBe(platform === 'device' ? 'arm64-apple-ios17.0' : workroomFixtureTarget('simulator'));
      }
    }
  });

  test('every swiftc call keeps its module cache in the build folder (the shared per-user cache is outside the sandbox)', () => {
    const plain = workroomFixtureCompileCommands({root, sdkPath: '/SDK', target: workroomFixtureTarget('simulator'), buildDir: '/scratch/build', probe: 'workroom', output: '/scratch/app/X'});
    for (const command of plain) {
      expect(command[command.indexOf('-module-cache-path') + 1]).toBe('/scratch/build/ModuleCache');
      expect(command).not.toContain('-disable-sandbox');
    }
    // Inside the emulator sandbox swiftc cannot apply its own macro-plugin sandbox (measured: `@Observable` fails with
    // "swift-plugin-server produced malformed response"), so only that inner layer is dropped.
    const nested = workroomFixtureCompileCommands({root, sdkPath: '/SDK', target: workroomFixtureTarget('simulator'), buildDir: '/scratch/build', probe: 'workroom', output: '/scratch/app/X', nestedInSandbox: true});
    for (const command of nested) expect(command).toContain('-disable-sandbox');
  });

  test('the three scripts take the recipe from the shared module and keep no copy of the list', () => {
    const scripts: Record<string, WorkroomFixtureProbe> = {
      'mobile/ios/scripts/check-workroom.ts': 'workroom',
      'mobile/ios/scripts/prepare-workroom-persona-device.ts': 'persona',
      'mobile/ios/scripts/check-common-memory-device.ts': 'commonMemory',
    };
    for (const [script, probe] of Object.entries(scripts)) {
      const text = read(script);
      expect(text).toContain("from './workroomFixtureCompile'");
      expect(text).toContain(`probe:'${probe}'`);
      expect(text).not.toContain('-lAgentsToZCore');
      expect(text).not.toContain('-lScreenControlCore');
      // check-workroom hashes LANWorkroomView.swift and every compiled source for its evidence, so paths and the word
      // swiftc may appear; the compile flags and the Screen file list may not.
      expect(text).not.toContain('-parse-as-library');
      expect(text).not.toContain('-emit-library');
      expect(text).not.toContain('ScreenMacsSection.swift');
    }
  });
});
