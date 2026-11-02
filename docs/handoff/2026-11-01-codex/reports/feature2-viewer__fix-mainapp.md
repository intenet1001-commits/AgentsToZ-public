# feature2-viewer · fix:mainapp

(agent final report, verbatim)

English translation: "Once it's connected, you just keep using it comfortably, right?"

모든 리뷰 지적을 고쳤고 테스트도 모두 통과했습니다. 다만 커밋은 `feat/viewer-main-app`가 아니라 새 브랜치 `feat/viewer-main-app-fix`에 있습니다.

**브랜치:** `feat/viewer-main-app`는 다른 워크트리(`/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_5de5c4d1-61e-4`)가 쓰고 있어서 git이 체크아웃을 거절했습니다. 격리 규칙상 그 워크트리에서는 git을 실행할 수 없었습니다. 그래서 그 끝(467c78e5)에서 `feat/viewer-main-app-fix`를 만들었습니다. 기존 `feat/viewer-controller-store-fix`와 같은 방식입니다. 커밋은 467c78e5의 바로 다음이라, `feat/viewer-main-app`를 497b3406으로 fast-forward만 하면 반영됩니다.

- 커밋: `497b3406 fix(viewer): check a running Viewer last, remove kept backups, open on an unreadable version`
- 바꾼 파일: `src-tauri/src/screen_helper.rs`, `src/i18n.ts`, `tests/work-mode-screen-helper.test.ts`

**지적별 처리**
1. **실행 중 확인이 너무 이름 (고침):** 두 번째 전체 서명 확인은 이제 Screen을 멈춘 뒤에만 합니다. Viewer는 실행 중 확인이 교체 직전 마지막 단계라, 그 사이에 codesign이 없습니다.
   - 테스트: `the_viewers_running_check_is_the_last_step_before_the_swap`. 이벤트 순서를 확인하고, 어느 서명 확인 중에 Viewer가 열려도 교체를 미루는지 봅니다.
   - 테스트: `screen_is_checked_again_only_after_it_was_stopped`. Screen이 실행 중이 아니면 확인 2회, 실행 중이면 3회입니다.
2. **남겨진 백업이 지워지지 않음 (고침):** 설치나 확인을 할 때마다 `sweep_backups`가 남은 백업을 정리합니다.
   - 지우는 것은 정확히 `.{stem}-backup-<32 hex>.app` 이름이고, 팀 서명을 통과하고, 실행 중이 아니고, 설치본보다 새것이 아닌 백업뿐입니다.
   - 120초가 지나지 않은 백업은 남깁니다(ctime 기준). 다른 본 앱 사본이 아직 그 백업으로 되돌리는 중일 수 있어서 제가 더한 안전장치입니다.
   - 실행 중이거나 막 만들어진 백업을 남기면 새 `kept_backup` 플래그가 켜집니다. 그러면 10분 확인이 그 백업이 사라질 때까지 다시 돕니다.
   - 설치본을 확인할 수 없으면 아무것도 지우지 않습니다. 백업이 없으면 폴더 목록만 읽고 끝납니다.
   - 테스트 3개: 실행이 끝난 백업을 다음 확인에서 지움, 지울 대상만 정확히 고름, 설치본을 확인 못 하면 다 남김.
3. **버전을 못 읽으면 열기가 막힘 (고침):** 이제 오류가 아니라 새 결과 `KeptUnordered`입니다. 설치본은 그대로 두고(경고 로그) 버튼은 그 설치본을 엽니다. Screen과 Viewer 둘 다 테스트했습니다.
4. **업데이트 대기 문구 (고침, 7개 언어):** 한국어는 「Viewer를 닫아 두면 10분 안에, 또는 여기서 열 때 바뀌어요」입니다. 「다음에 열 때」 같은 약속이 다시 들어오지 않도록 TS 단언을 추가했습니다.
5. **3-상태 열기의 Rust 테스트 (고침):** 열기를 `InstallActions::launch`와 `open_with`로 옮겼습니다.
   - `opening_answers_in_three_states`: 실행 확인됨, 미확인, `open` 실패. 앱이 없을 때, 다른 서명일 때, 설치 오류일 때는 아무것도 열지 않습니다.
   - `opening_updates_a_closed_viewer_first_and_never_stops_a_running_one`: 닫힌 Viewer는 먼저 업데이트하고, 실행 중인 Viewer는 멈추지 않습니다.
6. **문서 후속 (이 패키지에서 고치지 않음):** `docs/claude/remote-control.md:289`에 「서명이 다르면 덮어 설치한다」가 아직 남아 있는 것을 확인했습니다. `tests/screen-push-config.test.ts`의 같은 내용 주석은 grep으로 찾지 못해 확인하지 않았습니다. 이 문서와 `maintainer.json`의 `useViewerHelper.ts`·「Open the Mac viewer from work mode」 반영은 wp-docs-tester 몫이라 손대지 않았습니다.

**검증 (커밋 전에 지금 트리로 실행)**

| 명령 | 결과 |
|---|---|
| `cd src-tauri && cargo test --lib screen_helper` | 38 통과, 0 실패, 1 건너뜀(서명 빌드가 필요한 선택 테스트). `screen_helper.rs` 경고 없음 |
| `cd src-tauri && cargo test` | lib 165 통과, 0 실패, 1 건너뜀. main 0, doc 0 |
| `bun test tests/work-mode-screen-helper.test.ts tests/feature-copy-language.test.ts` | 12 통과, 0 실패 |
| `bun tests/work-mode-ui.mjs` | Chromium, WebKit 둘 다 통과 |
| `bun run typecheck` | 오류 0 |
| `bun run test:screen-control` | 102/102 검사 통과, 상태 파일 계약 일치, swift 필터 테스트 13개 0 실패 |

준비 작업으로 `bun install --frozen-lockfile`을 했고, cargo용으로 gitignore된 빈 자리표시자(`src-tauri/resources/agentstoz-api-sidecar`, `agentstoz-agent-runtime-guard`, `agentstoz-use-mcp`, `templates/.placeholder`)를 만들었습니다. 자리표시자는 커밋하지 않았습니다.

**남은 일**
- `feat/viewer-main-app`를 497b3406으로 fast-forward.
- 6번 문서 정리(wp-docs-tester).
- 전체 `bun run verify`와 클릭 스윕은 이번에 다시 돌리지 않았습니다.
- 푸시는 하지 않았고 main은 건드리지 않았습니다.
