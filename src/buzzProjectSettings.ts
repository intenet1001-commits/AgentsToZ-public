import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { DEFAULT_BUZZ_RELAY_URL, normalizeBuzzRelayUrl } from "./buzzProjectContract";

export interface BuzzProjectSettings {
  version: 1;
  relayUrl: string;
  updatedAt: string | null;
}

export function loadBuzzProjectSettings(file: string): BuzzProjectSettings {
  if (!existsSync(file)) {
    return { version: 1, relayUrl: DEFAULT_BUZZ_RELAY_URL, updatedAt: null };
  }
  const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  if (parsed.version !== 1) throw new Error("Buzz 프로젝트 설정 버전을 읽을 수 없습니다.");
  return {
    version: 1,
    relayUrl: normalizeBuzzRelayUrl(parsed.relayUrl),
    updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : null,
  };
}

export function saveBuzzProjectSettings(
  file: string,
  input: { relayUrl: unknown },
): BuzzProjectSettings {
  const settings: BuzzProjectSettings = {
    version: 1,
    relayUrl: normalizeBuzzRelayUrl(input.relayUrl),
    updatedAt: new Date().toISOString(),
  };
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
  return settings;
}
