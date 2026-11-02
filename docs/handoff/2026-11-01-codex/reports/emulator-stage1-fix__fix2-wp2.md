# emulator-stage1-fix · fix2:wp2

(agent final report, verbatim)

English translation: "This is the setup where, once it's connected, you can just keep using it comfortably, right?"

네, 한 번 연결하면 계속 쓰는 경우를 다룬 수정입니다. 남아 있던 3번 지적을 고쳐 `emu/wp2`에 커밋했습니다(`36cc5466`, 이전 `53d8921d` 다음). 그 결과 같은 옛 refresh token을 여러 번 다시 보내도 GoTrue와 똑같이 처리됩니다.

**고친 것**
- **문제:** shim은 이미 쓴 토큰의 재사용 허용 시간을 처음 쓴 시각에서 고정해 두었습니다. GoTrue는 이미 쓴 토큰을 다시 교환할 때마다 그 시각을 갱신합니다.
- **수정:** `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_35f16659-79d-12/scripts/emulator-e2e/supabaseShim.ts` 1394행 부근에서 교환할 때마다 갱신 시각을 기록합니다.
  ```ts
  // 이전: if (!record.revoked) { record.revoked = true; record.updatedAt = now; }
  record.revoked = true;
  record.updatedAt = now;
  ```
- **바뀌지 않은 동작:** 응답을 잃은 클라이언트가 방금 바뀐 토큰을 다시 보내면 지금 유효한 토큰을 돌려주고, 그때 보낸 토큰은 건드리지 않습니다. GoTrue도 같습니다.
- **주석:** 파일 머리 주석과 refresh 함수 주석에 "허용 시간은 그 토큰을 마지막으로 교환한 시각부터 센다"고 적었습니다.
- **GoTrue 원문 직접 확인 (supabase/auth master):**
  - `GrantRefreshTokenSwap`은 토큰 상태와 관계없이 `token.Revoked = true`를 넣고 `tx.UpdateOnly(token, "revoked")`를 부릅니다.
  - `storage/dial.go`의 `getExcludedColumns`는 `updated_at`을 일부러 빼지 않습니다. 그래서 매번 `updated_at = now()`가 기록됩니다.
  - `RefreshTokenGrant`는 허용 시간을 `token.UpdatedAt`부터 셉니다.

**추가한 테스트**
`/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_35f16659-79d-12/tests/emulator-supabase-shim.test.ts`의 'GoTrue subset' 묶음에 "each swap of a used refresh token restarts its reuse interval" 테스트를 넣었습니다. 허용 시간은 10초입니다.

| 시각 | 동작 | 결과 |
|---|---|---|
| 51초 | A를 처음 사용 | 교환됨 |
| 58초 | A를 다시 사용 | 교환됨, 허용 시간이 68초까지로 밀림 |
| 65초 | A를 다시 사용 (51+10은 지났지만 58+10 안) | 교환됨 |
| 76초 (65+10 이후) | A를 다시 사용 | `refresh_token_already_used`. 세션은 남아 있음(`live`) |

각 재사용 사이에는 새 토큰을 한 번 더 교환했습니다. 그래야 응답을 잃었을 때의 재시도 처리가 대신 답하지 않고, 허용 시간 판정을 실제로 거칩니다.

**검증 (이 worktree, `bun install --frozen-lockfile`로 의존성 587개 설치)**
- 수정을 되돌린 채 `bun test --cwd tests emulator-supabase-shim -t 'GoTrue subset'`: 2 pass, 1 fail. 새 테스트가 기대값 200 대신 400을 받았습니다. 그다음 수정을 다시 넣었습니다.
- `bun run typecheck`: exit 0.
- `bun test --cwd tests emulator-supabase-shim`: 29 pass, 0 fail, expect 297개, 7.5초, exit 0.
- 같은 명령 3개를 병렬로 실행: 셋 다 29 pass, 0 fail, 각 약 12초, exit 0. 부하 평균은 약 7.6~18.6이었습니다.
- 정리 상태: shim 프로세스는 남지 않았습니다. `$TMPDIR`와 `/tmp`에 `atz-shim-*` 폴더가 0개이고, 실제 홈 아래에 새로 생긴 shim 경로도 없습니다.
- 3001·52741·4723 포트, 설치된 앱, 운영 Supabase, 키체인, TCC는 건드리지 않았습니다. 시뮬레이터와 화면 입력도 쓰지 않았습니다.

**확인이 필요한 것**
- `emu/wp2`는 다른 worktree 두 곳에서도 체크아웃되어 있습니다. 위치는 `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_35f16659-79d-2`와 `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_d5beb4e7-552-2`입니다. 그래서 저는 `git checkout --ignore-other-worktrees emu/wp2`로 가져왔습니다. 이제 브랜치는 `36cc5466`을 가리키지만 그 두 곳의 작업 파일은 아직 `53d8921d` 상태입니다. 그곳에서 `git status`를 보면 이번 변경이 거꾸로 보이니, 두 곳을 쓰기 전에 각각 `git checkout -- .`(또는 reset)로 맞춰야 합니다.
- 이 worktree에는 테스트용 `node_modules`가 남아 있습니다(gitignore 대상이라 커밋에는 없음).
