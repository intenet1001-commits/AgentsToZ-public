import {workroomMentionQuery, type WorkroomMentionKind, type WorkroomMentionProject} from './workroomProjectMention';

/**
 * 커뮤니티 차원의 `@`·`#` — 「아젠투지2호 @프로젝트」.
 *
 * `@`·`#`는 원래 **이 기기의** 등록 프로젝트만 가리켰다. 커뮤니티에 들어온 다른 아젠투지의
 * 워크룸도 같은 화면에서 쓸 수 있게 됐으므로(「기기」 탭), 기호 바로 앞에 기기 이름을 적으면
 * 그 기기의 프로젝트가 후보가 된다. 기기 이름이 없으면 예전 그대로 이 기기의 목록이다.
 *
 * ⚠️ **모호하면 아무 기기도 고르지 않는다.** 잘못 고르면 다른 Mac에 일이 들어가므로, 이름이
 * 두 기기에 걸리면 그 길이에서는 포기하고 더 짧은 후보를 본다(끝까지 모호하면 기기 없음).
 *
 * ⚠️ **`#` 참고 폴더는 받는 쪽 호스트가 푼다.** 그래서 참고는 기기별로 기억하고, 전달할 때는
 * **받는 기기와 같은 기기의 참고만** 폴더로 넘긴다. 다른 기기의 참고는 글 안의 이름으로만 간다.
 */
export interface CommunityMentionDevice {
  /** 화면 안에서만 쓰는 손잡이(데스크톱은 deviceId, 휴대폰은 불투명 참조). */
  deviceId: string;
  label: string;
}
export interface CommunityMentionDeviceProjects extends CommunityMentionDevice {
  /** 아직 받지 못했으면 `undefined` — 「없음」과 구분한다. */
  projects?: readonly WorkroomMentionProject[];
  error?: string;
  /** 받은 것이 목록의 일부일 때(휴대폰은 한 장 20개씩 받는다). */
  hasMore?: boolean;
}
export interface CommunityMentionTargets {
  local: readonly WorkroomMentionProject[];
  devices: readonly CommunityMentionDeviceProjects[];
}

const projectKey = (value: string) => value.normalize('NFKC').toLocaleLowerCase().trim();
/** 기기 이름은 공백·가운뎃점·대시를 무시하고 맞춘다 — 「아젠투지 2호」와 「아젠투지2호」는 같은 기기다. */
const deviceKey = (value: string) => value.normalize('NFKC').toLocaleLowerCase().replace(/[\s·_/-]+/gu, '');
/**
 * 맞춰 볼 이름들: 이름 전체와 그 **조각**(공백·대시·가운뎃점·슬래시로 나눈 것). 실측 기기 이름이
 * 「아젠투지3호-회사」라서, 전체 이름의 꼬리만 보면 사람이 부르는 `3호`가 걸리지 않는다.
 */
const deviceKeys = (label: string): string[] => {
  const keys = [deviceKey(label)];
  for (const piece of label.split(/[\s·_/-]+/u)) {
    const key = deviceKey(piece);
    if (key && !keys.includes(key)) keys.push(key);
  }
  return keys.filter(Boolean);
};

/**
 * 기호 앞의 글이 커뮤니티 기기를 가리키는지. 뒤에서부터 최대 세 단어까지 본다(「아젠투지 2호 @」).
 * 기기 이름의 **꼬리**만 적어도 된다(`2호` → `아젠투지2호`) — 사람이 부르는 방식이다.
 */
export function communityMentionDevice(
  before: string,
  devices: readonly CommunityMentionDeviceProjects[],
): {device: CommunityMentionDeviceProjects; start: number} | null {
  const trimmed = before.replace(/\s+$/u, '');
  if (!trimmed || !devices.length) return null;
  const starts: number[] = [];
  const words = /\S+/gu;
  for (let match = words.exec(trimmed); match; match = words.exec(trimmed)) starts.push(match.index);
  for (let take = Math.min(3, starts.length); take >= 1; take--) {
    const start = starts[starts.length - take]!;
    const token = deviceKey(trimmed.slice(start));
    if (token.length < 2) continue;
    const matches = devices.filter(device =>
      deviceKeys(device.label).some(label => label === token || label.endsWith(token)));
    if (matches.length === 1) return {device: matches[0]!, start};
  }
  return null;
}

export interface CommunityMentionState {
  kind: WorkroomMentionKind;
  /** 고를 때 지워지는 토큰의 시작 — 기기 이름을 적었으면 그 이름부터다. */
  start: number;
  query: string;
  /** 이 기기면 `null`. */
  device: CommunityMentionDeviceProjects | null;
  /** 그 기기의 목록을 아직 받지 못했다. */
  loading: boolean;
  error: string;
  hasMore: boolean;
  candidates: WorkroomMentionProject[];
}

/** 지금 커서 위치의 `@`·`#` 후보. 기호가 없으면 `null`. */
export function communityMentionState(
  value: string,
  cursor: number,
  targets: CommunityMentionTargets,
  limit = 8,
): CommunityMentionState | null {
  const mention = workroomMentionQuery(value, cursor);
  if (!mention) return null;
  const prefix = communityMentionDevice(value.slice(0, mention.start), targets.devices);
  const device = prefix?.device ?? null;
  const pool = device ? device.projects ?? [] : targets.local;
  const query = projectKey(mention.query);
  return {
    kind: mention.kind,
    start: prefix ? prefix.start : mention.start,
    query: mention.query,
    device,
    loading: !!device && !device.projects && !device.error,
    error: device?.error ?? '',
    hasMore: !!device?.hasMore,
    candidates: pool.filter(project => !query || projectKey(project.label).includes(query)).slice(0, limit),
  };
}

/** 다른 기기의 프로젝트를 가리키는 `#` 토큰. 기기를 함께 적어 글만 봐도 어느 호인지 안다. */
export function communityReferenceToken(deviceLabel: string | null | undefined, projectLabel: string): string {
  return deviceLabel ? `#${deviceLabel}/${projectLabel}` : `#${projectLabel}`;
}

/** 고른 프로젝트를 입력칸에 반영한다. `#`는 글에 남고(토큰), `@`는 토큰이 지워지고 받는 곳이 된다. */
export function applyCommunityMention(
  state: CommunityMentionState,
  value: string,
  cursor: number,
  project: WorkroomMentionProject,
): {value: string; cursor: number; token: string} {
  const suffix = value.slice(Math.max(0, Math.min(value.length, cursor)));
  if (state.kind === 'reference') {
    const token = communityReferenceToken(state.device?.label, project.label);
    const inserted = `${token} `;
    return {
      value: `${value.slice(0, state.start)}${inserted}${suffix.replace(/^\s+/u, '')}`,
      cursor: state.start + inserted.length,
      token,
    };
  }
  return {value: `${value.slice(0, state.start)}${suffix}`.replace(/^\s+/u, ''), cursor: Math.max(0, state.start), token: ''};
}

/** 전달할 때 함께 넘길 참고. 받는 기기와 같은 기기의 것만, 그리고 글에 토큰이 남아 있는 것만. */
export interface CommunityReferenceChip {
  deviceId: string;
  targetId: string;
  label: string;
  token: string;
}
export function communityReferencesFor(
  chips: readonly CommunityReferenceChip[],
  text: string,
  deviceId: string,
): {references: string[]; dropped: CommunityReferenceChip[]} {
  const live = chips.filter(chip => text.includes(chip.token));
  return {
    references: live.filter(chip => chip.deviceId === deviceId).map(chip => chip.targetId),
    dropped: live.filter(chip => chip.deviceId !== deviceId),
  };
}
