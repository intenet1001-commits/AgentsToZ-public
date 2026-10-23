// 내 기억 타임라인 — 「내가 시킨 것」과 「그래서 남은 결과」를 한 줄로 묶는다.
//
// 두 쪽은 이미 저장소에 있다. 지시는 「내가 한 말」(턴마다 한 줄), 결과는 프로젝트 일지
// `portmgr_project_memory_journal`(세션 기억하기를 실행할 때 한 줄)이다. 없던 것은 여섯 번째
// 저장소가 아니라 **그 둘을 잇는 규칙** 하나였다.
//
// ⚠️ 일지는 세션당 하나, 지시는 턴당 하나다 — 관계는 1:1이 아니라 **1:N**이다. 시각이 가까운
// 것끼리 1:1로 짝지으면 이 Mac 실측에서 지시 416개 중 18개(4%)만 짝이 맞았다. 그래서 일지 한
// 줄은 **직전 일지 이후의 모든 지시**를 덮는다. 창의 경계는 (직전 일지, 이 일지] 로 닫는다 —
// 같은 밀리초에 찍힌 지시를 양쪽 창이 가져가면 그 줄이 두 번 보인다.
//
// ⚠️ 이 파일은 IO를 하지 않고 시계도 읽지 않는다. 「지금」을 읽으면 같은 입력이 실행할 때마다
// 다른 결과를 내서 결정적으로 검사할 수 없다. 순서는 입력이 들고 온 시각만으로 정한다.
//
// 불변식 두 가지를 테스트가 지킨다: 입력의 지시와 결과는 **각각 정확히 한 번** 결과물에
// 나타나고, 어떤 입력에서도 **항목이 사라지지 않는다**. 짝을 못 지으면 숨기는 것이 아니라
// 이유를 붙여 남긴다 — 내 기록이 조용히 사라지는 것이 가장 나쁘다.

/** 「내가 한 말」 한 줄. 필드 이름은 `WhatISaidPrompt`(src/WhatISaidPanel.tsx)를 따른다. */
export interface TimelineInstruction {
  id: string;
  recordedAt: string;
  agent: string;
  /** 「내가 한 말」의 옛 행은 이 값이 없다. 없으면 어느 프로젝트의 것인지 **추측하지 않는다**. */
  memoryId?: string | null;
  projectId: string | null;
  projectName: string | null;
  deviceId: string | null;
  deviceName: string | null;
  text: string;
  storage?: 'local' | 'supabase';
}

/** 프로젝트 일지 한 줄. `entryHash`는 내용 해시라 **어느 기기에서나** 같은 값이다. */
export interface TimelineOutcome {
  entryHash: string;
  memoryId: string;
  recordedAt: string;
  agent: string | null;
  projectName: string | null;
  deviceId: string | null;
  deviceName: string | null;
  summary: string;
}

/**
 * 짝을 못 지은 지시에 붙는 이유. 화면이 이것을 그대로 문장으로 바꾼다 —
 * 「짝이 없다」가 아니라 **왜 없는지**를 보여야 사용자가 고장과 구분할 수 있다.
 */
export type UnpairedReason =
  /** 이 기억의 마지막 일지보다 뒤 — 아직 「세션 기억하기」를 하지 않은 진행 중인 작업. */
  | 'in-progress'
  /** 이 기억의 첫 일지보다 앞 — 일지를 쓰기 시작하기 전의 기록. */
  | 'before-first-record'
  /** 이 기억에 일지가 한 줄도 없다. */
  | 'no-record'
  /** 그 지시에 memoryId가 없다(기록 이전 행). 어느 프로젝트의 것인지 추측하지 않는다. */
  | 'no-memory'
  /** 시각을 읽을 수 없어 창에 넣을 수 없다. */
  | 'unknown-time';

export type TimelineItem =
  | {
      kind: 'session';
      at: string;
      memoryId: string;
      outcome: TimelineOutcome;
      instructions: TimelineInstruction[];
      /** 이 묶음의 지시 중 결과와 **다른 기기**에서 온 것이 있다. 같은 세션이라고 주장하지 않는다. */
      devicesDiffer: boolean;
    }
  | { kind: 'instructions'; at: string; memoryId: string | null; reason: UnpairedReason; instructions: TimelineInstruction[] }
  | { kind: 'outcome'; at: string; memoryId: string; outcome: TimelineOutcome };

const time = (value: string): number | null => {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
};

/** 같은 시각이 겹쳐도 순서가 흔들리지 않도록 쓰는 안정 정렬 키. */
const tieBreak = (item: TimelineItem): string =>
  item.kind === 'session' ? `s:${item.outcome.entryHash}`
  : item.kind === 'outcome' ? `o:${item.outcome.entryHash}`
  : `i:${item.instructions[0]?.id ?? ''}`;

const push = <K, V>(map: Map<K, V[]>, key: K, value: V): void => {
  const bucket = map.get(key);
  if (bucket) bucket.push(value); else map.set(key, [value]);
};

/**
 * 지시와 결과를 한 타임라인으로 묶는다. 최신이 앞이다.
 *
 * 입력 배열은 바꾸지 않는다(호출자가 화면 상태로 들고 있는 배열일 수 있다).
 */
export function mergeUserMemoryTimeline(input: {
  instructions: readonly TimelineInstruction[];
  outcomes: readonly TimelineOutcome[];
}): TimelineItem[] {
  const items: TimelineItem[] = [];

  // 시각을 읽을 수 없는 지시는 어떤 창에도 넣을 수 없다. 버리지 않고 이유를 붙여 따로 남긴다.
  const placeable: TimelineInstruction[] = [];
  const undated: TimelineInstruction[] = [];
  for (const instruction of input.instructions) (time(instruction.recordedAt) === null ? undated : placeable).push(instruction);

  const byMemory = new Map<string, TimelineInstruction[]>();
  const withoutMemory: TimelineInstruction[] = [];
  for (const instruction of placeable) {
    if (instruction.memoryId) push(byMemory, instruction.memoryId, instruction);
    else withoutMemory.push(instruction);
  }

  const outcomesByMemory = new Map<string, TimelineOutcome[]>();
  const undatedOutcomes: TimelineOutcome[] = [];
  for (const outcome of input.outcomes) {
    if (time(outcome.recordedAt) === null) undatedOutcomes.push(outcome);
    else push(outcomesByMemory, outcome.memoryId, outcome);
  }

  for (const [memoryId, outcomes] of outcomesByMemory) {
    const ordered = [...outcomes].sort((a, b) => time(a.recordedAt)! - time(b.recordedAt)! || a.entryHash.localeCompare(b.entryHash));
    const pool = [...(byMemory.get(memoryId) ?? [])].sort((a, b) => time(a.recordedAt)! - time(b.recordedAt)!);
    byMemory.delete(memoryId);

    let cursor = 0;
    const before: TimelineInstruction[] = [];
    let previous: number | null = null;

    for (const outcome of ordered) {
      const edge = time(outcome.recordedAt)!;
      const bundle: TimelineInstruction[] = [];
      while (cursor < pool.length && time(pool[cursor]!.recordedAt)! <= edge) {
        // 첫 일지는 창의 시작이 없다. 그 앞의 지시가 이 일지가 요약한 작업이라고 **추측하지
        // 않고** 'before-first-record'로 따로 남긴다 — 틀린 짝을 보여 주는 쪽이 더 나쁘다.
        (previous === null ? before : bundle).push(pool[cursor]!);
        cursor += 1;
      }
      if (previous === null) {
        // 첫 일지는 자기 창이 없다. 이 일지가 덮는 범위를 추측하지 않고 결과만 남긴다.
        items.push({ kind: 'outcome', at: outcome.recordedAt, memoryId, outcome });
      } else {
        const devicesDiffer = bundle.some(i => i.deviceId && outcome.deviceId && i.deviceId !== outcome.deviceId);
        if (bundle.length) items.push({ kind: 'session', at: outcome.recordedAt, memoryId, outcome, instructions: bundle, devicesDiffer });
        else items.push({ kind: 'outcome', at: outcome.recordedAt, memoryId, outcome });
      }
      previous = edge;
    }

    if (before.length) items.push({ kind: 'instructions', at: before[before.length - 1]!.recordedAt, memoryId, reason: 'before-first-record', instructions: before });
    const rest = pool.slice(cursor);
    if (rest.length) items.push({ kind: 'instructions', at: rest[rest.length - 1]!.recordedAt, memoryId, reason: 'in-progress', instructions: rest });
  }

  for (const [memoryId, instructions] of byMemory) {
    const ordered = [...instructions].sort((a, b) => time(a.recordedAt)! - time(b.recordedAt)!);
    items.push({ kind: 'instructions', at: ordered[ordered.length - 1]!.recordedAt, memoryId, reason: 'no-record', instructions: ordered });
  }
  if (withoutMemory.length) {
    const ordered = [...withoutMemory].sort((a, b) => time(a.recordedAt)! - time(b.recordedAt)!);
    items.push({ kind: 'instructions', at: ordered[ordered.length - 1]!.recordedAt, memoryId: null, reason: 'no-memory', instructions: ordered });
  }
  if (undated.length) items.push({ kind: 'instructions', at: undated[0]!.recordedAt, memoryId: null, reason: 'unknown-time', instructions: [...undated] });
  for (const outcome of undatedOutcomes) items.push({ kind: 'outcome', at: outcome.recordedAt, memoryId: outcome.memoryId, outcome });

  return items.sort((a, b) => {
    const left = time(a.at), right = time(b.at);
    if (left !== null && right !== null && left !== right) return right - left;
    if (left === null && right !== null) return 1;
    if (right === null && left !== null) return -1;
    return tieBreak(a) < tieBreak(b) ? -1 : 1;
  });
}

/**
 * 화면 머리에 쓸 정직한 수치.
 *
 * ⚠️ 「지시 416 · 결과 209」처럼 총계 둘만 보이면 「416개 중 209개에 결과가 있다」로 읽힌다.
 * 실제로 짝이 지어진 수를 따로 센다.
 */
export function summariseUserMemoryTimeline(items: readonly TimelineItem[]): {
  sessions: number;
  pairedInstructions: number;
  unpairedInstructions: number;
  outcomesWithoutInstructions: number;
} {
  let sessions = 0, pairedInstructions = 0, unpairedInstructions = 0, outcomesWithoutInstructions = 0;
  for (const item of items) {
    if (item.kind === 'session') { sessions += 1; pairedInstructions += item.instructions.length; }
    else if (item.kind === 'instructions') unpairedInstructions += item.instructions.length;
    else outcomesWithoutInstructions += 1;
  }
  return { sessions, pairedInstructions, unpairedInstructions, outcomesWithoutInstructions };
}
