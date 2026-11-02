/**
 * 에뮬레이터 레인 전용 사이드카 진입 래퍼 — **대역**이고 운영 빌드 진입점이 아니다(build-sidecar 계획에 없다 — 테스트가 확인한다).
 * WP10(j4-fixture)·J4 레인이 `ctx.startSidecar(root, 'source', {entryWrapper: <이 파일>, laneOverrides: {AGENTSTOZ_EMULATOR_KEYCHAIN_STANDIN: …}})`
 * 로 쓴다. 하는 일은 하나다: 대화 기기 키의 키체인 호출 두 가지만 스크래치의 대역 스크립트로 돌린다(dialogueKeychainStandIn.ts).
 * 그 뒤 런처가 정한 진입점(관측 래퍼 또는 api-server.ts)을 이어서 import한다. 차단은 여전히 샌드박스가 한다.
 */
import {existsSync, realpathSync} from 'node:fs';
import {resolve} from 'node:path';
import {KEYCHAIN_STANDIN_ENV, installDialogueKeychainStandIn} from './dialogueKeychainStandIn';

const REPO_ROOT = resolve(import.meta.dir, '..', '..');
const NEXT_ENTRY_ENV = 'AGENTSTOZ_EMULATOR_NEXT_ENTRY';
const ALLOWED_NEXT = new Set([resolve(REPO_ROOT, 'api-server.ts'), resolve(REPO_ROOT, 'tests', 'fixtures', 'side-effect-guard-entry.ts')]);

function refuse(message: string): never {
  console.error(`[dialogue-keychain-entry] ${message}`);
  process.exit(64);
}

const standIn = process.env[KEYCHAIN_STANDIN_ENV];
const next = process.env[NEXT_ENTRY_ENV];
// 자식(CLI·빌드·등록 프로젝트)이 물려받지 않게 지운다.
delete process.env[KEYCHAIN_STANDIN_ENV];
delete process.env[NEXT_ENTRY_ENV];
if (!next || !ALLOWED_NEXT.has(next)) refuse(`${NEXT_ENTRY_ENV} must be the side-effect guard or api-server.ts`);
if (!standIn || !standIn.startsWith('/') || !existsSync(standIn)) refuse(`${KEYCHAIN_STANDIN_ENV} must name an existing stand-in script`);
// 대역은 이 사이드카의 격리 루트(<root>/app-data의 부모) 안에만 있을 수 있다 — 실제 홈·저장소의 실행 파일로 돌리지 않는다.
const appData = process.env.APP_DATA_DIR;
if (!appData || !appData.startsWith('/')) refuse('APP_DATA_DIR must be the isolated app data folder');
const isolatedRoot = realpathSync(resolve(appData, '..'));
if (!realpathSync(standIn).startsWith(`${isolatedRoot}/`)) refuse('the keychain stand-in must live inside this sidecar\'s isolated root');

installDialogueKeychainStandIn(require('node:child_process') as {spawn: (...args: unknown[]) => unknown}, standIn);
await import(next);
