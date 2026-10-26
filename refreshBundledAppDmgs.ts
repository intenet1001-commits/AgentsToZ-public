import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Tauri's DMG precedes companion staging. Recreate it from the final app without reusing a stale image. */
export async function refreshBundledAppDmgs(app: string, dmgs: readonly string[]): Promise<void> {
  for (const destination of dmgs) {
    const workspace = mkdtempSync(join(dirname(destination), '.complete-dmg-'));
    const scratch = join(workspace, 'root');
    const image = join(workspace, 'complete.dmg');
    try {
      mkdirSync(scratch);
      const copy = Bun.spawn(['ditto', app, join(scratch, 'AgentsToZ_byCS.app')], { stdout: 'inherit', stderr: 'inherit' });
      if (await copy.exited !== 0) throw Error('Complete app DMG staging failed');
      symlinkSync('/Applications', join(scratch, 'Applications'));
      const create = Bun.spawn(['hdiutil', 'create', '-volname', 'AgentsToZ_byCS', '-srcfolder', scratch,
        '-fs', 'HFS+', '-format', 'UDZO', '-ov', image], { stdout: 'inherit', stderr: 'inherit' });
      if (await create.exited !== 0) throw Error('Complete app DMG creation failed');
      renameSync(image, destination);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  }
}
