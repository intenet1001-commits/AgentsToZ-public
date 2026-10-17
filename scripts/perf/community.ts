/**
 * (C) 1호 → 2호/3호 원격 명령 왕복 — 커뮤니티 제어 우편함(control-send/inbox/respond/result).
 *
 * 실제 `AgentDialogueHost` 두 개를 PGlite 한 DB에 붙인다(tests/agent-dialogue-host.test.ts와 같은 구성).
 * 받는 쪽은 api-server의 `scheduleCommunityControlPoll`과 **같은 규칙**(communityControlPollDelay:
 * 최근 90초 안에 처리했으면 0.6초, 아니면 3초)으로 우편함을 읽는다. 요청을 보내는 순간이 받는 쪽 폴의
 * 어디에 떨어지느냐가 지연을 정하므로, 그 위상을 주기 안에서 **고르게(결정적으로)** 나눠 표본을 만든다 —
 * 무작위 위상이면 표본 5개의 중앙값이 실행마다 크게 흔들린다.
 *
 * 빠진 것(그래서 실기보다 작게 나온다): Supabase까지의 네트워크 왕복(호출마다 수십 ms), 휴대폰 → 1호 릴레이.
 */
import {PGlite} from '@electric-sql/pglite';
import {mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {AGENT_DIALOGUE_SQL} from '../../src/agentDialogueSql';
import {AgentDialogueHost} from '../../src/agentDialogueHost';
import {COMMUNITY_CONTROL_ACTIVE_POLL_MS, COMMUNITY_CONTROL_IDLE_POLL_MS, communityControlPollDelay} from '../../src/agentDialogueControl';
import type {AgentDialogueTarget} from '../../src/agentDialogueContract';
import {log, now, record, sampled} from './environment';
import type {PerfMeasurement} from './stats';

const OPS: AgentDialogueTarget = {target: 'ops'};

async function setup(scratch: string) {
  const db = new PGlite();
  await db.exec("create role anon; create role authenticated; create role service_role;create schema auth;create function auth.role() returns text language sql stable as $$ select current_setting('request.jwt.claim.role',true) $$;set request.jwt.claim.role='service_role';");
  await db.exec(AGENT_DIALOGUE_SQL);
  const profileId = randomUUID();
  const rpcByDevice = new Map<string, number>();
  // 보내는 쪽 시계만 앞으로 돌릴 수 있게 한다: 유휴 표본마다 91초를 더해 「90초 넘게 아무도 몰지 않음」을
  // 만든다(controlAnsweredAt·멤버십 캐시 1분·비밀 캐시 30초가 실제 유휴 Mac처럼 늙는다).
  const senderClock = {offset: 0};
  const makeHost = (deviceId: string, clock?: () => number) => new AgentDialogueHost({
    appDataDir: mkdtempSync(join(scratch, 'dialogue-')),
    ...(clock ? {now: clock} : {}),
    identity: () => ({profileId, deviceId}),
    secret: async () => deviceId.padEnd(44, 'x'),
    resolveTarget: async () => ({kind: 'ops', displayName: `${deviceId} / 아젠투지(OPS)`}),
    rpc: async (operation, p, d, secret, args) => {
      rpcByDevice.set(d, (rpcByDevice.get(d) ?? 0) + 1);
      const {rows} = await db.query<{value: Record<string, any>}>(
        'select public.portmgr_agent_dialogue_call($1,$2,$3,$4,$5::jsonb) as value', [operation, p, d, secret, JSON.stringify(args)]);
      return rows[0]!.value;
    },
  });
  const one = makeHost('perf-mac-one', () => Date.now() + senderClock.offset);
  const three = makeHost('perf-mac-three');
  for (const host of [one, three]) await host.enable(OPS, true);
  await one.uiCommunity(OPS, 'join');
  await three.uiCommunity(OPS, 'join');
  const listed = await one.controlDevices();
  const target = listed.devices[0]?.endpointId;
  if (!target) throw new Error('community control fixture has no peer device');
  return {db, one, three, target, senderRpcs: () => rpcByDevice.get('perf-mac-one') ?? 0, senderClock};
}

/**
 * 받는 Mac의 폴 루프. api-server와 같은 지연 규칙을 쓰되, 「직전 폴이 끝난 시각」을 알려 주어
 * 측정 쪽이 위상을 맞출 수 있게 한다. `lastHandledAt`을 바꿔 유휴/활성을 고른다.
 */
function receiver(three: AgentDialogueHost, mode: 'idle' | 'active' | 'tight') {
  let running = true;
  let lastHandledAt: number | null = mode === 'active' ? Date.now() : null;
  let pollEndedAt = 0;
  const signal: {pollEnded: (() => void) | null} = {pollEnded: null};
  const nextPollEnd = () => new Promise<void>(done => { signal.pollEnded = done; });
  const loop = (async () => {
    while (running) {
      const {handled} = await three.controlPoll(async request => ({echo: request.kind}));
      if (handled > 0 && mode !== 'idle') lastHandledAt = Date.now();
      // 유휴 표본은 「90초 넘게 아무도 몰지 않은 Mac」이어야 한다 — 처리했어도 유휴로 되돌린다.
      if (mode === 'idle') lastHandledAt = null;
      pollEndedAt = now();
      signal.pollEnded?.();
      const delay = mode === 'tight' ? 5 : communityControlPollDelay(lastHandledAt, Date.now());
      await Bun.sleep(delay);
    }
  })();
  return {
    stop: async () => { running = false; await loop; },
    nextPollEnd,
    pollEndedAt: () => pollEndedAt,
  };
}

async function roundTrips(input: {
  one: AgentDialogueHost; three: AgentDialogueHost; target: string; senderClock: {offset: number};
  mode: 'idle' | 'active' | 'tight'; samples: number; period: number;
}): Promise<number[]> {
  const rx = receiver(input.three, input.mode);
  const values: number[] = [];
  try {
    // 활성 모드에서는 보내는 쪽도 「상대가 방금 답했다」를 알아야 한다(controlCall의 150ms 고정 되묻기).
    if (input.mode !== 'idle') await input.one.controlCall(input.target, {kind: 'projects'}, 10_000);
    for (let i = 0; i < input.samples; i += 1) {
      await rx.nextPollEnd();
      // 위상: 받는 쪽 폴이 끝난 뒤 주기의 (i+0.5)/n 지점에서 보낸다 — 실행마다 같은 위상 집합.
      const phase = input.mode === 'tight' ? 0 : Math.round(((i + 0.5) / input.samples) * input.period);
      const wait = phase - (now() - rx.pollEndedAt());
      if (wait > 0) await Bun.sleep(wait);
      if (input.mode === 'idle') input.senderClock.offset += 91_000;
      const t = now();
      const answer = await input.one.controlCall(input.target, {kind: 'projects'}, 15_000);
      values.push(now() - t);
      if ((answer as {ok?: unknown}).ok !== true) throw new Error(`control call failed: ${JSON.stringify(answer)}`);
    }
  } finally { await rx.stop(); }
  return values;
}

export async function measureCommunityControl(scratch: string, samples: number): Promise<Record<string, PerfMeasurement>> {
  const fixture = await setup(scratch);
  const out: Record<string, PerfMeasurement> = {};
  try {
    log('C 커뮤니티 제어 — 받는 Mac이 빡빡하게 폴(우편함 RPC 비용만)');
    const before = fixture.senderRpcs();
    const tight = await sampled(() => roundTrips({...fixture, mode: 'tight', samples: samples * 2, period: 0}));
    // +1: 활성·빡빡 모드는 표본 전에 한 번 더 부른다(상대가 방금 답했다는 상태를 만들기 위해).
    const rpcPerCall = (fixture.senderRpcs() - before) / (samples * 2 + 1);
    out['community.control.mailbox-floor'] = record({
      method: '실제 AgentDialogueHost 2대 + PGlite(같은 프로세스). 받는 쪽이 5ms마다 폴 — 폴링 양자화를 뺀 우편함 왕복(send→inbox→respond→result).',
      reproducible: true, regressionFloor: 50,
      notes: `보내는 쪽 RPC 호출당 ${rpcPerCall.toFixed(1)}회(send + result 되묻기). 하한 ≈150ms는 controlCall이 첫 result 확인 뒤 150ms를 쉬기 때문이다(src/agentDialogueHost.ts controlCall). 실기에서는 RPC마다 Supabase 왕복이 더해진다.`,
      data: tight,
    });
    log(`C 커뮤니티 제어 — 받는 Mac 활성(${COMMUNITY_CONTROL_ACTIVE_POLL_MS}ms 주기)`);
    const active = await sampled(() => roundTrips({...fixture, mode: 'active', samples: samples * 2, period: COMMUNITY_CONTROL_ACTIVE_POLL_MS}));
    out['community.control.active-receiver'] = record({
      method: `받는 쪽이 90초 안에 제어받은 상태(communityControlPollDelay → ${COMMUNITY_CONTROL_ACTIVE_POLL_MS}ms). 보내는 위상을 주기 안에 고르게 ${samples * 2}점. 보내는 쪽 되묻기 150ms 고정.`,
      reproducible: true, regressionFloor: 150,
      notes: '이론값 ≈ 남은 주기(0~600ms, 평균 300) + 되묻기 양자화(≤150ms) + RPC. 네트워크 없음.',
      data: active,
    });
    log(`C 커뮤니티 제어 — 받는 Mac 유휴(${COMMUNITY_CONTROL_IDLE_POLL_MS}ms 주기)`);
    const idle = await sampled(() => roundTrips({...fixture, mode: 'idle', samples, period: COMMUNITY_CONTROL_IDLE_POLL_MS}));
    out['community.control.idle-receiver'] = record({
      method: `받는 쪽이 90초 넘게 조용한 상태(${COMMUNITY_CONTROL_IDLE_POLL_MS}ms 주기). 보내는 위상을 주기 안에 고르게 ${samples}점. 보내는 쪽 시계를 표본마다 91초 앞당겨 되묻기 150→400ms 물러남·멤버십 캐시 만료까지 유휴 Mac처럼 만든다.`,
      reproducible: true, regressionFloor: 300,
      notes: '휴대폰/1호가 2호·3호를 처음 고른 직후의 첫 요청이 이 경우다. 이론값 ≈ 남은 주기(0~3000, 평균 1500) + 되묻기(≤400ms).',
      data: idle,
    });
  } finally { await fixture.db.close(); }
  return out;
}
