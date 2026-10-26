# VOC(개선 요청) · 웹 배포(Vercel)

> CLAUDE.md에서 옮긴 상세 노트다(2026-10-24, 원문 그대로 · 제목 수준만 한 단계 올림). 이 영역의 코드를 고치기 전에 읽는다.
> 새 결정·함정은 이 파일에 적고, CLAUDE.md에는 색인 한 줄(필요하면 절대 규칙 한 줄)만 더한다. 「위/아래 절」이라는 말은 옮기기 전 CLAUDE.md 안의 위치를 가리킬 수 있다 — 색인에서 찾을 것.

## VOC(개선 요청) — 화면에서 집어 남기고, 폴더에서 일괄 검토

개선을 하나씩 말로 전달하면 그때그때 세션이 필요하다. 헤더의 말풍선 버튼(`voc-toggle`)을
켜고 **개선하고 싶은 영역을 클릭 → 코멘트 저장**하면, 나중에 한 번에 검토할 수 있다.

| | |
|---|---|
| 저장 위치 | `~/Library/Application Support/com.portmanager.portmanager/voc/` — 한 건당 파일 하나 |
| 파일명 | `YYYY-MM-DD-HHMM-<앵커>.json` (시간순 정렬 · Finder에서 바로 읽힌다) |
| 검토 | 세션에서 `voc/*.json`을 읽고 처리 → 처리분은 `voc/done/`으로 이동 |
| 엔드포인트 | `POST /api/voc` (로컬 저장 후 선택 전송) · `GET /api/voc` (목록) · `GET /api/voc/access` (차단 확인) |

- **로컬 저장은 항상 먼저 성공해야 한다.** `VITE_VOC_ENDPOINT`가 설정된 공식 빌드에서 사용자가
  `개발자에게 전송`을 선택한 경우만 `submit-voc` Edge Function으로 보낸다. service-role 키는 앱에
  넣지 않고 Edge Function이 service-only RPC를 호출한다. 실패·접수 중지·하루 한도 초과는 로컬 파일을
  롤백하지 않으며 `delivery` 결과를 그 파일에 남긴다.
- **하루 한도와 차단은 DB 트랜잭션이 강제한다.** 기본 설치 UUID당 10회(관리자 1~100회 조정),
  `portmgr_voc_blocklist`는 `voc`/`app` 범위와 만료 시각을 가진다. 설치 UUID 원문은 Edge에서 SHA-256
  해시한 뒤 버린다. 앱 차단 확인이 네트워크 문제로 실패하면 fail-open한다.
- **선택은 두 가지다.** 클릭 = 커서 아래 **아무 요소나**(버튼이 아니어도 된다 —
  제목·문구·여백이 오히려 요청이 많이 나오는 자리다. `findTargetAt(x, y, { allowAny: true })`).
  드래그 = 그린 사각형이 대상. 6px 미만으로 흔들린 클릭은 손떨림으로 보고 요소 선택으로 처리한다.
- **영역 앵커의 근거는 좌표가 아니라 `contains`** 다 — 창 크기가 바뀌면 같은 좌표에 다른 것이
  있다. 영역과 겹치는 `data-help-key`/`data-testid`를 최대 12개까지 함께 적어 두고 그 이름으로
  위치를 되찾는다(`namedElementsInRect`). 이름 붙은 요소가 하나도 없어도 앵커는 만들어진다.
- **앵커 우선순위는 `data-help-key` → `data-testid` → 보이는 텍스트**
  (`src/vocAnchor.ts`가 정본). 코멘트는 남긴 순간이 아니라 몇 주 뒤에 쓰이므로,
  "그 줄 세 번째 버튼" 같은 위치 기반 앵커는 그때 아무 의미가 없다.
- **앵커는 파일명이 된다 = 파일시스템에 닿는 입력이다.** 서버가 `normalizeVocAnchor`로
  타입·길이를 자르고 `vocSlug`가 경로 구분자를 없앤다. 같은 분에 같은 요소를 두 번 남기면
  덮어쓰지 않고 `-2` 접미사를 붙인다 — 덮어쓰면 방금 쓴 글이 사라진다.
- **대상 선택 규칙은 가이드 모드와 공유한다**(`src/guide/pickTarget.ts`). 두 모드가 서로
  다른 요소를 집으면, 가이드에서 설명을 본 그 버튼에 코멘트를 달 수 없게 된다.
- ⚠️ **고른 뒤에는 대상을 고정한다.** 가이드 모드의 60fps rAF 추적(`isElementVisible`
  조상 순회)을 쓰지 않으므로 VOC 모드가 더 가볍다. 글을 쓰는 동안 커서가 움직여도 대상이
  바뀌면 안 된다는 이유가 먼저다.
- ⚠️ **배너가 상단 36px을 가리므로 `body.voc-mode-active`로 앱을 밀어 내려야 한다.**
  이 규칙을 빠뜨리면 헤더 툴바 버튼에는 코멘트를 남길 수 없다(실측으로 걸렸다).
  가이드 모드와 같은 CSS 규칙을 공유한다.
- 두 모드는 **배타적**이다 — 둘 다 전체 화면 오버레이라 동시에 켜면 클릭을 서로 가로챈다.
- VOC 모드는 **저장하지 않는다**(세션 한정). 켠 채로 앱을 다시 열면 클릭이 전부 막혀 고장으로 읽힌다.
  가이드(안전 탐색) 모드도 같다 — 한동안 `pm-guide-mode`로 저장돼 재시작 후 모든 클릭을 막았다(2026-09 감사).
  앱은 이제 그 옛 키를 시작 시 지운다.
- **모달 위에서는 `⌘/Ctrl+Shift+V`로만 켤 수 있다.** 헤더 버튼은 모달(z 9500)에 덮여
  눌리지 않아서, 정작 팝업 안의 불편에는 코멘트를 남길 수 없었다. 오버레이 자체는 모달보다
  위(z 2^31 근처)라 **켜지기만 하면** 모달 내용도 정상적으로 집힌다 — 막힌 것은 켜는 방법뿐이었다.
  단축키는 capture 단계에서 받아 모달의 키 핸들러보다 먼저 처리한다.
- **사진은 선택 첨부이고, 처리되면 지운다**(2026-09-27). 한 VOC = `voc/<이름>.json` + `voc/attachments/<이름>/1.jpg…`
  (최대 5장, 장당 8MB, 바이트 매직으로 형식 판정). 저장·정리는 `src/vocStore.server.ts` 한 곳이다 — 사진을 임시 폴더에
  다 쓴 뒤 옮기고 **JSON을 마지막에** 써서 목록에는 늘 완성된 세트만 보인다. `POST /api/voc/done`이 done/ 이동 + 사진 삭제를
  하고, AI가 JSON을 직접 옮겨도 `GET /api/voc`의 정리(`sweepVocAttachments`)가 주인 없는 첨부 폴더를 지운다.
  데스크톱 폼은 첨부 버튼·⌘V·끌어 놓기(앱은 Tauri `onDragDropEvent` 경로, `src/voc/vocDropCapture.ts`가 그동안
  FolderDropZone의 프로젝트 추가를 막는다)와 「저장 후 워크룸으로 처리」를 준다.

### 휴대폰 VOC — 사진은 암호문으로 Storage를 잠깐 거친다

릴레이 평문은 11,000바이트라 사진이 들어가지 않는다. 그래서 휴대폰(`src/remoteVoc.ts`)은 사진마다 새 AES-256-GCM 키로
암호화한 **암호문만** 비공개 버킷 `portmgr-voc-transit`(`<hostId>/<uid>/<uuid>.bin`)에 올리고, **전부 올린 뒤에만**
E2E 릴레이로 VOC 메시지 하나(고칠 내용 + 첨부마다 경로·서명 token·키·sha256·mime·크기)를 워크스페이스 채널
`voc.submit`으로 보낸다. Mac(`src/vocRemoteReceive.server.ts`)은 전부 내려받아 복호화·해시·형식을 확인해야 저장하고,
하나라도 실패하면 **저장하지 않는다**(반쪽 VOC 없음). 계약·검증은 `src/vocAttachments.ts`.
- 다운로드 URL은 휴대폰이 준 문자열이 아니라 **이 Mac의 Supabase 주소 + token**으로 다시 만든다(SSRF 방지).
- Storage 객체: service_role이 있는 Mac은 받자마자 지우고, 없으면 `transitDeleted:false`를 받은 휴대폰이 곧바로 지운다.
  전달 못 된 객체는 Mac이 한 시간마다(24시간 초과분) 지우고, 휴대폰도 자기 폴더를 정리한다. storage 테이블을 SQL로 지우지 않는다.
- `voc.submit`은 기능 권한(scope) 없이 **그 기기가 허용받은 프로젝트 범위**(DEV)만 요구한다 — 그 워크룸에 입력할 수 있는 기기에게
  메모를 남기는 두 번째 스위치는 의미가 없다. Mac이 `voc-v1`을 광고할 때만 휴대폰이 보낸다. 기능 목록 상한은 8개이고 **지금 8개로 꽉 찼다**(`voc-inbox-v1` 추가) —
  옛 휴대폰은 9개째에서 목록 전체를 거절하므로, 다음 기능은 상한을 올리는 호환 절차 없이 광고하지 말 것.
- Mac에 닿지 않을 때(오류 자체가 연결 실패인 경우가 많다)는 글만 `portmgr_client_errors`로 남긴다. 사진은 그 표에 절대 넣지 않는다.
- 모든 오류 문구 옆 「VOC 보내기」「워크룸으로 VOC 처리」는 `ErrorVocActions`(`src/RemoteVocComposer.tsx`) 하나다. provider가 있는
  휴대폰 화면에서만 그려지므로 공용 컴포넌트(AiTerminalPanel 등)에 넣어도 데스크톱에는 나타나지 않는다. 새 오류 표면을 만들면 여기에 붙일 것.
- iOS 사진 앱 공유(Share Extension `AgentsToZShare`)는 **보내지 않는다** — 릴레이 키와 Supabase 세션은 앱의 WKWebView 저장소에만 있다.
  App Group 보관함(`voc-outbox/`)에 넣고, 앱이 앞으로 오면 `agentstoz-voc-share` 이벤트로 페이지에 넘긴다(ack 후 삭제, id로 중복 제거).
  ⚠️ **페이지는 「보내지 않은 캡처」(이 origin의 IndexedDB, `src/vocShareCaptureStore.ts`)에 먼저 담은 뒤에만 ack한다.**
  예전에는 작성 화면을 연 순간 ack해서, 보내지 않고 닫으면 사진이 사라졌고 두 건을 연달아 공유하면 뒤의 것이 앞의 작성 화면을 덮었다.
  캡처는 VOC를 보내거나 「삭제」를 눌러야 지워지고, 닫으면 고친 글·남긴 사진이 그대로 남는다. 가득 차면(20개) ack하지 않아 App Group에 남는다.
  순서의 정본은 `receiveVocShareDelivery` 하나다(포털과 e2e fixture가 같이 쓴다).
- **쌓인 VOC는 나중에 처리한다(`voc.inbox`, 기능 `voc-inbox-v1`).** 휴대폰 「VOC」 버튼(`remote-voc-open`)과 원격 작업의 「쌓인 VOC」가
  같은 화면(`RemoteVocHub`)을 연다: 새 VOC 작성 · 보내지 않은 캡처 · Mac에 쌓인 VOC(개수·최근 12건 요약) · 「쌓인 VOC 워크룸으로 처리」 ·
  한 건만 워크룸으로. `voc.inbox`는 **읽기**라 워크스페이스 읽기 예산(분당 60)을 쓰고 VOC 보내기 예산(분당 10)은 건드리지 않는다.
  응답은 요약뿐이다(`src/vocInboxSummary.ts` — 파일명·시각·출처·첫 줄 60자·사진 개수). 절대경로·사진 바이트는 싣지 않고, 한 건 초안은
  `photoCount`만 넘겨 AI가 Mac의 `GET /api/voc`에서 경로와 전체 내용을 읽는다. 기능이 없는 옛 Mac에는 요청하지 않고 「Mac 앱 업데이트 필요」를
  보여 주되, 목록 없이도 전체 초안은 넘길 수 있다(프롬프트가 Mac에서 직접 읽으므로). 워크룸에는 언제나 **초안만** 채운다.
  Mac 쪽 개선 요청 상자에도 같은 두 버튼(`voc-inbox-workroom`·`voc-inbox-item-workroom`)이 있다. 검증: `tests/voc-inbox-remote.test.ts`,
  `tests/voc-share-capture-store.test.ts`, `tests/remote-voc-hub.e2e.mjs`(격리 fixture, IndexedDB 실제 사용).
- **버킷·정책 마이그레이션 `20260927010000_voc_transit_storage.sql`은 라이브에 적용돼 있다(2026-10-06 실측:
  `storage.buckets`에 `portmgr-voc-transit`이 있고 `public=false`).** 아래는 미적용 기기·DB에서의 동작이다 — 미적용이면 휴대폰은
  「사진 전송용 저장소가 아직 준비되지 않았습니다」를 보여 주고 글만 보낼 수 있다.

## 웹 배포(Vercel) — 커밋 이메일이 곧 배포 가능 여부다

본인이 소유한 GitHub 저장소의 `main`을 본인의 Vercel 포털 프로젝트에 연결한다.
빌드는 `npx vite build --config vite.portal.config.ts` → `dist-portal`이다.

⚠️ **Vercel은 커밋 작성자를 GitHub 사용자와 연결하지 못하면 배포를 조용히 차단한다.**

```
readyState: BLOCKED
readyStateReason: "The Deployment was blocked because GitHub could not
                   associate the committer with a GitHub user."
seatBlock.blockCode: COMMIT_AUTHOR_REQUIRED
```

- **침묵이 이 사고의 핵심이다.** 빌드가 시작조차 하지 않아 로그가 비어 있고(0ms), GitHub에는
  실패 표시가 없으며, 프로덕션 URL은 **옛 번들을 계속 200으로** 서빙한다. 실측(2026-08-14)
  11커밋(v177~v181)이 이렇게 쌓여 웹이 14시간 넘게 멎어 있었는데 아무 신호도 없었다.
- 갈린 지점은 오직 git 이메일이었다 — 예외 없음:

  | 커밋 이메일 | 결과 |
  |---|---|
  | `intenet1001@gmail.com` | READY 10건 |
  | `cs-work@cs-workui-MacBookPro.local` | BLOCKED 13건 |
  | `ubuntu@ip-…compute.internal` (AWS) | BLOCKED 1건 |

- 원인은 그 기기에 `user.email`이 설정돼 있지 않아 git이 **호스트명으로 주소를 자동 생성**한
  것이다. 새 기기·새 워크트리·AWS 인스턴스를 붙일 때마다 재발할 수 있다:

      git config --global user.email "<GitHub에 등록된 이메일>"
      git config --global user.name  "<GitHub 사용자명>"

- **이미 쌓인 차단 커밋은 히스토리를 고칠 필요가 없다.** 이메일이 정상인 기기에서 커밋을
  하나 올리면 그 배포가 현재 트리 전체를 배포하므로 밀린 작업이 한 번에 라이브로 간다.
- 재발 방지: CI `commit-author` 잡(`scripts/check-commit-authors.ts` +
  `src/commitAuthorCheck.ts`)이 push마다 범위를 검사해 **조용한 차단을 시끄러운 실패로** 바꾼다.
  판정은 확실한 것만 잡는다(로컬 도메인·점 없는 도메인·빈 값) — 거짓 실패로 남의 푸시를
  막는 쪽이 놓치는 것보다 나쁘다.
- 진단은 CLI가 아니라 API로 봐야 한다. `vercel inspect --logs`는 BLOCKED에서 아무것도 주지
  않는다. `GET /v13/deployments/<id>`의 `readyStateReason`·`seatBlock`을 봐라.
- ⚠️ **"화면에 반영됐다"로 배포 여부를 판단하지 말 것.** Supabase 데이터 변경은 **옛 번들에서도
  즉시 보인다** — 실측(2026-08-14) 기기 이름을 DB에서 고치자 포털에 바로 떴지만 번들은 14시간
  전 v176 그대로였고, 그래서 "배포가 됐는데 기능만 없다"로 잘못 읽혔다. 코드가 나갔는지는
  번들을 직접 봐야 한다: `curl <site>/assets/index-*.js | grep <새 testid>` 와 같은 파일의
  `buildNumber:` / `builtAt:`(vite config의 `createBuildInfo`가 심는다).
