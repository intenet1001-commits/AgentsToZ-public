# 프로젝트 학습 저장소

세션별 검증된 학습만 기록. 각 항목은 3-axis 게이팅(노벨티/임팩트/재사용성, 4/6 이상만 PASS) 통과.

---

## [2026-05-16] Windows 호환성 세션

### L-001 React useState 초기값 HMR 미재실행 → useEffect 런타임 교정 패턴 (PASS 5/6)

**노벨티 2 / 임팩트 2 / 재사용성 1**

**상황**: Windows에서 `terminalApp` localStorage 값이 `'cmux'`(macOS 전용)로 저장된 채로 앱을 열면, `useState` 초기값 함수가 정상적으로 `'wsl'`을 반환해야 하는데 HMR 환경에서 재실행되지 않아 오염 상태가 유지됐다.

**발견**: `useState(() => ...)` 초기값 콜백은 컴포넌트 최초 마운트에만 실행된다. HMR로 모듈이 교체돼도 기존 React 트리가 살아있으면 초기값 재계산 없이 이전 상태가 유지된다. 새로고침(full reload)에서는 문제없지만 개발 중 HMR 사이클에서는 잘못된 초기값이 그대로 남는다.

**교훈**: localStorage에 플랫폼 종속 값이 저장될 수 있는 경우, `useState`만으로는 부족하다. `useEffect(() => { if (!isWindows()) return; if (macOnlyValues.includes(saved)) { set(default); localStorage.set(default); } }, [])` 패턴으로 마운트 시 런타임 교정을 반드시 추가한다.

**코드 위치**: `src/App.tsx:966-974` (terminalApp useEffect 교정)

---

### L-002 .catch(()=>{}) 무소음 에러 삼킴 안티패턴 (PASS 4/6)

**노벨티 1 / 임팩트 2 / 재사용성 1**

**상황**: 폴더 열기 버튼에서 `.catch(()=>{})` 빈 catch로 에러를 삼키고 있었다. 실제로 폴더 열기가 실패해도 사용자는 아무 피드백을 받지 못했다.

**발견**: `API.openFolder(path).catch(()=>{})` 패턴은 에러 발생 시 완전히 무음 처리된다. Windows에서 경로 오류, 권한 문제 등 다양한 실패 원인이 있는데 디버깅 단서조차 없다.

**교훈**: UI 이벤트 핸들러의 `.catch`는 반드시 `showToast(e.message, 'error')`로 사용자에게 알려야 한다. 단, 폴링/백그라운드 자동 작업(상태 확인, 워크트리 cleanup 등)은 `.catch(()=>{})` 무소음이 적절할 수 있다. 구분 기준: 사용자가 명시적으로 트리거한 액션 = 에러 표시 필수.

**코드 위치**: `src/App.tsx:3686` (menu-open-folder 수정됨), `src/App.tsx:3845` (워크트리 패널 수정됨)

---

### L-003 WSL distro 탐지 첫 호출 간헐적 실패 — 캐시 미설정 시 재시도 없음 (PASS 4/6)

**노벨티 1 / 임팩트 2 / 재사용성 1**

**상황**: `findWslDistro()`가 `listWslDistros()`를 호출하는데, `reg.exe`로 레지스트리를 쿼리하는 첫 번째 호출이 간헐적으로 빈 배열을 반환했다. 이후 호출에서는 캐시(`_cachedDistros`)가 비어있기 때문에 재쿼리하지만, 첫 호출 직후에 WSL 기능을 실행하려 하면 "WSL Ubuntu distro를 찾을 수 없습니다" 오류가 발생했다.

**발견**: `_cachedDistros`는 `distros.length > 0`일 때만 설정된다. 첫 쿼리가 실패해 빈 배열을 반환하면 캐시가 채워지지 않고, 다음 호출에서 재쿼리를 시도한다(이는 올바르다). 그러나 api-server 시작 직후 `wt.exe` 탐지나 claude 실행 등 초기화 작업이 즉시 `findWslDistro()`에 의존할 경우, 첫 실패 → 에러 → 사용자에게 WSL 없다는 잘못된 메시지가 표시됐다.

**교훈**: 외부 프로세스(`reg.exe`, `wsl --list`)를 통한 환경 탐지는 앱 시작 시 워밍업(warm-up) 호출이 필요하다. `api-server.ts` 시작 시점에 `listWslDistros()`를 비동기로 미리 호출해 캐시를 채워두면 이후 실제 사용 시 간헐적 실패를 방지할 수 있다. 또는 `findWslDistro()`에 1회 재시도 로직 추가.

**코드 위치**: `api-server.ts:146-171` (`listWslDistros`, `findWslDistro`)

---

### L-004 Windows USERPROFILE vs HOME 환경변수 차이 (PASS 4/6)

**노벨티 1 / 임팩트 2 / 재사용성 1**

**상황**: macOS에서는 `process.env.HOME`이 항상 홈 디렉터리를 반환하지만, Windows(네이티브 Bun/Node)에서는 `HOME`이 undefined이고 `USERPROFILE`이 홈 디렉터리를 가리킨다.

**발견**: `api-server.ts`의 경로 계산 코드 여러 곳에서 `process.env.HOME || ''`만 참조해 Windows에서 빈 문자열이 되는 케이스가 있었다. 특히 DMG export 경로(`~/cargo-targets/...`)와 log 경로 생성에서 문제가 잠재했다.

**교훈**: 크로스플랫폼 코드에서 홈 디렉터리 참조는 반드시 `process.env.USERPROFILE || process.env.HOME || ''` 순서로 작성. Node.js의 `os.homedir()`를 사용하면 플랫폼 관계없이 올바른 홈 디렉터리 반환 — 직접 환경변수 참조보다 선호.

**코드 위치**: `api-server.ts:1132` (`USERPROFILE || HOME` 패턴이 이미 적용된 위치)

---

### L-005 claude --bg / claude agents Windows WSL 모드 지원 (PASS 5/6)

**노벨티 2 / 임팩트 2 / 재사용성 1**

**상황**: Windows에서 `claude --bg`와 `claude agents` 버튼이 표시됐지만, 기존 로직은 macOS 전용(`/Applications/cmux.app` 경로, `open -a` 등)이었다. IS_WIN 분기가 없어 명령 실행 시 조용히 실패했다.

**발견**: `spawnWslTmux(bashCmd)` 헬퍼를 활용하면 Windows Terminal(wt.exe) 또는 cmd 폴백을 통해 WSL 환경에서 Linux 바이너리(claude)를 실행할 수 있다. Windows 경로(`C:\Users\...`)를 WSL 경로(`/mnt/c/Users/...`)로 변환하는 `winToWslPath()` 유틸도 필요했다. claude --bg는 백그라운드 에이전트를 spawn 후 즉시 종료하므로 창 유지 불필요 → `Bun.spawnSync`로 직접 처리.

**교훈**: Windows에서 Linux CLI 도구(claude, tmux)를 실행하는 표준 패턴: `wsl -d <distro> -- bash -lc '<cmd>'`. wt.exe는 PATH 앱 앨리어스라 `spawn` 직접 호출 불가 → `cmd /c start wt ...` 우회 필요. WSL 경로 변환은 드라이브 레터 규칙: `C:\` → `/mnt/c/`.

**코드 위치**: `api-server.ts:1583-1603` (open-claude-bg Windows 분기), `api-server.ts:1509-1556` (open-cmux-agent-view, open-cmux-project-agents Windows 분기)

---

### L-006 Claude 열기 WSL 모드 실패 조용한 실패 — toast 미표시 (FAIL 3/6, 미해결)

**노벨티 0 / 임팩트 2 / 재사용성 1**

**점수 3/6 → GATE FAIL**

**상황 (기록용)**: powershell 모드에서는 `claude 열기`가 API 200 → 터미널 실제 열림을 확인했다. 그러나 WSL distro 탐지 실패 시 api-server가 500을 반환하는데, 프론트엔드의 `callCmux()`가 throw하고 상위 `catch` 블록에서 `showToast` 호출을 확인했음에도 실제 toast가 표시되지 않는 케이스가 있었다.

**미해결**: 재현이 간헐적이라 근본 원인 미확정. L-003(WSL distro 탐지 실패)이 선행 원인일 가능성 높음. L-003이 해결되면 이 증상도 사라질 것으로 추정. 다음 세션에서 재확인 필요.

---

## 게이팅 요약

| ID | 항목 | 점수 | 결과 |
|---|---|---|---|
| L-001 | useState HMR 초기값 미재실행 → useEffect 교정 | 5/6 | PASS |
| L-002 | .catch(()=>{}) 무소음 안티패턴 | 4/6 | PASS |
| L-003 | WSL distro 탐지 첫 호출 간헐적 실패 | 4/6 | PASS |
| L-004 | Windows USERPROFILE vs HOME | 4/6 | PASS |
| L-005 | claude --bg / agents Windows WSL 지원 | 5/6 | PASS |
| L-006 | Claude WSL toast 미표시 간헐적 실패 | 3/6 | FAIL (미해결, 기록만) |
