/**
 * (B) 워크룸 세션 시작 → 첫 화면, (D 일부) 워크룸 `read` 비용.
 *
 * 실제 `AiTerminalService` 경로(PTY spawn·headless 화면·출력 페이지)를 그대로 쓰고, CLI만 결정적인
 * 가짜로 바꾼다. 가짜 CLI는 TUI처럼 세 번에 나눠 그린다(0ms · +50ms · +100ms) — 그래서
 * 「화면이 가라앉음」의 하한은 100ms이고, 그 위의 값이 이 앱이 보탠 비용이다.
 *
 * 실제 claude/codex(`--real-cli`)는 격리된 HOME에서 **첫 출력까지만** 재고 곧바로 닫는다.
 * 아무 것도 입력하지 않는다. 그 숫자는 CLI 버전·네트워크가 바꾸므로 비교 대상(reproducible)이 아니다.
 */
import {chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {AiTerminalService} from '../../src/aiTerminalService';
import type {AiTerminalAgent} from '../../src/aiTerminalProtocol';
import {collect, log, now, record, recorder, sampled} from './environment';
import type {PerfMeasurement} from './stats';

const TARGET = 'perf-workroom-target';
/** 이 시간 동안 새 출력이 없으면 「화면이 가라앉았다」고 본다. 가짜 CLI의 프레임 간격(50ms)보다 길어야 한다. */
export const SETTLE_QUIET_MS = 300;

const TUI_CLI = `#!/bin/sh
printf '\\033[2J\\033[H\\033[1mperf fake CLI\\033[0m  v0\\r\\n'
sleep 0.05
printf '\\033[3;1H> \\033[2mType your request\\033[0m\\r\\n'
sleep 0.05
printf '\\033[24;1H\\033[7m status: ready \\033[0m'
while IFS= read -r line; do :; done
`;
// 약 400KB의 출력(줄 100자) — 오래 돈 세션에 늦게 붙는 휴대폰의 상황.
const FLOOD_CLI = `#!/bin/sh
yes 'flood 0123456789 abcdefghijklmnopqrstuvwxyz ABCDEFGHIJKLMNOPQRSTUVWXYZ 0123456789 abcdefghij' | head -c 400000
printf '\\r\\nFLOOD-DONE\\r\\n'
while IFS= read -r line; do :; done
`;

function fixture(script: string, scratch: string, env?: Record<string, string | undefined>) {
  const dir = mkdtempSync(join(scratch, 'workroom-'));
  const executable = join(dir, 'cli');
  writeFileSync(executable, script);
  chmodSync(executable, 0o755);
  const home = join(dir, 'home');
  mkdirSync(home);
  const service = new AiTerminalService({
    resolveTarget: async id => { if (id !== TARGET) throw new Error('unregistered'); return {cwd: dir}; },
    executable: () => executable,
    env: env ?? {PATH: process.env.PATH, HOME: home},
  });
  return {service, dir};
}

const req = (body: Record<string, unknown>) => ({...body, requestId: crypto.randomUUID()});

/** 첫 청크가 보이는 순간과 마지막 출력 시각(호스트 기록)을 잰다. 폴링 간격 2ms가 측정 오차의 상한이다. */
async function startAndWatch(service: AiTerminalService, agent: AiTerminalAgent, options: {settle: boolean; deadlineMs: number}) {
  const t0 = now();
  const epoch0 = Date.now();
  const started = await service.perform(req({operation: 'start', targetId: TARGET, agent, cols: 100, rows: 28}));
  const startResolved = now() - t0;
  const id = started.session!.id;
  let firstOutput: number | null = null;
  let cursor = 0;
  let lastSeenChange = now();
  const deadline = t0 + options.deadlineMs;
  while (now() < deadline) {
    const r = await service.perform(req({operation: 'read', sessionId: id, after: cursor}));
    const chunks = r.chunks ?? [];
    if (chunks.length) {
      if (firstOutput === null) firstOutput = now() - t0;
      cursor = chunks.at(-1)!.seq;
      lastSeenChange = now();
    }
    if (firstOutput !== null && (!options.settle || now() - lastSeenChange >= SETTLE_QUIET_MS)) break;
    await Bun.sleep(2);
  }
  let settled: number | null = null;
  if (options.settle && firstOutput !== null) {
    const lastOutputAt = service.inspectSession(id, TARGET).lastOutputAt;
    if (lastOutputAt) settled = lastOutputAt - epoch0;
  }
  return {id, startResolved, firstOutput, settled};
}

export async function measureWorkroomStart(scratch: string, samples: number): Promise<Record<string, PerfMeasurement>> {
  log('B 워크룸 시작(가짜 TUI CLI)');
  const {service} = fixture(TUI_CLI, scratch);
  const rec = recorder(['start', 'first', 'settled'] as const);
  const results = rec.samples;
  try {
    // 첫 spawn은 모듈·PTY 초기화가 섞인다 — 앱이 켜진 뒤 첫 워크룸과 같지만, 비교 숫자에서는 뺀다.
    const warm = await startAndWatch(service, 'claude', {settle: true, deadlineMs: 10_000});
    await service.perform(req({operation: 'close', sessionId: warm.id}));
    for (let i = 0; i < samples; i += 1) {
      const r = await startAndWatch(service, 'claude', {settle: true, deadlineMs: 10_000});
      if (r.firstOutput === null || r.settled === null) throw new Error('fake CLI produced no output');
      results.start.push(r.startResolved);
      results.first.push(r.firstOutput);
      results.settled.push(r.settled);
      await service.perform(req({operation: 'close', sessionId: r.id}));
      await Bun.sleep(100);
    }
  } finally { await service.shutdown(); }
  const data = rec.done();
  const common = 'AiTerminalService(실제 PTY·headless 화면)에 결정적 가짜 CLI(0/+50/+100ms 세 프레임). 워밍업 1회 제외.';
  const wrap = (key: keyof typeof data, method: string, notes: string, floor?: number) => record({
    method: `${common} ${method}`, reproducible: true, notes, regressionFloor: floor, data: data[key],
  });
  return {
    'workroom.start.request': wrap('start', 'perform(start)가 돌려줄 때까지.', 'spawn + 세션 등록. 화면은 아직 없다.', 30),
    'workroom.start.first-output': wrap('first', 'start 호출부터 read로 첫 청크가 보일 때까지(2ms 폴링).', '휴대폰·창이 「뭔가 떴다」고 보는 시점의 호스트 쪽 하한.', 30),
    'workroom.start.settled': wrap('settled', `start 호출부터 마지막 출력 시각(inspectSession.lastOutputAt)까지, ${SETTLE_QUIET_MS}ms 조용하면 끝.`, '가짜 CLI 자체가 100ms를 쓴다 — 그 위가 앱 비용.', 50),
  };
}

export async function measureWorkroomRead(scratch: string, samples: number): Promise<Record<string, PerfMeasurement>> {
  log('D 워크룸 read(400KB 출력이 쌓인 세션)');
  const {service} = fixture(FLOOD_CLI, scratch);
  let head!: Awaited<ReturnType<typeof sampled>>, snapshot!: typeof head, tail!: typeof head;
  try {
    const started = await service.perform(req({operation: 'start', targetId: TARGET, agent: 'claude', cols: 100, rows: 28}));
    const id = started.session!.id;
    // 출력이 다 들어올 때까지(호스트 기록이 300ms 조용) 기다린다.
    const deadline = now() + 15_000;
    while (now() < deadline) {
      const last = service.inspectSession(id, TARGET).lastOutputAt;
      if (last && Date.now() - last > SETTLE_QUIET_MS) break;
      await Bun.sleep(20);
    }
    const tailCursor = service.inspectSession(id, TARGET).outputCursor;
    const time = async (body: Record<string, unknown>) => { const t = now(); await service.perform(req(body)); return now() - t; };
    for (let i = 0; i < 3; i += 1) await time({operation: 'read', sessionId: id, after: 0, snapshot: true});
    head = await sampled(() => collect(() => time({operation: 'read', sessionId: id, after: 0}), {samples: samples * 4}));
    snapshot = await sampled(() => collect(() => time({operation: 'read', sessionId: id, after: 0, snapshot: true}), {samples: samples * 4}));
    tail = await sampled(() => collect(() => time({operation: 'read', sessionId: id, after: tailCursor}), {samples: samples * 4}));
    await service.perform(req({operation: 'close', sessionId: id}));
  } finally { await service.shutdown(); }
  const method = 'AiTerminalService.perform(read) 한 번의 호스트 처리 시간, 400KB(yes|head -c) 출력이 쌓인 세션.';
  return {
    'workroom.read.from-start': record({method: `${method} after:0 (재생 첫 페이지).`, reproducible: true, regressionFloor: 5, data: head}),
    'workroom.read.snapshot': record({method: `${method} snapshot:true after:0 (늦게 붙은 휴대폰의 첫 화면).`, reproducible: true, regressionFloor: 10, data: snapshot, notes: 'headless 화면 직렬화 비용이 들어간다.'}),
    'workroom.read.tail-poll': record({method: `${method} 끝 커서에서 새 출력 없는 폴링(화면이 1초마다 하는 일).`, reproducible: true, regressionFloor: 5, data: tail}),
  };
}

/** 실제 CLI 첫 출력. 격리 HOME, 아무 입력 없음, 첫 출력 직후 close. */
export async function measureRealCliFirstOutput(scratch: string, agents: AiTerminalAgent[], samples: number): Promise<Record<string, PerfMeasurement>> {
  const results: Record<string, PerfMeasurement> = {};
  for (const agent of agents) {
    const binary = Bun.which(agent);
    if (!binary) { log(`실제 ${agent} 없음 — 건너뜀`); continue; }
    log(`B 실제 ${agent} 첫 출력(격리 HOME, 입력 없음)`);
    const dir = mkdtempSync(join(scratch, `real-${agent}-`));
    const home = join(dir, 'home');
    mkdirSync(home);
    const service = new AiTerminalService({
      resolveTarget: async () => ({cwd: dir}),
      executable: () => binary,
      // 격리 HOME: 사용자 설정·훅·세션 기록을 건드리지 않는다. 업데이트·부가 트래픽도 끈다.
      env: {PATH: process.env.PATH, HOME: home, DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1'},
      codexHookTrustSupported: async () => false,
    });
    const rec = recorder(['first'] as const);
    const firsts = rec.samples.first;
    try {
      for (let i = 0; i < samples; i += 1) {
        const r = await startAndWatch(service, agent, {settle: false, deadlineMs: 20_000});
        await service.perform(req({operation: 'close', sessionId: r.id})).catch(() => undefined);
        if (r.firstOutput !== null) firsts.push(r.firstOutput);
        await Bun.sleep(300);
      }
    } finally {
      await service.shutdown();
      rmSync(dir, {recursive: true, force: true});
    }
    if (!firsts.length) { log(`실제 ${agent}: 20초 안에 출력 없음`); continue; }
    const version = Bun.spawnSync([binary, '--version'], {env: {PATH: process.env.PATH, HOME: home}}).stdout.toString().trim().split('\n')[0] ?? '?';
    results[`workroom.real-cli.${agent}.first-output`] = record({
      method: `실제 ${agent} 바이너리를 AiTerminalService로 띄워 첫 PTY 바이트까지(격리 HOME, 입력 없음, 바로 close). 첫 바이트는 그려진 화면이 아니라 터미널 질의(DSR 등) 시퀀스일 수 있다.`,
      reproducible: false,
      notes: `${agent} ${version}; CLI 버전·네트워크·로그인 화면 여부가 바꾸므로 비교 대상이 아님.`,
      data: rec.done().first,
    });
  }
  return results;
}
