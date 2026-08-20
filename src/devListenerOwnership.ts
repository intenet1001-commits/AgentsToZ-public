import { posix, resolve, win32 } from 'node:path';

export interface ListenerProcessIdentity {
  command: string;
  cwd?: string | null;
}

function normalizedPath(value: string): string {
  const absolute = /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')
    ? win32.resolve(value)
    : value.startsWith('/')
      ? posix.resolve(value)
      : resolve(value);
  return absolute.replace(/\\/g, '/').replace(/\/+$/, '');
}

export function isOwnedDevListener(
  identity: ListenerProcessIdentity,
  projectRoot: string,
): boolean {
  if (!identity.cwd || !identity.command.trim()) return false;
  const root = normalizedPath(projectRoot);
  if (normalizedPath(identity.cwd) !== root) return false;

  const command = identity.command.replace(/\\/g, '/');
  const apiEntry = `${root}/api-server.ts`;
  const viteBin = `${root}/node_modules/.bin/vite`;
  const viteJs = `${root}/node_modules/vite/bin/vite.js`;
  return command.includes(apiEntry)
    || command.includes(viteBin)
    || command.includes(viteJs)
    || /(^|\s)(?:\.\/)?api-server\.ts(?:\s|$)/.test(command)
    || /(^|\s)(?:\.\/)?node_modules\/\.bin\/vite(?:\s|$)/.test(command);
}

export function partitionDevListeners<T extends ListenerProcessIdentity>(
  identities: T[],
  projectRoot: string,
): { owned: T[]; protected: T[] } {
  const owned: T[] = [];
  const protectedListeners: T[] = [];
  for (const identity of identities) {
    (isOwnedDevListener(identity, projectRoot) ? owned : protectedListeners).push(identity);
  }
  return { owned, protected: protectedListeners };
}
