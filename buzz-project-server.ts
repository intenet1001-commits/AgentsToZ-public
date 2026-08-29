import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  buildBuzzChannelCreateArgs,
  normalizeBuzzChannelName,
  normalizeBuzzRelayUrl,
  parseBuzzChannelCreateOutput,
  parseBuzzChannelListOutput,
  type BuzzChannelSummary,
} from "./src/buzzProjectContract";

export class BuzzProjectError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status = 409,
  ) {
    super(message);
    this.name = "BuzzProjectError";
  }
}

export interface BuzzRuntimeInspection {
  appInstalled: boolean;
  appPath: string | null;
  cliInstalled: boolean;
  cliPath: string | null;
  relayUrl: string;
  relayReachable: boolean;
  cliAuthenticated: boolean | null;
  channelCount: number | null;
  problemCode: string | null;
  problem: string | null;
}

function existingFile(candidates: readonly string[]): string | null {
  for (const candidate of candidates) {
    if (!candidate || !isAbsolute(candidate) || !existsSync(candidate)) continue;
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Continue through known candidates.
    }
  }
  return null;
}

function existingDirectory(candidates: readonly string[]): string | null {
  for (const candidate of candidates) {
    if (!candidate || !isAbsolute(candidate) || !existsSync(candidate)) continue;
    try {
      if (statSync(candidate).isDirectory()) return candidate;
    } catch {
      // Continue through known candidates.
    }
  }
  return null;
}

export function resolveBuzzAppPath(): string | null {
  const home = homedir();
  if (process.platform === "darwin") {
    return existingDirectory([
      "/Applications/Buzz.app",
      join(home, "Applications", "Buzz.app"),
      "/Applications/Buzz Desktop.app",
      join(home, "Applications", "Buzz Desktop.app"),
    ]);
  }
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA ?? "";
    return existingFile([
      join(local, "Programs", "Buzz", "Buzz.exe"),
      join(local, "Buzz", "Buzz.exe"),
      join(local, "Programs", "Buzz", "buzz-desktop.exe"),
    ]);
  }
  return existingFile(["/usr/bin/buzz-desktop", "/usr/local/bin/buzz-desktop", "/opt/buzz/buzz"]);
}

function commandLookup(name: string): string | null {
  try {
    const command = process.platform === "win32" ? ["where", name] : ["/usr/bin/which", name];
    const result = Bun.spawnSync(command, { stdout: "pipe", stderr: "pipe", timeout: 3_000 });
    if (!result.success) return null;
    const candidate = (result.stdout?.toString() ?? "").split(/\r?\n/).map(value => value.trim()).find(Boolean) ?? "";
    return candidate && isAbsolute(candidate) && existsSync(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

export function resolveBuzzCliPath(): string | null {
  const explicit = typeof process.env.BUZZ_CLI_PATH === "string" ? process.env.BUZZ_CLI_PATH.trim() : "";
  const home = homedir();
  const known = existingFile([
    explicit,
    "/Applications/Buzz.app/Contents/Resources/bin/buzz",
    "/Applications/Buzz.app/Contents/MacOS/buzz-cli",
    join(home, "Applications", "Buzz.app", "Contents", "Resources", "bin", "buzz"),
    join(home, ".local", "bin", "buzz"),
    "/opt/homebrew/bin/buzz",
    "/usr/local/bin/buzz",
    "/usr/bin/buzz",
    ...(process.platform === "win32"
      ? [
          join(process.env.LOCALAPPDATA ?? "", "Programs", "Buzz", "buzz.exe"),
          join(process.env.APPDATA ?? "", "npm", "buzz.cmd"),
        ]
      : []),
  ]);
  return known ?? commandLookup(process.platform === "win32" ? "buzz.exe" : "buzz");
}

export function buzzRelayHealthUrl(relayUrl: string): string {
  const relay = new URL(normalizeBuzzRelayUrl(relayUrl));
  relay.protocol = relay.protocol === "wss:" ? "https:" : "http:";
  relay.pathname = `${relay.pathname.replace(/\/$/, "")}/health`;
  return relay.toString();
}

export async function probeBuzzRelay(relayUrl: string): Promise<boolean> {
  try {
    const response = await fetch(buzzRelayHealthUrl(relayUrl), {
      method: "GET",
      signal: AbortSignal.timeout(1_500),
      cache: "no-store",
    });
    return response.ok;
  } catch {
    return false;
  }
}

function redactDiagnostic(value: string): string {
  return value
    .replace(/nsec1[023456789acdefghjklmnpqrstuvwxyz]{20,}/gi, "[redacted]")
    .replace(/(BUZZ_PRIVATE_KEY\s*[=:]\s*)\S+/gi, "$1[redacted]")
    .trim()
    .slice(0, 500);
}

function cliFailure(exitCode: number, stderr: string): BuzzProjectError {
  const detail = redactDiagnostic(stderr);
  if (exitCode === 2) {
    return new BuzzProjectError("Buzz local relay에 연결할 수 없습니다. Buzz 앱/relay를 먼저 실행하세요.", "BUZZ_RELAY_UNREACHABLE");
  }
  if (exitCode === 3) {
    return new BuzzProjectError(
      "Buzz CLI 인증이 없습니다. 비밀키를 AgentsToZ 화면에 넣지 말고, 로컬 API 서버 환경에 BUZZ_PRIVATE_KEY를 설정하거나 기존 채널을 수동 연결하세요.",
      "BUZZ_CLI_AUTH_REQUIRED",
    );
  }
  if (exitCode === 5) {
    return new BuzzProjectError(detail || "Buzz channel 작업이 기존 상태와 충돌했습니다.", "BUZZ_CHANNEL_CONFLICT");
  }
  return new BuzzProjectError(detail || `Buzz CLI가 종료 코드 ${exitCode}로 실패했습니다.`, "BUZZ_CLI_FAILED", 500);
}

function runBuzzCli(relayUrl: string, args: string[]): string {
  const cli = resolveBuzzCliPath();
  if (!cli) {
    throw new BuzzProjectError("Buzz CLI를 찾지 못했습니다. Buzz Desktop/CLI를 설치한 뒤 다시 확인하세요.", "BUZZ_CLI_NOT_FOUND");
  }
  let result: ReturnType<typeof Bun.spawnSync>;
  try {
    result = Bun.spawnSync([cli, ...args], {
      env: { ...process.env, BUZZ_RELAY_URL: normalizeBuzzRelayUrl(relayUrl) },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 8_000,
    });
  } catch (error) {
    throw new BuzzProjectError(
      `Buzz CLI를 실행하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`,
      "BUZZ_CLI_EXEC_FAILED",
      500,
    );
  }
  if (!result.success) throw cliFailure(result.exitCode ?? 4, result.stderr?.toString() ?? "");
  return (result.stdout?.toString() ?? "").trim();
}

function parseJsonWithCliPrelude<T>(output: string, parse: (candidate: string) => T): T {
  try {
    return parse(output);
  } catch (firstError) {
    for (const match of output.matchAll(/^[\t ]*([\[{])/gm)) {
      const offset = (match.index ?? 0) + match[0].lastIndexOf(match[1]!);
      try {
        return parse(output.slice(offset).trim());
      } catch {
        // Try another JSON-looking line.
      }
    }
    throw firstError;
  }
}

export function listBuzzChannels(relayUrl: string): BuzzChannelSummary[] {
  const output = runBuzzCli(relayUrl, ["channels", "list"]);
  return parseJsonWithCliPrelude(output, parseBuzzChannelListOutput);
}

export function createBuzzChannel(input: {
  relayUrl: string;
  name: string;
  description: string;
}): { channelId: string; accepted: boolean } {
  const output = runBuzzCli(
    input.relayUrl,
    buildBuzzChannelCreateArgs({ name: input.name, description: input.description }),
  );
  return parseJsonWithCliPrelude(output, parseBuzzChannelCreateOutput);
}

export function findBuzzChannelByName(channels: readonly BuzzChannelSummary[], name: string): BuzzChannelSummary | null {
  const normalized = normalizeBuzzChannelName(name).normalize("NFKC").toLocaleLowerCase();
  return channels.find(channel => channel.name.normalize("NFKC").toLocaleLowerCase() === normalized) ?? null;
}

export async function inspectBuzzRuntime(relayInput: unknown): Promise<BuzzRuntimeInspection> {
  const relayUrl = normalizeBuzzRelayUrl(relayInput);
  const appPath = resolveBuzzAppPath();
  const cliPath = resolveBuzzCliPath();
  const relayReachable = await probeBuzzRelay(relayUrl);
  let cliAuthenticated: boolean | null = null;
  let channelCount: number | null = null;
  let problemCode: string | null = null;
  let problem: string | null = null;
  if (cliPath && relayReachable) {
    try {
      const channels = listBuzzChannels(relayUrl);
      cliAuthenticated = true;
      channelCount = channels.length;
    } catch (error) {
      if (error instanceof BuzzProjectError) {
        cliAuthenticated = error.code === "BUZZ_CLI_AUTH_REQUIRED" ? false : null;
        problemCode = error.code;
        problem = error.message;
      } else {
        problemCode = "BUZZ_STATUS_FAILED";
        problem = error instanceof Error ? error.message : String(error);
      }
    }
  }
  return {
    appInstalled: appPath !== null,
    appPath,
    cliInstalled: cliPath !== null,
    cliPath,
    relayUrl,
    relayReachable,
    cliAuthenticated,
    channelCount,
    problemCode,
    problem,
  };
}

export function openBuzzApp(): void {
  const appPath = resolveBuzzAppPath();
  if (!appPath) {
    throw new BuzzProjectError("Buzz Desktop을 찾지 못했습니다. 먼저 설치하세요.", "BUZZ_APP_NOT_FOUND");
  }
  if (process.platform === "darwin") {
    const result = Bun.spawnSync(["/usr/bin/open", appPath], { stdout: "ignore", stderr: "pipe", timeout: 5_000 });
    if (!result.success) throw new BuzzProjectError(redactDiagnostic(result.stderr?.toString() ?? "") || "Buzz 앱을 열지 못했습니다.", "BUZZ_APP_OPEN_FAILED", 500);
    return;
  }
  if (process.platform === "win32") {
    const child = Bun.spawn([appPath], { stdout: "ignore", stderr: "ignore" });
    child.unref();
    return;
  }
  const child = Bun.spawn([appPath], { stdout: "ignore", stderr: "ignore" });
  child.unref();
}
