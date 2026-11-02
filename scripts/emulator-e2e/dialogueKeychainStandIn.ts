/**
 * 대역(WP10): macOS 로그인 키체인의 「대화 기기 키」(agent-dialogue device master key) → 실행 스크래치의 파일.
 *
 * 왜 필요한가: 커뮤니티 입장·엔드포인트 공개는 기기 키에서 유도한 비밀로 대화 RPC(`portmgr_agent_dialogue_call`)에 서명한다.
 * darwin에서 그 키는 `src/agentDialogueHost.ts`의 secretUncached → `createProductionPromptGuideKeyProvider`(src/promptGuideKeyProvider.ts)가
 * `/usr/bin/security find-generic-password|add-generic-password -a device-master-v1 -s com.portmanager.portmanager.agent-dialogue.v1 -w`
 * 로 읽고 만든다. 샌드박스는 /usr/bin/security 실행을 막고(설계 §2.3 — 실측: spawn-error EPERM), 사람의 키체인은 절대 쓰지 않는다.
 * 운영 사이드카에 seam을 두지도 않는다(설계 검토 #14: 운영 빌드에 실리는 seam 금지).
 *
 * 그래서 레인 전용 진입 래퍼(dialogue-keychain-entry.ts — 운영 빌드 진입점이 아니다)가 api-server를 import하기 **전에**
 * `node:child_process`의 spawn을 감싸, **정확히 이 두 호출**(같은 인자 6개)만 스크래치의 대역 스크립트로 돌린다.
 * - 운영 경로는 그대로 돈다: provider의 defaultRunner가 실제로 프로세스를 띄우고 stdin(키 두 줄)·종료 코드(44 = 없음)·stdout을
 *   그대로 쓰며, decodeKey·HMAC 유도·`register-device`까지 실제 코드다. 바뀌는 것은 「키를 어디에 보관하나」 하나다.
 * - 다른 security 호출(다른 서비스·다른 동작·다른 인자)은 손대지 않는다 — 그대로 실제 /usr/bin/security로 가서 샌드박스가 막는다.
 * - (Bun 1.4 실측) `require('node:child_process').spawn`을 바꾸면 그 뒤에 로드되는 모듈의 `import {spawn} from 'node:child_process'`도
 *   바뀐 함수를 본다 — 관측 래퍼(tests/fixtures/side-effect-guard-entry.ts)와 같은 전제다.
 * 이 모듈은 순수하다(부작용은 installDialogueKeychainStandIn을 부를 때만). 오케스트레이터·테스트·진입 래퍼가 같이 쓴다.
 */
import {chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

/** src/agentDialogueHost.ts의 keychainService·keychainAccount(테스트가 그 소스와 같은지 확인한다). */
export const DIALOGUE_KEYCHAIN_SERVICE = 'com.portmanager.portmanager.agent-dialogue.v1';
export const DIALOGUE_KEYCHAIN_ACCOUNT = 'device-master-v1';
export const REAL_SECURITY = '/usr/bin/security';
/** 진입 래퍼가 읽는 대역 스크립트 경로(레인이 laneOverrides로 밝힌다 — AGENTSTOZ_EMULATOR_ 접두사). */
export const KEYCHAIN_STANDIN_ENV = 'AGENTSTOZ_EMULATOR_KEYCHAIN_STANDIN';
/** security(1)의 종료 코드: errSecItemNotFound(44) · errSecDuplicateItem(45). provider가 44를 「없음」으로 읽는다. */
export const KEYCHAIN_ITEM_NOT_FOUND = 44;
export const KEYCHAIN_DUPLICATE_ITEM = 45;

export type DialogueKeychainOp = 'find' | 'add';

/** 대화 기기 키의 키체인 호출인가(정확히 이 인자 6개일 때만). 아니면 null — 그 호출은 손대지 않는다. */
export function dialogueKeychainCall(command: unknown, args: unknown): DialogueKeychainOp | null {
  if (command !== REAL_SECURITY || !Array.isArray(args) || args.length !== 6) return null;
  const [op, accountFlag, account, serviceFlag, service, passwordFlag] = args as unknown[];
  if (accountFlag !== '-a' || account !== DIALOGUE_KEYCHAIN_ACCOUNT || serviceFlag !== '-s' || service !== DIALOGUE_KEYCHAIN_SERVICE || passwordFlag !== '-w') return null;
  return op === 'find-generic-password' ? 'find' : op === 'add-generic-password' ? 'add' : null;
}

const SAFE_PATH = /^\/[A-Za-z0-9._/-]+$/;

/**
 * 대역 스크립트(/bin/sh). 인자 6개가 정확히 대화 기기 키일 때만 답한다:
 * - find: 파일이 있으면 그 줄을 출력하고 0, 없으면 44(security와 같다 — provider는 「없음」으로 읽는다).
 * - add: stdin의 두 줄(security가 묻는 비밀번호·확인)이 같아야 하고, 이미 있으면 45(덮어쓰지 않는다 — provider는 「추가만」).
 * 기록(JSONL)에는 동작과 결과만 남긴다 — 키 값은 남기지 않는다.
 */
export function keychainStandInScript(input: {storePath: string; logPath: string}): string {
  for (const path of [input.storePath, input.logPath]) if (!SAFE_PATH.test(path)) throw new Error(`keychain stand-in path ${path} is not a plain absolute path`);
  const log = (op: string, outcome: string) => `printf '{"op":"${op}","outcome":"${outcome}"}\\n' >> "$LOG"`;
  return [
    '#!/bin/sh',
    '# AgentsToZ emulator stand-in for `security` — the agent-dialogue device key only. NOT the macOS Keychain.',
    `STORE='${input.storePath}'`,
    `LOG='${input.logPath}'`,
    'umask 077',
    `if [ "$#" -ne 6 ] || [ "$2" != "-a" ] || [ "$3" != "${DIALOGUE_KEYCHAIN_ACCOUNT}" ] || [ "$4" != "-s" ] || [ "$5" != "${DIALOGUE_KEYCHAIN_SERVICE}" ] || [ "$6" != "-w" ]; then`,
    `  ${log('unknown', 'refused')}`,
    '  exit 1',
    'fi',
    'case "$1" in',
    '  find-generic-password)',
    '    if [ -f "$STORE" ]; then',
    `      ${log('find', 'found')}`,
    '      cat "$STORE"',
    '      exit 0',
    '    fi',
    `    ${log('find', 'absent')}`,
    `    exit ${KEYCHAIN_ITEM_NOT_FOUND}`,
    '    ;;',
    '  add-generic-password)',
    `    IFS= read -r first || { ${log('add', 'no-input')}; exit 1; }`,
    `    IFS= read -r second || { ${log('add', 'no-input')}; exit 1; }`,
    `    if [ -z "$first" ] || [ "$first" != "$second" ]; then ${log('add', 'mismatch')}; exit 1; fi`,
    `    if [ -f "$STORE" ]; then ${log('add', 'duplicate')}; exit ${KEYCHAIN_DUPLICATE_ITEM}; fi`,
    '    printf \'%s\\n\' "$first" > "$STORE.tmp.$$" && mv "$STORE.tmp.$$" "$STORE" || exit 1',
    `    ${log('add', 'added')}`,
    '    exit 0',
    '    ;;',
    'esac',
    log('unknown', 'refused'),
    'exit 1',
    '',
  ].join('\n');
}

export interface KeychainStandIn {dir: string; scriptPath: string; storePath: string; logPath: string}

/** 스크래치 폴더에 대역 스크립트(0700)를 쓴다. 키 파일은 provider가 처음 add할 때 생긴다. */
export function writeKeychainStandIn(dir: string): KeychainStandIn {
  if (!SAFE_PATH.test(dir)) throw new Error(`keychain stand-in folder ${dir} is not a plain absolute path`);
  mkdirSync(dir, {recursive: true, mode: 0o700});
  chmodSync(dir, 0o700);
  const standIn: KeychainStandIn = {dir, scriptPath: join(dir, 'security'), storePath: join(dir, 'agent-dialogue-device-key'), logPath: join(dir, 'calls.jsonl')};
  writeFileSync(standIn.scriptPath, keychainStandInScript(standIn), {mode: 0o700});
  chmodSync(standIn.scriptPath, 0o700);
  return standIn;
}

type SpawnLike = (...args: unknown[]) => unknown;

/**
 * spawn을 감싼다: 대화 기기 키 호출만 대역 스크립트로 보내고 나머지는 그대로 넘긴다. 돌려받은 함수로 몇 번 돌렸는지 센다.
 * 진입 래퍼가 api-server를 import하기 전에 부른다.
 */
export function installDialogueKeychainStandIn(childProcess: {spawn: SpawnLike}, standInPath: string): {redirected(): number} {
  if (!SAFE_PATH.test(standInPath)) throw new Error('keychain stand-in path must be a plain absolute path');
  const original = childProcess.spawn;
  let redirected = 0;
  childProcess.spawn = function (this: unknown, command: unknown, ...rest: unknown[]) {
    if (dialogueKeychainCall(command, rest[0])) {
      redirected += 1;
      return original.call(this, standInPath, ...rest);
    }
    return original.call(this, command, ...rest);
  };
  return {redirected: () => redirected};
}

export interface KeychainStandInSummary {
  calls: number;
  byOutcome: Record<string, number>;
  /** 대역이 거절한 호출(인자가 대화 기기 키가 아님) — 진입 래퍼가 걸렀으므로 0이어야 한다. */
  refused: number;
  /** 키가 한 번 만들어지고(added 1) 그 뒤로는 그 키를 읽었는가. */
  createdOnce: boolean;
}

export function readKeychainStandInLog(path: string): Array<{op: string; outcome: string}> {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => {
    try {
      const value = JSON.parse(line) as {op?: unknown; outcome?: unknown};
      return {op: String(value.op ?? '?'), outcome: String(value.outcome ?? '?')};
    } catch { return {op: '?', outcome: 'unparsable'}; }
  });
}

export function summarizeKeychainStandIn(entries: ReadonlyArray<{op: string; outcome: string}>): KeychainStandInSummary {
  const byOutcome: Record<string, number> = {};
  for (const entry of entries) byOutcome[`${entry.op}:${entry.outcome}`] = (byOutcome[`${entry.op}:${entry.outcome}`] ?? 0) + 1;
  const refused = entries.filter(entry => entry.outcome === 'refused' || entry.outcome === 'unparsable' || entry.outcome === 'mismatch' || entry.outcome === 'no-input').length;
  return {calls: entries.length, byOutcome, refused, createdOnce: (byOutcome['add:added'] ?? 0) === 1 && (byOutcome['add:duplicate'] ?? 0) === 0};
}
