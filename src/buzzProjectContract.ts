export const DEFAULT_BUZZ_RELAY_URL = "ws://localhost:3000";

const BUZZ_CHANNEL_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isBuzzChannelId(input: unknown): boolean {
  return typeof input === "string" && BUZZ_CHANNEL_UUID_RE.test(input.trim());
}

export interface BuzzChannelSummary {
  channelId: string;
  name: string;
  description: string | null;
}

export function normalizeBuzzRelayUrl(input: unknown): string {
  const raw = typeof input === "string" && input.trim()
    ? input.trim()
    : DEFAULT_BUZZ_RELAY_URL;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Buzz relay URL이 유효하지 않습니다.");
  }
  if (url.protocol === "http:") url.protocol = "ws:";
  else if (url.protocol === "https:") url.protocol = "wss:";
  else if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error("Buzz relay URL은 http(s):// 또는 ws(s):// 이어야 합니다.");
  }
  if (url.username || url.password) {
    throw new Error("Buzz relay URL에 인증정보를 넣지 마세요.");
  }
  if (url.search) throw new Error("Buzz relay URL에 query 값을 넣지 마세요.");
  if (url.hash) throw new Error("Buzz relay URL에 fragment 값을 넣지 마세요.");
  const normalizedPath = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "");
  return `${url.protocol}//${url.host}${normalizedPath}`;
}

export function normalizeBuzzChannelId(input: unknown): string {
  const value = typeof input === "string" ? input.trim() : "";
  if (!isBuzzChannelId(value)) {
    throw new Error("Buzz channel ID는 UUID 형식이어야 합니다.");
  }
  return value.toLocaleLowerCase();
}

export function normalizeBuzzChannelName(input: unknown): string {
  const value = typeof input === "string"
    ? input.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim()
    : "";
  if (!value) throw new Error("Buzz 채널 이름이 필요합니다.");
  return Array.from(value).slice(0, 64).join("");
}

export function buildBuzzChannelCreateArgs(input: {
  name: unknown;
  description: unknown;
}): string[] {
  const name = normalizeBuzzChannelName(input.name);
  const description = typeof input.description === "string"
    ? input.description.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 240)
    : "";
  return [
    "channels", "create",
    "--name", name,
    "--type", "stream",
    "--visibility", "open",
    "--description", description,
  ];
}

function channelFromUnknown(value: unknown): BuzzChannelSummary | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const rawId = row.channel_id ?? row.channelId ?? row.id;
  let channelId: string;
  try {
    channelId = normalizeBuzzChannelId(rawId);
  } catch {
    return null;
  }
  const name = typeof row.name === "string" && row.name.trim()
    ? normalizeBuzzChannelName(row.name)
    : channelId;
  const description = typeof row.description === "string" && row.description.trim()
    ? row.description.trim()
    : null;
  return { channelId, name, description };
}

export function parseBuzzChannelListOutput(output: unknown): BuzzChannelSummary[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(typeof output === "string" ? output : "");
  } catch {
    throw new Error("Buzz channel 목록 응답이 JSON이 아닙니다.");
  }
  const rows = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>).channels)
      ? (parsed as { channels: unknown[] }).channels
      : null;
  if (!rows) throw new Error("Buzz channel 목록 응답 형식이 올바르지 않습니다.");
  return rows.map(channelFromUnknown).filter((item): item is BuzzChannelSummary => item !== null);
}

export function parseBuzzChannelCreateOutput(output: unknown): { channelId: string; accepted: boolean } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(typeof output === "string" ? output : "");
  } catch {
    throw new Error("Buzz channel 생성 응답이 JSON이 아닙니다.");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Buzz channel 생성 응답 형식이 올바르지 않습니다.");
  }
  const row = parsed as Record<string, unknown>;
  try {
    return {
      channelId: normalizeBuzzChannelId(row.channel_id ?? row.channelId),
      accepted: row.accepted === true,
    };
  } catch {
    throw new Error("Buzz channel 생성 응답에 유효한 channel_id가 없습니다.");
  }
}
