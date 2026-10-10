import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isAgentsToZActivityHookCommand } from './projectMemoryActivityHook';

/**
 * Codex asks 「Review hooks / Trust all / Continue without trusting」 the first time it meets a hook it has
 * not trusted, and remembers the answer per hook (`[hooks.state."<path>:<event>:…"] trusted_hash`). A
 * Workroom opened from another Mac starts without the approval bypass, so every project that carries the
 * AgentsToZ activity hook stopped at that menu once (3호, 2026-10-07).
 *
 * Codex has a flag for exactly this — `--dangerously-bypass-hook-trust`, «intended only for automation
 * that already vets hook sources». We pass it only when **every** hook Codex would run is one AgentsToZ
 * wrote itself, compared byte for byte; anything else — a user-level hooks file, a plugin's hooks, a hook
 * table in config.toml, a second command in the project file — keeps Codex's own question.
 */

export const CODEX_HOOK_TRUST_FLAG = '--dangerously-bypass-hook-trust';

export interface CodexHookTrustFiles {
  exists(path: string): boolean;
  read(path: string): string;
  /** Plugin hook files under the Codex home; bounded. */
  pluginHookFiles(codexHome: string): string[];
}

const realFiles: CodexHookTrustFiles = {
  exists: path => existsSync(path),
  read: path => readFileSync(path, 'utf8'),
  pluginHookFiles(codexHome) {
    const found: string[] = [];
    const walk = (dir: string, depth: number) => {
      if (depth > 7 || found.length) return;
      let names: string[];
      try { names = readdirSync(dir); } catch { return; }
      for (const name of names) {
        const path = join(dir, name);
        let isDir = false;
        try { isDir = statSync(path).isDirectory(); } catch { continue; }
        if (isDir) walk(path, depth + 1);
        else if (name === 'hooks.json') { found.push(path); return; }
      }
    };
    walk(join(codexHome, 'plugins'), 0);
    return found;
  },
};

/** A config.toml that declares hooks (anything under `[hooks…]` except the trust records). */
export function configDeclaresHooks(toml: string): boolean {
  // `[hooks.state]` and `[hooks.state."<path>:…"]` are Codex's own trust records, not hooks (3호's config has both).
  return toml.split(/\r?\n/).some(line => /^\s*\[\[?\s*hooks(\s*\]|\.)/.test(line) && !/^\s*\[\s*hooks\.state\s*(\]|\.)/.test(line));
}

/** A project hooks file that holds the AgentsToZ activity hook and nothing else. */
export function hooksFileOnlyAgentsToZ(json: string): boolean {
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { return false; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  const root = parsed as Record<string, unknown>;
  if (Object.keys(root).some(key => key !== 'hooks')) return false;
  const hooks = root.hooks;
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return false;
  const events = Object.entries(hooks as Record<string, unknown>);
  if (events.length === 0) return false;
  for (const [event, entries] of events) {
    if (event !== 'UserPromptSubmit' || !Array.isArray(entries) || entries.length === 0) return false;
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
      const group = entry as Record<string, unknown>;
      if (Object.keys(group).some(key => key !== 'hooks') || !Array.isArray(group.hooks) || group.hooks.length === 0) return false;
      for (const handler of group.hooks) {
        if (!handler || typeof handler !== 'object' || Array.isArray(handler)) return false;
        const h = handler as Record<string, unknown>;
        if (Object.keys(h).some(key => !['type', 'command', 'timeout'].includes(key))) return false;
        if (h.type !== 'command' || typeof h.command !== 'string' || (h.timeout !== undefined && h.timeout !== 5)) return false;
        if (!isAgentsToZActivityHookCommand(h.command, 'codex')) return false;
      }
    }
  }
  return true;
}

/**
 * True when every hook source Codex reads for `cwd` is AgentsToZ's own: no user-level hooks file, no plugin
 * hooks, no hook tables in config.toml, and each `.codex/hooks.json` from `cwd` up to the repository root
 * holds only the AgentsToZ activity hook. A directory with no project hooks at all needs no flag (false).
 */
export function codexHooksAreAgentsToZOnly(cwd: string, codexHome: string, files: CodexHookTrustFiles = realFiles): boolean {
  try {
    if (files.exists(join(codexHome, 'hooks.json'))) return false;
    if (files.exists(join(codexHome, 'config.toml')) && configDeclaresHooks(files.read(join(codexHome, 'config.toml')))) return false;
    if (files.pluginHookFiles(codexHome).length > 0) return false;
    let projectHooks = 0;
    for (let dir = cwd, depth = 0; depth < 32; depth += 1) {
      const hooksFile = join(dir, '.codex', 'hooks.json');
      if (files.exists(hooksFile)) {
        if (!hooksFileOnlyAgentsToZ(files.read(hooksFile))) return false;
        projectHooks += 1;
      }
      const config = join(dir, '.codex', 'config.toml');
      if (files.exists(config) && configDeclaresHooks(files.read(config))) return false;
      if (files.exists(join(dir, '.git'))) break;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return projectHooks > 0;
  } catch {
    return false;
  }
}

const supportCache = new Map<string, Promise<boolean>>();

/** Whether this Codex binary knows the flag (older ones reject unknown options and would not start). */
export function codexSupportsHookTrustFlag(executable: string, env: Record<string, string | undefined> = process.env): Promise<boolean> {
  let cached = supportCache.get(executable);
  if (!cached) {
    cached = new Promise<boolean>(resolve => {
      let out = '';
      const child = spawn(executable, ['--help'], { cwd: '/', env: env as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'ignore'] });
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(false); }, 8_000);
      child.stdout.on('data', chunk => { out += String(chunk); });
      child.on('error', () => { clearTimeout(timer); resolve(false); });
      child.on('close', () => { clearTimeout(timer); resolve(out.includes(CODEX_HOOK_TRUST_FLAG)); });
    });
    supportCache.set(executable, cached);
    // A failure is not remembered forever: the binary may be installed or updated later.
    void cached.then(ok => { if (!ok) setTimeout(() => supportCache.delete(executable), 60_000).unref?.(); });
  }
  return cached;
}
