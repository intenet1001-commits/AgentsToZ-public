import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join, win32 } from 'node:path';

import {
  WINDOWS_PTY_ENTRY,
  WINDOWS_PTY_NATIVE_FILES,
  WINDOWS_PTY_RUNTIME_DIR,
  isConinPipePath,
  windowsPtyPrebuildDir,
  windowsPtyRuntimeSearchPaths,
  windowsTreeKillArgs,
} from '../src/windowsPtyRuntime';

test('the conin pipe is matched, and nothing else is', () => {
  // The id is high-resolution and not derivable from anything node-pty exposes
  // (`agent._pty` was 1 for this session), so the path is matched, not rebuilt.
  expect(isConinPipePath('\\\\.\\pipe\\conpty-6659701.1242703805-in')).toBe(true);
  expect(isConinPipePath('\\\\?\\pipe\\conpty-7088564.920887405-in')).toBe(true);

  // The out and worker pipes are opened in the same spawn; routing a write to
  // either would silently do nothing.
  expect(isConinPipePath('\\\\.\\pipe\\conpty-6659701.1242703805-out')).toBe(false);
  expect(isConinPipePath('\\\\.\\pipe\\conpty-6659701.1242703805-out-worker')).toBe(false);

  // A project file or an unrelated pipe must never be mistaken for it.
  expect(isConinPipePath('D:\\work\\conpty-1-in')).toBe(false);
  expect(isConinPipePath('\\\\.\\pipe\\conpty-1-in\\nested-in')).toBe(false);
  expect(isConinPipePath('\\\\.\\pipe\\winpty-1-conin')).toBe(false);
  for (const bad of [undefined, null, 42, '', {}]) expect(isConinPipePath(bad)).toBe(false);
});

test('a packaged sidecar looks beside itself, a source run looks in node_modules', () => {
  const packaged = windowsPtyRuntimeSearchPaths({
    execPath: 'C:\\Program Files\\AgentsToZ\\agentstoz-api-sidecar.exe',
    moduleDir: 'B:\\~BUN\\root\\src',
  });
  expect(packaged[0]).toBe(win32.join('C:\\Program Files\\AgentsToZ', WINDOWS_PTY_RUNTIME_DIR));
  // A source run has no staged runtime; the installed package is the fallback.
  expect(packaged.at(-1)).toBe(win32.join('B:\\~BUN\\root\\src', '..', 'node_modules'));

  const source = windowsPtyRuntimeSearchPaths({
    execPath: 'C:\\Users\\x\\.bun\\bin\\bun.exe',
    moduleDir: 'D:\\repo\\src',
  });
  expect(source.at(-1)).toBe(win32.join('D:\\repo\\src', '..', 'node_modules'));
  // No duplicate candidate for a non-sidecar executable.
  expect(new Set(source).size).toBe(source.length);
});

test('tree kill keeps the graceful and forceful escalation apart', () => {
  // The caller sends SIGTERM, waits, then SIGKILL. Collapsing both onto
  // `taskkill /F` would make the polite stop a kill, and dropping /T would
  // leave the CLI's own children running.
  expect(windowsTreeKillArgs(1234, 'SIGTERM')).toEqual(['taskkill.exe', '/T', '/PID', '1234']);
  expect(windowsTreeKillArgs(1234, 'SIGKILL')).toEqual(['taskkill.exe', '/F', '/T', '/PID', '1234']);
  expect(windowsTreeKillArgs(1234, 'SIGINT')).toEqual(['taskkill.exe', '/T', '/PID', '1234']);

  // A pid reaches taskkill as an argument, so it must be a real pid.
  for (const bad of [0, -1, 1.5, Number.NaN]) expect(() => windowsTreeKillArgs(bad, 'SIGKILL')).toThrow();
});

test('the shipped addon list stays the minimal measured set', () => {
  // Measured: a full round trip (output, input echo, resize, exit code) passed
  // in a compiled binary with only these three present -- 999KB with node-pty's
  // lib, against 2.5MB including Microsoft's console host. Adding
  // conpty/OpenConsole.exe back would put a third-party executable into the
  // installer and the signing surface for no measured gain.
  expect([...WINDOWS_PTY_NATIVE_FILES]).toEqual(['conpty.node', 'conpty_console_list.node', 'pty.node']);
  for (const file of WINDOWS_PTY_NATIVE_FILES) expect(file.endsWith('.node')).toBe(true);
  expect(windowsPtyPrebuildDir('win32', 'x64')).toBe(join('prebuilds', 'win32-x64'));
  expect(windowsPtyPrebuildDir('win32', 'arm64')).toBe(join('prebuilds', 'win32-arm64'));
});

test('the installed package actually carries what the build stages', () => {
  const root = join(import.meta.dir, '..', 'node_modules', 'node-pty');
  if (!existsSync(root)) return; // Not installed in this checkout.
  // WINDOWS_PTY_ENTRY is relative to the runtime root, which holds `node-pty/`.
  expect(existsSync(join(root, '..', WINDOWS_PTY_ENTRY))).toBe(true);
  // node-pty ships the Windows prebuilds on every platform, so check the ones the Windows build stages —
  // not the host's (on a Mac that is darwin-*, which never holds conpty.node).
  for (const arch of ['x64', 'arm64']) {
    const prebuild = join(root, windowsPtyPrebuildDir('win32', arch));
    for (const file of WINDOWS_PTY_NATIVE_FILES) {
      expect(existsSync(join(prebuild, file)), `${file} missing from ${prebuild}`).toBe(true);
    }
  }
});

test('the build stages the runtime and the bundle ships it', () => {
  const build = readFileSync(join(import.meta.dir, '..', 'build-sidecar.ts'), 'utf8');
  expect(build).toContain('stageWindowsPtyRuntime');
  // Staging must stay win32-only: the macOS and Linux Workrooms use Bun's own
  // PTY and would otherwise carry an unused addon into their bundles. Asserted on
  // the guard rather than on one formatting of it -- the containment launcher was
  // later added to the same block, which is correct and broke a literal match.
  const win32Block = build.slice(build.indexOf("if (process.platform === 'win32') {"));
  expect(win32Block.slice(0, win32Block.indexOf('}'))).toContain('stageWindowsPtyRuntime(');
  // The definition and exactly one call site.
  expect(build.split('stageWindowsPtyRuntime(').length - 1).toBe(2);

  // Windows-only resources live in tauri.windows.conf.json (merged only on Windows). In the shared config they
  // broke the macOS build: Tauri fails a resource entry that matches nothing, and only Windows stages them.
  const read = (name: string) => JSON.parse(readFileSync(join(import.meta.dir, '..', 'src-tauri', name), 'utf8'));
  const base: string[] = read('tauri.conf.json').bundle.resources;
  const windows: string[] = read('tauri.windows.conf.json').bundle.resources;
  for (const windowsOnly of [`resources/${WINDOWS_PTY_RUNTIME_DIR}/`, 'resources/agentstoz-windows-contain*']) {
    expect(windows).toContain(windowsOnly);
    expect(base).not.toContain(windowsOnly);
  }
  // The platform file replaces the array (JSON Merge Patch), so it must keep everything the base ships.
  for (const shared of base) expect(windows).toContain(shared);

  // The launcher is its own package, never a bin of the app crate: Tauri bundles every app bin into the app,
  // which put it in the macOS bundle and broke the signature check. The Windows build targets that package.
  const cargo = readFileSync(join(import.meta.dir, '..', 'src-tauri', 'Cargo.toml'), 'utf8');
  expect(cargo).not.toContain('agentstoz-windows-contain"');
  expect(existsSync(join(import.meta.dir, '..', 'src-tauri', 'src', 'bin', 'agentstoz-windows-contain.rs'))).toBe(false);
  expect(existsSync(join(import.meta.dir, '..', 'src-tauri', 'windows-contain', 'Cargo.toml'))).toBe(true);
  expect(build).toContain("join(projectRoot, 'src-tauri', 'windows-contain', 'Cargo.toml')");
});
