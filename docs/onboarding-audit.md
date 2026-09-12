# 온보딩·단말 연결 E2E 검증 가이드

로컬 첫 실행, 추가 Mac·Windows, Ubuntu/AWS 호스트 연결의 수동·자동 검증 기준이다.

## 정본 구조

| 대상 | 시작 위치 | 완료 주체 | 신원 규칙 |
|---|---|---|---|
| 첫 Mac·Windows | 새 앱 `첫 단말 · 동기화 설정` | 새 앱 | 이 앱의 UUID 사용 |
| 추가 Mac·Windows | 기존 앱 `다른 PC 연결 정보 만들기` 또는 배포 포털 `단말 연결 → Mac·Windows 연결` | 새 PC의 앱 | 기존 ID를 복사하지 않고 새 UUID 생성 |
| Ubuntu/AWS/Linux | 포털 `단말 연결 → 클라우드·서버` 또는 앱 `장기기억 → 클라우드 단말` | 서버의 v3 agent | 호스트를 먼저 등록한 뒤 프로젝트를 하위 연결 |

기존 앱과 배포 포털은 Mac·Windows 연결 정보만 만든다. DB에 빈 단말 행을 만들지 않으며,
service_role 키·로그인 토큰·기존 단말 ID를 전달하지 않는다. 새 앱은 로컬 Supabase CLI로
자기 관리자 경로를 만들고 DB upsert 응답을 확인한 뒤 등록을 확정한다.

## 자동 검증

위치: `tests/e2e/`

- `onboarding-1st.spec.ts` — 초기 선택 화면과 권장 경로 회귀 방지
- `onboarding-2nd-handoff.spec.ts` — v3 초대 붙여넣기, 새 신원, 잘못된 payload, 포털 연결 UI
- `tests/desktop-device-pairing.test.ts` — 포털·앱·API·Codex/Claude 온보딩 계약

로컬 dev server가 실행 중일 때:

```bash
bun tests/e2e/onboarding-1st.spec.ts
SKIP_DEPLOYED_PORTAL=1 bun tests/e2e/onboarding-2nd-handoff.spec.ts
bun test tests/desktop-device-pairing.test.ts tests/onboarding-handoff.test.ts tests/onboarding-contract.test.ts
```

배포 확인에서는 `SKIP_DEPLOYED_PORTAL`을 제거한다. 실제 AWS mutation과 실제 추가 단말 등록은
테스트용 호스트·프로젝트에서만 수행한다.

## 수동 검증 체크리스트

### 초기 선택 화면

- [ ] 로컬 사용은 계정 없이 건너뛸 수 있다
- [ ] `첫 단말 · 동기화 설정`과 `두 번째·추가 기기 연결`이 구분된다
- [ ] `/api/onboarding/status`가 key 값 없이 fresh/configured-unregistered/additional-pending/registered를 판정한다
- [ ] 이미 등록된 앱에서는 추가 단말 카드가 `다른 PC 연결 정보 만들기`로 바뀐다
- [ ] Codex·Claude 에이전트 프롬프트가 첫 단말/추가 단말/Ubuntu를 각각 구분한다

### 추가 Mac·Windows

- [ ] 개인 Vercel 포털 없이 첫 단말 앱에서 v3 연결 정보를 만들 수 있다
- [ ] 배포 포털 `단말 연결 관리`에 `Mac·Windows 연결`과 `클라우드·서버`가 별도 영역으로 보인다
- [ ] 새 단말 이름을 입력해야 `연결 정보 복사`가 활성화된다
- [ ] 초대 JSON이 `v: 3`, `type: portmgr-device-invite`, URL·anon/publishable key·추천 이름만 포함한다
- [ ] service_role 키·Supabase 토큰·기존 단말 ID가 초대에 없다
- [ ] 새 PC 앱에서 붙여넣으면 URL/anon key와 RLS 차단을 자동 검사한다
- [ ] `supabase login` 후 `Supabase CLI에서 자동 연결`이 성공한다
- [ ] 새 UUID로 `portmgr_devices` 행이 하나만 생긴다
- [ ] DB 응답 전에는 `pendingDeviceRegistration=true`, 확인 후에만 false가 된다
- [ ] 완료 응답을 잃고 재시도해도 같은 UUID를 사용한다

### Ubuntu/AWS/Linux

- [ ] 호스트 이름·환경을 고른 뒤 호스트용 일회용 명령을 만든다
- [ ] 만료 시간 안내가 “초대 명령 유효 시간”이며 등록 연결 유지 시간이 아님을 설명한다
- [ ] 명령 실행 뒤 호스트 카드가 먼저 생긴다
- [ ] 호스트 아래에 `새 프로젝트`, `GitHub 복제`, `장기기억 복원`이 보인다
- [ ] 프로젝트별 기억 해시·시간과 Git HEAD/ahead/behind/dirty가 표시된다
- [ ] 등록 해제는 credential만 폐기하고 과거 기억/Git 이력을 지우지 않는다

### 접근성·반응형

- [ ] 375px에서 호스트 이름과 프로젝트 수가 액션 버튼 때문에 사라지지 않는다
- [ ] 단말 연결 모달에 dialog 이름, 제목, 닫기 버튼 이름이 있다
- [ ] Tab 포커스가 모달 안에서 순환하고 Escape 후 열기 버튼으로 돌아간다
- [ ] 가로 스크롤과 44px 미만 핵심 터치 컨트롤이 없다

## 실패 판정

- 포털이 단말 행을 먼저 만들면 고아 가능성이 있으므로 P1 이상이다.
- 새 PC가 기존 단말 ID를 채택할 수 있으면 신원 충돌이므로 P1 이상이다.
- service_role 키나 로그인 토큰이 초대·클립보드에 들어가면 P0다.
- 서버 프로젝트가 호스트 없이 최상위 단말처럼 등록되면 계층 오류다.
- 중단 후 재시도가 새 UUID를 만들거나 최종 프로젝트 폴더를 막으면 복구 실패다.
