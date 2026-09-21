import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, win32 } from 'node:path';

export const PROMPT_GUIDES_KEYCHAIN_SERVICE = 'com.portmanager.portmanager.prompt-guides.v1';
export const PROMPT_GUIDES_KEYCHAIN_ACCOUNT = 'user-guides-v1';
export const PROMPT_GUIDES_DPAPI_FILE = 'prompt-guides.v1.key.dpapi';

export class PromptGuideError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'PromptGuideError'; }
}
export interface PromptGuideKeyProvider {
  /** Null means definitively absent, never locked/unavailable/malformed. Caller owns and clears a returned key. */
  read(): Promise<Buffer | null>;
  /** The store calls this only under its file lock after proving first-save eligibility. Never replaces a key. */
  create(): Promise<Buffer>;
}
export interface SecureAppDataKeyNamespace {
  keychainService: string;
  keychainAccount: string;
  dpapiFile: string;
  dpapiEntropy: string;
}
export interface PromptGuideKeyCommandResult { status: number | null; stdout: Buffer }
export type PromptGuideKeyCommandRunner = (
  command: string, args: readonly string[], input?: Buffer,
) => Promise<PromptGuideKeyCommandResult>;

function fail(code: string): never { throw new PromptGuideError(code); }

type DurabilityPhase = 'key-file' | 'directory';
let testDurabilityFault: ((phase: DurabilityPhase, path: string) => void) | null = null;
/** Deterministic durability faults for isolated tests; never configured by application code. */
export function __setPromptGuideDurabilityFaultForTests(fault: typeof testDurabilityFault): void { testDurabilityFault = fault; }
/** Windows file handles are flushed separately; regular directory handles are POSIX-only. */
export function syncPromptGuideDirectory(path: string): void {
  if (process.platform === 'win32') return;
  const canonical = realpathSync(path);
  const descriptor = openSync(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!fstatSync(descriptor).isDirectory()) fail('PROMPT_GUIDES_PATH_UNSAFE');
    testDurabilityFault?.('directory', canonical);
    fsyncSync(descriptor);
  } finally { closeSync(descriptor); }
}

/** No shell, controlling terminal, credential argv or unbounded command output. */
const defaultRunner: PromptGuideKeyCommandRunner = (command, args, input) => new Promise(resolveResult => {
  let settled = false;
  let bytes = 0;
  let errorBytes = 0;
  let failed = false;
  const chunks: Buffer[] = [];
  const child = spawn(command, [...args], { detached: true, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const stop = () => { failed = true; try { child.kill('SIGKILL'); } catch {} };
  const timer = setTimeout(stop, 5_000);
  child.stdout.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > 64 * 1024) { chunk.fill(0); stop(); } else chunks.push(chunk);
  });
  child.stderr.on('data', (chunk: Buffer) => { errorBytes += chunk.length; chunk.fill(0); if (errorBytes > 64 * 1024) stop(); });
  child.on('error', () => { failed = true; });
  child.on('close', status => {
    if (settled) return;
    settled = true; clearTimeout(timer);
    const stdout = Buffer.concat(chunks);
    for (const chunk of chunks) chunk.fill(0);
    resolveResult({ status: failed ? null : status, stdout });
  });
  child.stdin.on('error', () => {});
  child.stdin.end(input);
});

/** App data itself may not be a symlink. Canonicalize legitimate ancestor aliases (e.g. macOS /tmp). */
export function promptGuideDirectory(appDataDir: string, create = false): string | null {
  if (typeof appDataDir !== 'string' || !isAbsolute(appDataDir) || appDataDir.includes('\0')) fail('PROMPT_GUIDES_PATH_UNSAFE');
  const path = resolve(appDataDir);
  let info;
  try { info = lstatSync(path); }
  catch (error) {
    if ((error as { code?: string }).code !== 'ENOENT') fail('PROMPT_GUIDES_PATH_UNSAFE');
    if (!create) return null;
    const missing: string[] = [];
    let cursor = path;
    for (;;) {
      try { lstatSync(cursor); break; }
      catch (parentError) { if ((parentError as { code?: string }).code !== 'ENOENT') throw parentError; }
      missing.unshift(cursor);
      const parent = dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
    mkdirSync(path, { recursive: true, mode: 0o700 });
    for (const created of missing) { syncPromptGuideDirectory(dirname(created)); syncPromptGuideDirectory(created); }
    info = lstatSync(path);
  }
  if (info.isSymbolicLink() || !info.isDirectory()) fail('PROMPT_GUIDES_PATH_UNSAFE');
  return realpathSync(path);
}

/** Bounded, no-follow regular-file read. Missing and unsafe files stay distinct. */
export function readPromptGuideFile(path: string, limit: number): Buffer | null {
  let info;
  try { info = lstatSync(path); }
  catch (error) { if ((error as { code?: string }).code === 'ENOENT') return null; fail('PROMPT_GUIDES_PATH_UNSAFE'); }
  if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) fail('PROMPT_GUIDES_PATH_UNSAFE');
  if (info.size > limit) fail('PROMPT_GUIDES_FILE_TOO_LARGE');
  let fd: number | undefined;
  const output = Buffer.alloc(limit + 1);
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino || opened.nlink !== 1) fail('PROMPT_GUIDES_PATH_UNSAFE');
    let size = 0;
    while (size < output.length) {
      const read = readSync(fd, output, size, output.length - size, null);
      if (!read) break;
      size += read;
    }
    if (size > limit) fail('PROMPT_GUIDES_FILE_TOO_LARGE');
    return Buffer.from(output.subarray(0, size));
  } finally { output.fill(0); if (fd !== undefined) closeSync(fd); }
}

function decodeKey(raw: Buffer): Buffer {
  if (raw.length > 256 || raw.some(byte => byte > 127)) fail('PROMPT_GUIDES_KEY_MALFORMED');
  const text = raw.toString('ascii').replace(/[\r\n]+$/, '');
  if (!/^[A-Za-z0-9+/]{43}=$/.test(text)) fail('PROMPT_GUIDES_KEY_MALFORMED');
  const key = Buffer.from(text, 'base64');
  if (key.length !== 32 || key.toString('base64') !== text) { key.fill(0); fail('PROMPT_GUIDES_KEY_MALFORMED'); }
  return key;
}

export function createProductionPromptGuideKeyProvider(input: {
  appDataDir: string; platform?: string; runner?: PromptGuideKeyCommandRunner;
  namespace?: SecureAppDataKeyNamespace;
}): PromptGuideKeyProvider {
  const platform = input.platform ?? process.platform;
  const runner = input.runner ?? defaultRunner;
  async function command(command: string, args: string[], stdin?: Buffer): Promise<PromptGuideKeyCommandResult> {
    try {
      const result = await runner(command, args, stdin);
      if (!result || !Buffer.isBuffer(result.stdout) || result.stdout.length > 64 * 1024) {
        result?.stdout?.fill?.(0); fail('PROMPT_GUIDES_KEY_UNAVAILABLE');
      }
      return result;
    } catch (error) { if (error instanceof PromptGuideError) throw error; fail('PROMPT_GUIDES_KEY_UNAVAILABLE'); }
  }
  const namespace = input.namespace ?? {
    keychainService: PROMPT_GUIDES_KEYCHAIN_SERVICE,
    keychainAccount: PROMPT_GUIDES_KEYCHAIN_ACCOUNT,
    dpapiFile: PROMPT_GUIDES_DPAPI_FILE,
    dpapiEntropy: 'agentstoz-prompt-guides-key-v1',
  };
  for (const value of Object.values(namespace)) {
    if (!value || value.includes('\0') || /[\r\n]/.test(value)) fail('PROMPT_GUIDES_KEY_UNAVAILABLE');
  }
  const dpapiBase = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $raw=[Console]::In.ReadToEnd().Trim(); $bytes=[Convert]::FromBase64String($raw); $entropy=[Text.Encoding]::UTF8.GetBytes('${namespace.dpapiEntropy.replace(/'/g, "''")}'); $scope=[Security.Cryptography.DataProtectionScope]::CurrentUser; `;
  const dpapiProtect = dpapiBase + '$result=[Security.Cryptography.ProtectedData]::Protect($bytes,$entropy,$scope); [Console]::Out.Write([Convert]::ToBase64String($result))';
  const dpapiUnprotect = dpapiBase + '$result=[Security.Cryptography.ProtectedData]::Unprotect($bytes,$entropy,$scope); [Console]::Out.Write([Convert]::ToBase64String($result))';
  const macArgs = ['-a', namespace.keychainAccount, '-s', namespace.keychainService, '-w'];
  const powershell = (script: string, stdin: Buffer) => {
    const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
    if (!/^[A-Za-z]:\\[^\0\r\n]*$/.test(systemRoot)) fail('PROMPT_GUIDES_KEY_UNAVAILABLE');
    const executable = win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    return command(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], stdin);
  };
  const read = async (): Promise<Buffer | null> => {
    if (platform === 'darwin') {
      const result = await command('/usr/bin/security', ['find-generic-password', ...macArgs]);
      try {
        if (result.status === 44) return null;
        if (result.status !== 0) fail('PROMPT_GUIDES_KEY_UNAVAILABLE');
        return decodeKey(result.stdout);
      } finally { result.stdout.fill(0); }
    }
    if (platform !== 'win32') fail('PROMPT_GUIDES_KEY_UNSUPPORTED');
    const directory = promptGuideDirectory(input.appDataDir);
    if (!directory) return null;
    const sealed = readPromptGuideFile(join(directory, namespace.dpapiFile), 64 * 1024);
    if (!sealed) return null;
    try {
      if (sealed.some(byte => byte > 127)) fail('PROMPT_GUIDES_KEY_MALFORMED');
      const text = sealed.toString('ascii').trim();
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text) || Buffer.from(text, 'base64').toString('base64') !== text) fail('PROMPT_GUIDES_KEY_MALFORMED');
      const result = await powershell(dpapiUnprotect, sealed);
      try { if (result.status !== 0) fail('PROMPT_GUIDES_KEY_UNAVAILABLE'); return decodeKey(result.stdout); }
      finally { result.stdout.fill(0); }
    } finally { sealed.fill(0); }
  };
  return { read, async create() {
    const existing = await read();
    if (existing) return existing;
    const key = randomBytes(32);
    let stdin: Buffer | undefined;
    try {
      if (platform === 'darwin') {
        const encoded = key.toString('base64');
        stdin = Buffer.from(`${encoded}\n${encoded}\n`);
        const result = await command('/usr/bin/security', ['add-generic-password', ...macArgs], stdin);
        const succeeded = result.status === 0;
        result.stdout.fill(0);
        // Add-only: a concurrent Keychain winner is authoritative, never updated.
        const authoritative = await read();
        if (authoritative) return authoritative;
        fail(succeeded ? 'PROMPT_GUIDES_KEY_MALFORMED' : 'PROMPT_GUIDES_KEY_UNAVAILABLE');
      }
      if (platform !== 'win32') fail('PROMPT_GUIDES_KEY_UNSUPPORTED');
      const directory = promptGuideDirectory(input.appDataDir, true)!;
      stdin = Buffer.from(key.toString('base64'));
      const result = await powershell(dpapiProtect, stdin);
      try {
        if (result.stdout.some(byte => byte > 127)) fail('PROMPT_GUIDES_KEY_MALFORMED');
        const sealed = result.stdout.toString('ascii').trim();
        if (result.status !== 0) fail('PROMPT_GUIDES_KEY_UNAVAILABLE');
        if (!/^[A-Za-z0-9+/]+={0,2}$/.test(sealed) || Buffer.from(sealed, 'base64').toString('base64') !== sealed) fail('PROMPT_GUIDES_KEY_MALFORMED');
        const keyPath = join(directory, namespace.dpapiFile);
        let descriptor: number | undefined;
        try {
          // Keep the writable descriptor: Windows FlushFileBuffers requires it.
          descriptor = openSync(keyPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
        } catch (error) { if ((error as { code?: string }).code !== 'EEXIST') fail('PROMPT_GUIDES_KEY_UNAVAILABLE'); }
        if (descriptor !== undefined) {
          try {
            writeFileSync(descriptor, sealed + '\n');
            testDurabilityFault?.('key-file', keyPath); fsyncSync(descriptor);
          } catch { fail('PROMPT_GUIDES_KEY_UNAVAILABLE'); }
          finally { closeSync(descriptor); }
          try { syncPromptGuideDirectory(directory); }
          catch { fail('PROMPT_GUIDES_KEY_UNAVAILABLE'); }
        }
        const authoritative = await read();
        if (!authoritative) fail('PROMPT_GUIDES_KEY_MISSING');
        return authoritative;
      } finally { result.stdout.fill(0); }
    } finally { key.fill(0); stdin?.fill(0); }
  } };
}
