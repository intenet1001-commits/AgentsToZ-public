import { afterEach, expect, test } from 'bun:test';
import { closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { displaceRunningWindowsOutput } from '../build-sidecar';

/**
 * Windows cannot overwrite a running executable, so `bun build --compile` failed
 * the whole sidecar build with `failed to move executable to
 * ...\agentstoz-use-mcp.exe: EPERM` whenever an `agentstoz-use-mcp.exe` an `agy`
 * session had started was still alive. This repository never kills an MCP an AI
 * started, so the only remedy was closing the editor. Renaming a running binary
 * **is** permitted -- the open handle follows the file, not the path.
 */
const windowsTest = process.platform === 'win32' ? test : test.skip;
const roots: string[] = [];
const children: ReturnType<typeof Bun.spawn>[] = [];

afterEach(() => {
  for (const child of children.splice(0)) { try { child.kill(); } catch { /* already gone */ } }
  for (const root of roots.splice(0)) {
    // A just-killed child can still hold its image for a moment.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try { rmSync(root, { recursive: true, force: true }); break; } catch { Bun.sleepSync(50); }
    }
  }
});

function directory(): string {
  const root = mkdtempSync(join(tmpdir(), 'agentstoz-in-use-'));
  roots.push(root);
  return root;
}

/** Outputs live in `resources/`, which is what the bundler ships by glob. */
function resources(root: string): string {
  const path = join(root, 'resources');
  mkdirSync(path, { recursive: true });
  return path;
}

/** Where a displaced copy belongs: a sibling of `resources/`, never inside it. */
function aside(outfile: string, index: number): string {
  return join(dirname(dirname(outfile)), 'displaced-in-use', `${basename(outfile)}.in-use-${index}`);
}

/** A copy of a real console binary we own, left running from `path`. */
function running(path: string): void {
  copyFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'ping.exe'), path);
  children.push(Bun.spawn([path, '-n', '30', '127.0.0.1'], { stdout: 'ignore', stderr: 'ignore' }));
  for (let attempt = 0; attempt < 40 && existsSync(path); attempt += 1) {
    // Wait for the image lock rather than a fixed sleep: an unheld file here
    // would make the displacement assertions pass for the wrong reason.
    try { closeSync(openSync(path, 'r+')); Bun.sleepSync(25); }
    catch { return; } // Held — the state under test.
  }
  throw new Error('the child never took a write lock on its own image');
}

windowsTest('a running output is displaced so the compiler can write its path', () => {
  const root = directory();
  const outfile = join(resources(root), 'agentstoz-use-mcp.exe');
  running(outfile);

  displaceRunningWindowsOutput(outfile);

  // The path is free for the compiler, and the live process keeps its image.
  expect(existsSync(outfile)).toBe(false);
  expect(existsSync(aside(outfile, 0))).toBe(true);
  writeFileSync(outfile, 'freshly compiled');
  expect(readFileSync(outfile, 'utf8')).toBe('freshly compiled');
});

windowsTest('an output nothing holds is left exactly where it is', () => {
  const root = directory();
  const outfile = join(resources(root), 'agentstoz-api-sidecar.exe');
  writeFileSync(outfile, 'previous build');

  displaceRunningWindowsOutput(outfile);

  // Renaming a free file would litter the resource directory for no reason.
  expect(readFileSync(outfile, 'utf8')).toBe('previous build');
  expect(existsSync(aside(outfile, 0))).toBe(false);
});

windowsTest('a displaced copy that is still running does not fail the next build', () => {
  const root = directory();
  const outfile = join(resources(root), 'agentstoz-use-mcp.exe');
  running(outfile);
  displaceRunningWindowsOutput(outfile);
  writeFileSync(outfile, 'build one');

  // `rmSync({force:true})` only swallows ENOENT; the still-held copy raises EBUSY,
  // and throwing here would break the build this function exists to rescue.
  expect(() => displaceRunningWindowsOutput(outfile)).not.toThrow();
  expect(existsSync(aside(outfile, 0))).toBe(true);
  expect(readFileSync(outfile, 'utf8')).toBe('build one');
});

windowsTest('a freed copy is swept on the next build', () => {
  const root = directory();
  const outfile = join(resources(root), 'agentstoz-use-mcp.exe');
  writeFileSync(outfile, 'current');
  mkdirSync(dirname(aside(outfile, 0)), { recursive: true });
  writeFileSync(aside(outfile, 0), 'left by an earlier build');

  displaceRunningWindowsOutput(outfile);

  expect(existsSync(aside(outfile, 0))).toBe(false);
  expect(readFileSync(outfile, 'utf8')).toBe('current');
});

test('a missing output is nothing to displace', () => {
  expect(() => displaceRunningWindowsOutput(join(directory(), 'never-built.exe'))).not.toThrow();
});

/**
 * The first version kept the aside beside the output, where
 * `resources/agentstoz-use-mcp*` matched it: a 116MB stale sidecar shipped
 * inside the v598 installer. The aside has to sit where no shipped glob reaches.
 */
test('a displaced copy cannot match a bundled resource glob', () => {
  const resourceGlobs = (JSON.parse(
    readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'),
  ) as { bundle: { resources: string[] } }).bundle.resources;
  expect(resourceGlobs.length).toBeGreaterThan(0);

  const relative = aside(join('/project/src-tauri/resources', 'agentstoz-use-mcp.exe'), 0)
    .replace(/\\/g, '/')
    .replace('/project/src-tauri/', '');
  expect(relative).toBe('displaced-in-use/agentstoz-use-mcp.exe.in-use-0');
  for (const glob of resourceGlobs) {
    expect(new Bun.Glob(glob.endsWith('/') ? `${glob}**` : glob).match(relative)).toBe(false);
  }
});
