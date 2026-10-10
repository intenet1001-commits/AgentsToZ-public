import { lstatSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const directorySymlinkType = process.platform === "win32" ? "junction" : "dir";

export const canCreateFileSymlinks = (() => {
  const root = mkdtempSync(join(tmpdir(), "agentstoz-file-symlink-probe-"));
  const target = join(root, "target.txt");
  const link = join(root, "link.txt");
  try {
    writeFileSync(target, "probe");
    symlinkSync(target, link, "file");
    return lstatSync(link).isSymbolicLink();
  } catch {
    return false;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
})();
