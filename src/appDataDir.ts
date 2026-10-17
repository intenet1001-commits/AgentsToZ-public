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

/**
 * Resolve the sidecar's app-data root before its bootstrap environment is
 * scrubbed. An invalid explicit override must fail closed instead of silently
 * falling back to the real user profile and contaminating production data.
 */
export function resolveAppDataDirFromEnvironment(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const override = env.APP_DATA_DIR;
  if (override === undefined) return resolveAppDataDir(platform, env, home);
  if (!override || override.includes('\0')) {
    throw new Error('APP_DATA_DIR must be a safe absolute directory');
  }

  const pathApi = platform === 'win32' ? win32 : posix;
  if (!pathApi.isAbsolute(override)) {
    throw new Error('APP_DATA_DIR must be a safe absolute directory');
  }
  const normalized = pathApi.normalize(override);
  const root = pathApi.parse(normalized).root;
  if (normalized === root || (platform === 'win32' && root === '\\')) {
    throw new Error('APP_DATA_DIR must not be a filesystem root');
  }
  return normalized;
}
