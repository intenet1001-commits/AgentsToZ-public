# 텍스트·음성 오케스트레이션과 OPS 이름 통일 (2026-09-29)

사용자 지시(2026-09-29): 아젠투지를 텍스트(워크룸)와 음성(아젠투지 호출)으로 쉽게 오케스트레이션하는 것을
충분히 시험하고 고친다. 워크룸끼리의 대화가 같은 모델 안에서만 되는지 확인하고, 다른 모델로도 되게 한다.
`AgentsToZ-Control`을 폴더·GitHub 저장소까지 `AgentsToZ-OPS`로 통일하고, 다른 Mac이 새 버전을 설치해도
같은 상태가 되게 한다.

## 이 문서가 대체하는 결정

| 예전 결정 | 어디 | 바뀐 내용 |
|---|---|---|
| `@받는 곳` 전달은 **대상 프로젝트의 같은 AI** | `docs/plans/workroom-performance-2026-09-23/EXECUTION.md:52` | 「받는 AI」를 고른다. 기본값은 대상에 실행 중인 세션의 AI, 없으면 보내는 세션의 AI. 실행 중인 세션이 있으면 그 세션에 전달하고 새로 만들지 않는다 |
| OPS 폴더·저장소 이름 `AgentsToZ-Control`은 바꾸지 않는다(Phase C 보류) | DEV 기억 `3b7d4490e5ab4fdd96c1a0e7`, `README.md:57`, `docs/control-profile.md` | 폴더·GitHub 저장소를 `AgentsToZ-OPS`로 바꾼다. 저장소는 **제자리 rename**(node ID `R_kgDOUX_s3Q` 유지)이고, 옛 이름은 판정·복원에서 영구히 인정한다 |
| 음성 `connect_project_delegate`는 AI를 지정해도 실행 중인 아무 세션이나 재사용 | `tests/voice-runtime.test.ts` 옛 단언 | 지정한 AI의 세션만 재사용하고, 없으면 그 AI로 새로 연다 |

## 핵심 설계

1. **모델을 가리지 않는다.** `agentstoz_use` 워크룸 도구는 호출한 AI가 무엇이든 어떤 AI의 워크룸이든 시작·지시·
   읽기·닫기를 한다. 실측(2026-09-29, v541): agy(Gemini 3.8 Flash) OPS 워크룸이 Claude 워크룸을 시작해 지시하고
   결과를 읽어 왔다. 막힌 곳은 모델이 아니라 ① agy의 도구별 승인 화면, ② 장기기억 없는 프로젝트 거절(Buzz 전용
   조건이 새어 나옴), ③ 가장 오래된 raw 출력부터 읽는 read, ④ 세션을 닫을 도구가 없음이었다.
2. **이름 판정은 한 곳.** `src/opsFolderName.ts`의 `isOpsFolderName`만 쓴다. 옛 이름 리터럴 비교를 다시 쓰지 않는다.
3. **기억 레지스트리 키는 고정한다.** `memory_id`(PK) ↔ 저장소 키(UNIQUE)라서 origin만 새 URL로 바꾸면 claim이
   충돌한다. `git config --local agentstoz.repositoryKey`로 옛 키를 고정한 뒤 origin을 바꾼다. DB 마이그레이션 없음.
4. **텍스트와 음성은 같은 대상 목록을 쓴다**(`src/conversationTargetDirectory.ts`). 이름은 등록 이름, 별명은
   aiName·런타임 라벨, 역할은 Control 바인딩 기준. 못 찾으면 후보를 돌려주고 AI가 발음(바이브2 → vibe2)으로 골라
   다시 해석한다. 해석기 자체는 추측하지 않는다.
5. **「열어」와 「불러」를 나눈다.** 「<프로젝트> 열어」는 앱에서 그 프로젝트를 보여 주고(`open_dashboard(portId)`,
   음성 `open_project`), 「<프로젝트> 담당자 불러」는 그 프로젝트 워크룸을 이어 쓰거나 연다.
6. **기록 위치.** OPS 음성은 OPS 범위, 프로젝트 음성은 그 프로젝트 범위에 남는다. OPS 음성 정체성은 폴더 경로와
   무관하게 계산하고, 이름 변경 전 기록은 `binding.legacyRoots`로 계속 검토·저장할 수 있다.

## 검증

- 단위·계약: `bun run verify`(typecheck + bun test + cargo test) 0 fail.
- 결정적 중첩 오케스트레이션: `tests/agentstoz-use-nested-orchestration.test.ts` — 가짜 CLI 안에서 실제 MCP
  서버를 stdio로 띄워 4×4=16쌍을 몰고 닫는다.
- 실기(설치된 앱): 교차 모델 쌍, AI별 한 줄·세 줄 전달, 「바이브2 열어/불러」, 마이그레이션 결과를 이 문서
  아래 「실측 결과」에 기록한다.

## 실측 결과

### 최종 소스·검증·배포

- 최종 제품 소스: `739a6a290cf65e5a48effc4e4c5ba95a2f4900f3`(v547), `origin/main`과 일치.
- 최종 기능 수정:
  - 긴 Codex 오케스트레이션 프롬프트가 붙여넣기 뒤 확정되도록 입력 제출 타이밍을 보강했다(`e46ee50`).
  - 빈 Hermes 컨트롤러도 대화형으로 남도록 항상 `hermes chat`으로 시작한다(`57a35eb`).
  - agy가 `open_dashboard`에 존재하지 않는 `projectId`를 보내도 일반 대시보드 열기 성공으로 축소되지 않도록
    `portId` 사용을 명시한 오류로 거절한다(`45b0c94`). 실제 대상 열기 성공을 도구 성공으로 오인하던 원인이었다.
- 최종 `bun run verify`: maintainer Python **54 pass**, TypeScript 0 error, Bun **5,287 pass / 0 fail**
  (35,889 expect, 699 files), Rust **69 pass / 0 fail**.
- macOS 설치본: **547.0.0**, sidecar health schemaVersion 14. DMG:
  `~/cargo-targets/portmanager/release/bundle/dmg/AgentsToZ_byCS_547.0.0_aarch64.dmg`,
  SHA-256 `cbd3fce3c387f37063837d719d8d0b4e7943c117efe3bb8f74f26c716f2dc23a`.
- TestFlight: 번들 `com.intenet.agentstoz.mobile.testflight`, **547.0.0 (547)** 업로드 및 Apple 처리
  `VALID`. build ID `926a73a3-c058-4296-b042-20330c4e490d`를 「개인 테스트」 그룹
  `b9fb2b83-2488-4ab6-9cec-9f7a242b5253`에 연결(HTTP 204).

### 설치 앱 실기 E2E

- 교차 모델: codex→codex, agy→claude, codex→agy, claude→hermes, hermes→codex,
  claude→codex 회신을 모두 통과했다. 각 판정은 새 워커 생성, nonce 응답, 종료까지 확인한다.
- 전달: Codex·Claude·agy·Hermes 각각 한 줄/세 줄을 정확히 한 번 전달하고 새 응답에서 동일 내용을 확인했다.
- 이름 라우팅: Codex와 agy에서 「바이브2 담당자 불러」가 등록 프로젝트의 올바른 AI 세션을 한 번만
  만들거나 재사용했다. v547에서 agy의 「바이브2 프로젝트 열어」도 실제 프로젝트 화면 이동까지 통과했다.
- 테스트가 만든 워크룸은 종료했으며 기존 사용자 워크룸은 건드리지 않았다.

### 남은 실기 확인

- 음성의 OpenAI/Gemini 각각 「아젠투지 → 바이브2 담당자 불러」는 실제 음성 입력·외부 provider가 필요한
  사용자 실기라 자동 완료 처리하지 않았다.
- 다른 Mac의 첫 업데이트 마이그레이션과 TestFlight 547이 실제 iPhone의 「개인 테스트」 목록에 표시되는지는
  해당 기기에서 확인이 필요하다. 업로드·VALID·그룹 연결까지는 완료됐다.
- 후속 낮은 위험 항목은 새 이름 URL 최초 clone의 자동 백업(L2), close의 memorySave 관찰(B8),
  MCP stdio의 긴 wait 직렬 블로킹(B5)이다.

### 후속 실측 (2026-09-29, Claude Code)

- OPS 운영기억: MCP bridge가 이번에는 정상 응답했다. profile revision `5b51a7a1…`로
  `agentstoz_use_propose_control_memory` 제출 → **pending 후보** `a3459588-408e-4cff-9440-23d2d81f731e`
  (saved=false). 검토·승인은 하지 않았다 — AgentsToZ 패널에서 사용자가 검토한다.
- iPhone 13 Pro Max(iOS 26.3, USB wired, Developer Mode on):
  - 설치 전 상태: `…mobile` 464.0.0, `…mobile.dev` 537.0.0, **`…mobile.testflight` 미설치**.
  - `install:ios:development`로 개발 앱을 **547.0.0 (260929114759, 커밋 1c5b3e0)** 으로 갱신·실행,
    새 설치 경로의 프로세스 생존 확인.
  - `check-ui.py --device`(격리 `…mobile.uitest` 번들)는 **빌드 단계에서 실패**: App Group
    `group.com.intenet.agentstoz.mobile.uitest`가 개발자 계정에 등록돼 있지 않아 프로비저닝 프로파일이
    `com.apple.security.application-groups` entitlement와 불일치(`.uitest`·`.uitest.share` 둘 다).
    기기에는 아무것도 설치되지 않았다. App Group 등록은 웹 전용이라 사용자 1회 작업이 필요하다.
  - TestFlight 547의 「개인 테스트」 표시·설치·실행은 여전히 사용자 기기 조작 대기.
