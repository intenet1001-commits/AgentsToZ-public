import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

/** Server-only filesystem guards. Keep this module out of the browser graph;
 * `vocFileAccess.ts` is shared by React and must remain free of node builtins. */

/** Resolve one existing regular VOC JSON without following a link at either
 * the file or directory boundary. `null` means absent; unsafe topology throws. */
export function safePendingVocFile(appDataDir: string, name: string): string | null {
  const dir = join(appDataDir, 'voc');
  if (!existsSync(dir)) return null;
  const lexicalDir = resolve(dir);
  const file = resolve(lexicalDir, name);
  if (dirname(file) !== lexicalDir || !existsSync(file)) return null;
  const appDataReal = realpathSync(appDataDir);
  const dirStat = lstatSync(lexicalDir);
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) throw new Error('VOC_PATH_UNSAFE');
  const dirReal = realpathSync(lexicalDir);
  if (dirname(dirReal) !== appDataReal || basename(dirReal) !== 'voc') throw new Error('VOC_PATH_UNSAFE');
  const fileStat = lstatSync(file);
  // A hard link is unsafe for PATCH too: writing it mutates another name even
  // though realpath cannot reveal that alias.
  if (fileStat.isSymbolicLink() || !fileStat.isFile() || fileStat.nlink !== 1) {
    throw new Error('VOC_PATH_UNSAFE');
  }
  if (dirname(realpathSync(file)) !== dirReal) throw new Error('VOC_PATH_UNSAFE');
  return file;
}

/** Open a validated record without following a file swapped to a symlink
 * between lstat and read. */
export function readPendingVocFileNoFollow(file: string): string {
  let descriptor: number | null = null;
  try {
    descriptor = openSync(file, process.platform === 'win32'
      ? 'r'
      : fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    return readFileSync(descriptor, 'utf8');
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

/** Replace a validated record without opening the target for write. If the
 * target is swapped for a symlink, rename replaces that directory entry rather
 * than following it to another file. */
export function writePendingVocFileAtomic(file: string, content: string): void {
  const temporary = join(dirname(file), `.voc-edit-${randomUUID()}.tmp`);
  let descriptor: number | null = null;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    writeFileSync(descriptor, content, 'utf8');
    closeSync(descriptor);
    descriptor = null;
    renameSync(temporary, file);
  } finally {
    if (descriptor !== null) closeSync(descriptor);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}
