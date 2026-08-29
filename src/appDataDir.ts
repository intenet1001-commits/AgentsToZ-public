import { homedir } from "node:os";
import { posix, win32 } from "node:path";

export function resolveAppDataDir(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  if (platform === "win32") {
    return win32.join(
      env.APPDATA || win32.join(home, "AppData", "Roaming"),
      "com.portmanager.portmanager",
    );
  }
  if (platform === "darwin") {
    return posix.join(home, "Library/Application Support/com.portmanager.portmanager");
  }
  return posix.join(
    env.XDG_CONFIG_HOME || posix.join(home, ".config"),
    "com.portmanager.portmanager",
  );
}
