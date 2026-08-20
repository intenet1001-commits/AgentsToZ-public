# 온보딩 동선 E2E 검증 가이드

Phase 1 + 2 + 3 재설계 후 동선의 수동/자동 검증 방법을 기록한다.

## 재설계 요약

| 영역 | 변경 |
|------|------|
| **choose 화면** | 6개 카드 → 3개 (처음/추가 기기/개발 환경). 북마크 포털 배포는 1st 완료 후 안내로 이동. Windows/macOS는 `DevEnvWizard` 안에서 OS 토글로 통합. |
| **Handoff** | 포털 웹 헤더에 `[Link2] 새 기기` 버튼 → JSON payload `{v:1, type:'portmanager-setup', url, key, pwHash, copiedAt}`를 클립보드 복사 |
| **Paste** | 로컬 앱 `AdditionalDeviceWizard` Step 1 상단에 `[ClipboardPaste] 붙여넣기` 카드 → URL/Key 자동 입력 + 자동 연결 테스트 |
| **디버그** | 연결 실패 시 `🛠 디버그 정보 복사` 버튼 (timestamp, platform, url/key prefix) |
| **Vercel 자동 배포** | `/api/deploy-portal` (SSE-like 폴링) + PortalVercelWizard Step 3 `🚀 자동 배포 시작` 원클릭 + URL 자동 clipboard |

## 자동 E2E (Playwright 스크립트)

위치: `tests/e2e/`

- `onboarding-1st.spec.ts` — choose 화면 3분기 + Step 1 붙여넣기 버튼 노출 회귀 방지
- `onboarding-2nd-handoff.spec.ts` — 클립보드 payload 주입 → 붙여넣기 → URL 자동 입력 / 잘못된 payload 에러 / 포털 웹 복사 버튼

실행 (로컬 dev server + 포털 배포 완료 후):

```bash
# 개별 실행
node tests/e2e/onboarding-1st.spec.ts   # bun은 Windows에서 chromium launch timeout 이슈
node tests/e2e/onboarding-2nd-handoff.spec.ts

# 또는 playwright-skill 경로로
cd ~/.claude/skills/playwright-skill && node run.js path/to/spec.ts
```

**참고**: Windows + bun + playwright.chromium.launch()는 headless 모드에서 간헐적 timeout 있음 (180초). `node`로 실행 권장, 또는 `headless: false`로 변경.

## 수동 검증 체크리스트

### Phase 1 (UI 재설계)

- [ ] `bun run start` → localhost:9000 접속
- [ ] 초기 설정 마법사 진입 (`portal.json` 없는 신규 환경 가정, 또는 `localStorage.clear()` 후)
- [ ] choose 화면에 **3개 카드만** 보이는지 확인 (포털 배포 카드 없음, Windows/macOS 개별 카드 없음)
- [ ] "🔗 추가 기기 연결" 클릭 → 에메랄드 보더 강조 (빠름 배지) 확인
- [ ] Step 1 상단에 `📋 1st 기기 설정 붙여넣기` 파란색 박스 노출
- [ ] "⚙️ 개발 환경 설정" 클릭 → 상단 OS 토글 + Windows/Mac 위자드 내용

### Phase 1 (Handoff)

- [ ] 포털 웹 ([https://portmanager-portal.vercel.app](https://portmanager-portal.vercel.app)) 접속
- [ ] 비밀번호 입력 후 헤더 우측에 🔗 "새 기기" 버튼 확인
- [ ] 클릭 → 토스트 "설정 복사됨 — 새 기기의 로컬 앱 → 설정 → 추가 기기 → 붙여넣기"
- [ ] 클립보드 내용이 유효 JSON인지 확인 (브라우저 devtools: `await navigator.clipboard.readText()`)
- [ ] JSON에 `v: 1`, `type: 'portmanager-setup'`, `url`, `key`, `pwHash`, `copiedAt` 모두 존재
- [ ] 다른 기기의 로컬 앱 → 초기 설정 → "추가 기기 연결" → Step 1 → 붙여넣기 클릭
- [ ] URL / Key 필드 자동 입력 + 체크마크 "✓ URL/Key 자동 입력됨 — 연결 테스트 자동 실행"
- [ ] 연결 테스트 자동 통과 → "✅ 연결 성공!"

### Phase 1 (피드백)

- [ ] Step 1에서 가짜 URL/Key 입력 → "연결 테스트" → "❌ 연결 실패"
- [ ] 실패 블록 아래 `🛠 디버그 정보 복사` 버튼 노출 → 클릭 → 클립보드에 JSON 복사됨
- [ ] JSON에 `timestamp`, `platform`, `urlPrefix`, `keyPrefix`, `keyLength` 필드 포함

### Phase 2 (Vercel 자동 배포)

- [ ] 포털 배포 마법사 진입 (초기 설정 마법사 `portal` 모드로 직접 진입 — 현재는 choose에서 제거됐으므로 1st 완료 후 "다음 액션"에서 진입, 또는 legacy URL로 진입)
- [ ] Step 3 "🚀 자동 배포 시작" 버튼 노출
- [ ] Vercel CLI 로그인된 상태에서 클릭 → 로그 실시간 스트림
- [ ] 완료 후 `https://*.vercel.app` URL 자동 파싱 + 클립보드 복사
- [ ] 배포 실패 시 exit code 표시 + "다시 시도" 버튼 동작

## CS-test 14-agent (향후)

프로덕션 배포 후 `/cs-experiencing test http://localhost:9000` 실행 → 접근성, 시각, 보안, SEO, PWA, 성능, 이미지, 터치 등 14개 에이전트 병렬 스캔. 결과는 이 파일 하단 "## CS-test 실행 기록" 섹션에 append.

현재는 실행 보류 — 배포 안정화 후 별도 세션에서 수행.

## 변경 파일

- `src/portal-main.tsx` — `handleCopySetup`, 헤더 `[Link2] 새 기기` 버튼, 모바일 더보기 메뉴 항목
- `src/SetupWizard.tsx` — `AdditionalDeviceWizard`에 `handlePasteSetup` + Step 1 UI, choose 3분기 카드, `DevEnvWizard` 래퍼, `PortalVercelWizard` Step 3 자동 배포 UI, 디버그 복사 버튼 (양쪽 위자드)
- `api-server.ts` — `/api/deploy-portal` 3종 엔드포인트 + `/api/vercel-whoami`
- `tests/e2e/onboarding-1st.spec.ts` (신규)
- `tests/e2e/onboarding-2nd-handoff.spec.ts` (신규)

## CS-test 실행 기록

_(아직 없음 — 배포 후 추가)_
