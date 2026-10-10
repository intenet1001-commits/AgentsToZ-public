/**
 * 휴대폰에서 보는 커뮤니티 — 1호 Mac 하나에만 원격으로 들어와도 다른 아젠투지들에게 말을 거는 길.
 *
 * 휴대폰은 한 Mac에만 붙는다. 그 Mac의 OPS가 커뮤니티에 들어가 있으면, 그 방이 곧 나머지 기기들과의
 * 통로다. 그래서 전용 원격 제어 동작을 새로 만들지 않고 **그 Mac의 커뮤니티를 보여 주고 거기에
 * 말하게** 한다. 받는 쪽은 각 기기의 OPS AI다.
 *
 * ⚠️ **새 기능 플래그를 쓰지 않는다.** 광고 목록 상한이 8개인데 이미 8개로 꽉 차 있고
 * (`terminal-refs-v1`·`workspace-v1`·`voc-v1`·`voc-inbox-v1`·`tester-v1`·`voice-v1`·tasks·conversation),
 * 9번째를 실으면 옛 휴대폰이 **목록 전체를 거부**한다. 그래서 기존 `workspace-v1` 채널에 동작만
 * 얹고, 모르는 Mac은 「지원하지 않는 모바일 작업」으로 거절한다 — 화면이 그것을 「Mac 앱 업데이트
 * 필요」로 옮겨 말한다.
 *
 * ⚠️ 응답은 릴레이 한 통(8,500바이트)에 들어가야 한다. 참여자와 메시지를 여기서 잘라 둔다.
 */
export const REMOTE_COMMUNITY_MEMBER_LIMIT = 12;
export const REMOTE_COMMUNITY_MESSAGE_LIMIT = 5;
export const REMOTE_COMMUNITY_TEXT_LIMIT = 240;
/**
 * 맥이 **자기 사이드카와 loopback으로** 말할 때의 한도. 휴대폰의 5건·240자는 릴레이 평문 예산
 * (11,000바이트)에서 나온 숫자이고, 관리 경로의 응답 상한은 1MiB다 — 맥이 그 예산을 쓸 이유가 없다.
 * 5건 예산에서는 12초 창에 6건이 몰리면 앞쪽이 밀리고, 240자에서는 긴 보고가 통째로 잘렸다.
 * ⚠️ 와이어 **모양**은 같다(새 키 없음) — 담는 양만 다르다. 그래서 옛 휴대폰 정규화기와 호환된다.
 */
export const LOCAL_COMMUNITY_MESSAGE_LIMIT = 40;
export const LOCAL_COMMUNITY_TEXT_LIMIT = 4_000;
export interface RemoteCommunityLimits {
  /** 한 응답에 싣는 메시지 수. */
  messages?: number;
  /** 메시지 하나의 글자 수. */
  text?: number;
}
const limitsOf = (limits?: RemoteCommunityLimits) => ({
  messages: Math.max(1, Math.min(200, Math.floor(limits?.messages ?? REMOTE_COMMUNITY_MESSAGE_LIMIT))),
  text: Math.max(40, Math.min(20_000, Math.floor(limits?.text ?? REMOTE_COMMUNITY_TEXT_LIMIT))),
});
export const REMOTE_COMMUNITY_SEND_LIMIT = 2_000;
/**
 * 이 payload가 쓸 수 있는 바이트. 워크스페이스 응답 전체 상한이 8,500이고 봉투와 다른 키가 함께
 * 들어가므로 여유를 둔다. ⚠️ 한글은 UTF-8에서 글자당 3바이트다 — 글자 수로 세면 넘는다
 * (실측: 참여자 16명 + 메시지 8건 × 400자 = 12,053바이트).
 */
export const REMOTE_COMMUNITY_BUDGET_BYTES = 6_000;
/** 휴대폰에서 몰 수 있는 다른 아젠투지 수. 한 방의 참여자보다 적게 잡아 응답 예산을 지킨다. */
export const REMOTE_COMMUNITY_DEVICE_LIMIT = 8;

export interface RemoteCommunityMember {
  name: string;
  kind: 'ops' | 'project';
  self: boolean;
}

/**
 * 휴대폰이 몰 수 있는 다른 아젠투지 한 대. `ref`는 불투명 참조이고(`src/communityDeviceRef.ts`)
 * endpointId·deviceId는 싣지 않는다. 기기 하나에 한 줄이다 — 그 기기의 OPS가 대표한다.
 */
export interface RemoteCommunityDevice {
  ref: string;
  name: string;
  kind: 'ops' | 'project';
}

export interface RemoteCommunityMessage {
  seq: number;
  from: string;
  self: boolean;
  kind: string;
  text: string;
  at: string;
  truncated?: boolean;
}

export interface RemoteCommunityState {
  inside: boolean;
  /** 이 Mac이 아직 단체방에 들어가지 않았으면 null. */
  roomId: string | null;
  unread: number;
  members: RemoteCommunityMember[];
  messages: RemoteCommunityMessage[];
  /** 다음에 이어 읽을 위치. */
  nextSeq: number;
  /** 잘려 나간 참여자 수 — 숨긴 것을 숨기지 않는다. */
  moreMembers?: number;
  /** 이 Mac을 거쳐 워크룸을 몰 수 있는 다른 기기들. 이 Mac이 입장해 있지 않으면 빈 배열이다. */
  devices: RemoteCommunityDevice[];
}

/** 참조의 모양만 본다 — 유도는 호스트 전용(`src/communityDeviceRef.ts`)이라 여기 두지 않는다. */
export function isCommunityDeviceRef(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{16}$/.test(value);
}

const text = (value: unknown, max: number): string =>
  typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';

/** 사람이 읽을 이름만 남긴다. endpointId·participantId·deviceId는 휴대폰으로 보내지 않는다. */
export function remoteCommunityState(input: {
  inside?: unknown; roomId?: unknown; unread?: unknown; nextSeq?: unknown;
  members?: unknown; messages?: unknown; devices?: unknown;
  selfParticipantId?: unknown; selfEndpointId?: unknown;
}, limits?: RemoteCommunityLimits): RemoteCommunityState {
  const bound = limitsOf(limits);
  const selfEndpoint = typeof input.selfEndpointId === 'string' ? input.selfEndpointId : null;
  const selfParticipant = typeof input.selfParticipantId === 'string' ? input.selfParticipantId : null;
  const rawMembers = Array.isArray(input.members) ? input.members : [];
  const members: RemoteCommunityMember[] = [];
  for (const row of rawMembers) {
    const value = row as Record<string, unknown>;
    const name = text(value.displayName, 80);
    if (!name) continue;
    members.push({
      name,
      kind: value.kind === 'project' ? 'project' : 'ops',
      self: selfEndpoint !== null && value.endpointId === selfEndpoint,
    });
    if (members.length >= REMOTE_COMMUNITY_MEMBER_LIMIT) break;
  }
  const byParticipant = new Map<string, string>();
  for (const row of rawMembers) {
    const value = row as Record<string, unknown>;
    if (typeof value.participantId === 'string') byParticipant.set(value.participantId, text(value.displayName, 80));
  }
  const messages: RemoteCommunityMessage[] = [];
  // ⚠️ 읽어 온 것보다 **덜 싣는다**(한 번에 5건). 그런데 커서를 읽은 끝까지 밀면 싣지 못한 줄은
  // 영원히 사라진다 — 다음 읽기가 그 뒤부터 가져오기 때문이다. 그래서 아래에서 커서를 **실제로 실은
  // 마지막 줄**까지만 전진시킨다(와이어 모양은 그대로 — 새 키를 만들지 않는다).
  // ⚠️ 읽기는 커서 뒤의 **가장 오래된** 줄부터 오름차순으로 온다(SQL `order by seq limit 7`). 그래서
  // 앞쪽(오래된 것)을 싣고 뒤쪽을 다음 읽기로 넘긴다. 뒤를 실으면 앞쪽이 커서 뒤로 영영 사라진다.
  const rawMessages = Array.isArray(input.messages) ? input.messages : [];
  const carriedRaw = rawMessages.slice(0, bound.messages);
  for (const row of carriedRaw) {
    const value = row as Record<string, unknown>;
    if (value.kind !== 'message') continue;
    const body = typeof value.text === 'string' ? value.text : '';
    const sender = typeof value.senderParticipantId === 'string' ? value.senderParticipantId : '';
    const shown = text(body, bound.text);
    messages.push({
      seq: Number.isSafeInteger(value.seq) ? Number(value.seq) : 0,
      from: byParticipant.get(sender) || '알 수 없는 참여자',
      self: selfParticipant !== null && sender === selfParticipant,
      kind: text(value.messageKind, 20) || 'message',
      text: shown,
      at: text(value.createdAt, 40),
      ...(body.length > shown.length ? { truncated: true } : {}),
    });
  }
  const devices: RemoteCommunityDevice[] = [];
  for (const row of Array.isArray(input.devices) ? input.devices : []) {
    const value = row as Record<string, unknown>;
    const name = text(value.name, 60);
    if (!isCommunityDeviceRef(value.ref) || !name) continue;
    devices.push({ref: value.ref, name, kind: value.kind === 'project' ? 'project' : 'ops'});
    if (devices.length >= REMOTE_COMMUNITY_DEVICE_LIMIT) break;
  }
  const unread = Number.isSafeInteger(input.unread) && Number(input.unread) > 0 ? Number(input.unread) : 0;
  const build = (kept: RemoteCommunityMessage[]): RemoteCommunityState => ({
    inside: input.inside === true,
    roomId: typeof input.roomId === 'string' ? input.roomId : null,
    unread,
    members,
    devices,
    messages: kept,
    nextSeq: carriedNextSeq(input.nextSeq, rawMessages, carriedRaw, messages, kept),
    ...(rawMembers.length > members.length ? { moreMembers: rawMembers.length - members.length } : {}),
  });
  // 상수만으로는 못 지킨다 — 이름이 길거나 글이 한글이면 같은 개수에서도 바이트가 배로 뛴다.
  // 예산을 넘으면 **뒤쪽(새 것)부터** 다음 읽기로 미룬다 — 커서가 실은 줄까지만 가므로 잃지 않는다.
  // 한 건은 늘 싣는다(그래야 커서가 앞으로 간다).
  let kept = messages;
  while (kept.length > 1
    && new TextEncoder().encode(JSON.stringify(build(kept))).length > REMOTE_COMMUNITY_BUDGET_BYTES) {
    kept = kept.slice(0, -1);
  }
  return build(kept);
}

/**
 * 다음에 이어 읽을 자리. 실은 것보다 더 읽었으면 **실은 마지막 줄의 seq**까지만 전진한다 —
 * 그래야 싣지 못한 줄이 다음 읽기에 들어온다. 12초 창에 6건 넘게 몰리면 앞쪽이 조용히 사라졌다.
 */
function carriedNextSeq(raw: unknown, rawMessages: readonly unknown[], carriedRaw: readonly unknown[],
  built: readonly RemoteCommunityMessage[], kept: readonly RemoteCommunityMessage[]): number {
  const full = Number.isSafeInteger(raw) && Number(raw) > 0 ? Number(raw) : 0;
  const seqOf = (row: unknown) => { const seq = (row as Record<string, unknown>)?.seq; return Number.isSafeInteger(seq) && Number(seq) > 0 ? Number(seq) : 0; };
  // Byte budget held some messages back: resume right after the last one actually shown.
  if (kept.length < built.length) { const last = kept.at(-1)?.seq ?? 0; return last > 0 ? Math.min(full || last, last) : full; }
  if (carriedRaw.length === rawMessages.length) return full;
  // The count limit held rows back: resume after the last row looked at (non-message events included).
  const last = seqOf(carriedRaw.at(-1));
  return last > 0 ? Math.min(full || last, last) : full;
}

/** 휴대폰이 보낸 글. 비어 있거나 제어문자가 섞이면 거절한다. */
export function normalizeRemoteCommunityText(value: unknown): string {
  if (typeof value !== 'string') throw new Error('보낼 내용을 확인하세요.');
  const trimmed = value.replace(/\r\n?/g, '\n').trim();
  if (!trimmed || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(trimmed)) throw new Error('보낼 내용을 확인하세요.');
  if (new TextEncoder().encode(trimmed).length > REMOTE_COMMUNITY_SEND_LIMIT) throw new Error('보낼 내용이 너무 깁니다.');
  return trimmed;
}

/**
 * 휴대폰이 받은 payload 검사. `remoteCommunityState`는 **호스트의 원본**(displayName·participantId가
 * 든 DB 행)을 깎는 함수이고, 이것은 **이미 깎여서 온 것**이 규격에 맞는지 보는 함수다. 둘을 하나로
 * 쓰면 모양이 달라 참여자와 메시지가 통째로 사라진다.
 */
export function normalizeRemoteCommunityState(value: unknown, limits?: RemoteCommunityLimits): RemoteCommunityState {
  const bound = limitsOf(limits);
  const fail = (): never => { throw new Error('커뮤니티 응답 형식이 올바르지 않습니다.'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const v = value as Record<string, unknown>;
  const allowed = ['inside', 'roomId', 'unread', 'members', 'devices', 'messages', 'nextSeq', 'moreMembers'];
  if (Object.keys(v).some(key => !allowed.includes(key))) return fail();
  const count = (x: unknown, max: number): boolean => Number.isSafeInteger(x) && Number(x) >= 0 && Number(x) <= max;
  if (typeof v.inside !== 'boolean' || !(v.roomId === null || typeof v.roomId === 'string' && /^[0-9a-f-]{36}$/.test(v.roomId))) return fail();
  if (!count(v.unread, 1_000_000) || !count(v.nextSeq, 2_000_000)) return fail();
  if (v.moreMembers !== undefined && (!count(v.moreMembers, 10_000) || Number(v.moreMembers) === 0)) return fail();
  if (!Array.isArray(v.members) || v.members.length > REMOTE_COMMUNITY_MEMBER_LIMIT) return fail();
  const members = v.members.map(row => {
    const member = row as Record<string, unknown>;
    if (typeof member.name !== 'string' || !member.name || member.name.length > 80
      || (member.kind !== 'ops' && member.kind !== 'project') || typeof member.self !== 'boolean'
      || Object.keys(member).some(key => !['name', 'kind', 'self'].includes(key))) return fail();
    return {name: member.name, kind: member.kind, self: member.self} as RemoteCommunityMember;
  });
  if (!Array.isArray(v.devices) || v.devices.length > REMOTE_COMMUNITY_DEVICE_LIMIT) return fail();
  const devices = v.devices.map(row => {
    const device = row as Record<string, unknown>;
    if (!isCommunityDeviceRef(device.ref) || typeof device.name !== 'string' || !device.name || device.name.length > 60
      || (device.kind !== 'ops' && device.kind !== 'project')
      || Object.keys(device).some(key => !['ref', 'name', 'kind'].includes(key))) return fail();
    return {ref: device.ref, name: device.name, kind: device.kind} as RemoteCommunityDevice;
  });
  if (!Array.isArray(v.messages) || v.messages.length > bound.messages) return fail();
  const messages = v.messages.map(row => {
    const message = row as Record<string, unknown>;
    if (!count(message.seq, 2_000_000) || typeof message.from !== 'string' || message.from.length > 80
      || typeof message.self !== 'boolean' || typeof message.kind !== 'string' || message.kind.length > 20
      || typeof message.text !== 'string' || message.text.length > bound.text
      || typeof message.at !== 'string' || message.at.length > 40
      || (message.truncated !== undefined && message.truncated !== true)
      || Object.keys(message).some(key => !['seq', 'from', 'self', 'kind', 'text', 'at', 'truncated'].includes(key))) return fail();
    return {seq: Number(message.seq), from: message.from, self: message.self, kind: message.kind,
      text: message.text, at: message.at, ...(message.truncated ? {truncated: true as const} : {})};
  });
  return {inside: v.inside, roomId: (v.roomId ?? null) as string | null, unread: Number(v.unread),
    members, devices, messages, nextSeq: Number(v.nextSeq),
    ...(v.moreMembers !== undefined ? {moreMembers: Number(v.moreMembers)} : {})};
}

/** 한 장에 보내는 다른 아젠투지의 프로젝트 수. 릴레이 한 통에 들어가도록 주 목록과 같은 20이다. */
export const REMOTE_COMMUNITY_PROJECT_PAGE = 20;
/** 다른 아젠투지의 프로젝트 한 장. 그 기기의 워크룸을 새로 열 때 쓰는 targetId는 그 기기의 것이다. */
export interface RemoteCommunityProjects {
  deviceName: string;
  opsTargetId: string | null;
  projects: {targetId: string; label: string}[];
  page: number;
  hasMore: boolean;
  total: number;
}
const projectId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_:.-]{8,160}$/.test(value);
/** 호스트가 다른 기기의 답을 깎는다. 한 장만 싣고, 남은 장은 `hasMore`로 말한다. */
export function remoteCommunityProjects(input: unknown, page: number): RemoteCommunityProjects {
  const value = (input ?? {}) as Record<string, unknown>;
  const rows = (Array.isArray(value.projects) ? value.projects : [])
    .map(row => row as Record<string, unknown>)
    .filter(row => projectId(row.targetId) && typeof row.label === 'string' && row.label.trim())
    .map(row => ({targetId: String(row.targetId), label: text(row.label, 60)}));
  const start = Math.max(0, Math.floor(page)) * REMOTE_COMMUNITY_PROJECT_PAGE;
  return {
    deviceName: text(value.deviceName, 60) || '다른 아젠투지',
    opsTargetId: projectId(value.opsTargetId) ? String(value.opsTargetId) : null,
    projects: rows.slice(start, start + REMOTE_COMMUNITY_PROJECT_PAGE),
    page: Math.max(0, Math.floor(page)),
    hasMore: rows.length > start + REMOTE_COMMUNITY_PROJECT_PAGE,
    total: rows.length,
  };
}
/** 휴대폰이 받은 장. 모양만 본다. */
export function normalizeRemoteCommunityProjects(value: unknown): RemoteCommunityProjects {
  const fail = (): never => { throw new Error('다른 아젠투지의 프로젝트 목록 형식이 올바르지 않습니다.'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(key => !['deviceName', 'opsTargetId', 'projects', 'page', 'hasMore', 'total'].includes(key))) return fail();
  if (typeof v.deviceName !== 'string' || !v.deviceName || v.deviceName.length > 60) return fail();
  if (!(v.opsTargetId === null || projectId(v.opsTargetId))) return fail();
  if (typeof v.hasMore !== 'boolean' || !Number.isSafeInteger(v.page) || Number(v.page) < 0 || Number(v.page) > 500) return fail();
  if (!Number.isSafeInteger(v.total) || Number(v.total) < 0 || Number(v.total) > 100_000) return fail();
  if (!Array.isArray(v.projects) || v.projects.length > REMOTE_COMMUNITY_PROJECT_PAGE) return fail();
  const projects = v.projects.map(row => {
    const project = row as Record<string, unknown>;
    if (!projectId(project.targetId) || typeof project.label !== 'string' || !project.label || project.label.length > 60
      || Object.keys(project).some(key => !['targetId', 'label'].includes(key))) return fail();
    return {targetId: String(project.targetId), label: project.label};
  });
  return {deviceName: v.deviceName, opsTargetId: (v.opsTargetId ?? null) as string | null,
    projects, page: Number(v.page), hasMore: v.hasMore, total: Number(v.total)};
}

/**
 * 화면이 들고 있는 것 + 방금 온 것. ⚠️ 응답의 메시지는 **커서 뒤의 새 것**뿐이라 그대로 덮어쓰면
 * 따라잡은 뒤의 폴링 한 번에 목록이 비어 「메시지가 사라졌다」가 된다. seq로 중복을 지우고 최근
 * 몇 건만 남긴다(상한은 한 번에 받는 수와 같다).
 */
export function mergeRemoteCommunityMessages(
  held: readonly RemoteCommunityMessage[],
  arrived: readonly RemoteCommunityMessage[],
  limit = REMOTE_COMMUNITY_MESSAGE_LIMIT,
): RemoteCommunityMessage[] {
  const bySeq = new Map<number, RemoteCommunityMessage>();
  for (const message of [...held, ...arrived]) bySeq.set(message.seq, message);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq).slice(-limit);
}

/** 휴대폰 화면이 들고 있는 대화 줄 수 — 한 번에 받는 수(5)와 별개다. 받는 수로 자르면 화면에 늘 5줄뿐이었다. */
export const REMOTE_COMMUNITY_HISTORY_LIMIT = 30;

/** 한 기기에 동시에 보낼 수 있는 전달 요청 수. 넘으면 **기다리지 않고** 거절한다. */
export const REMOTE_COMMUNITY_FORWARD_INFLIGHT_LIMIT = 2;
export const REMOTE_COMMUNITY_FORWARD_BUSY_ERROR =
  '다른 아젠투지가 답하기를 기다리는 중입니다. 잠시 후 다시 시도하세요.';

/**
 * 전달 요청의 동시 개수를 묶는 문(gate).
 *
 * ⚠️ 휴대폰 릴레이는 요청을 **하나씩** 처리한다. 다른 아젠투지로 가는 요청은 그 Mac이 우편함을
 * 가져갈 때까지(유휴 3초) 걸리고, 답하지 않는 Mac이면 마감까지 그 자리를 잡는다. 그 동안 워크룸
 * 화면의 배경 조회(`list`·`read`)가 계속 줄을 서면 릴레이 대기열 32개 상한에 걸려
 * 「대기 중인 원격 입력이 많습니다」로 바뀌고, **실제 원인(그 Mac이 답하지 않음)이 가려진다**
 * (2026-10-05 아이폰 17 실기: 기기를 고른 직후 프로젝트 목록이 비고 그 문구만 떴다).
 *
 * 그래서 넘치는 요청은 쌓지 않고 바로 거절한다 — 배경 조회는 다음 주기에 다시 온다.
 */
export function createCommunityForwardGate(limit = REMOTE_COMMUNITY_FORWARD_INFLIGHT_LIMIT) {
  let inFlight = 0;
  return {
    get inFlight() { return inFlight; },
    async run<T>(work: () => Promise<T>): Promise<T> {
      if (inFlight >= limit) throw new Error(REMOTE_COMMUNITY_FORWARD_BUSY_ERROR);
      inFlight += 1;
      try { return await work(); } finally { inFlight -= 1; }
    },
  };
}

/**
 * 「MM-DD HH:mm」 in the viewer's own time zone. The phone printed `at.slice(5,16)` of the UTC ISO string,
 * so a message sent at 19:04 in Seoul read 「10-07 10:04」 (iPhone, 2026-10-07).
 */
export function communityMessageTime(at: string): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
