# 웹·데스크톱 전수 클릭 대상 계약

공통 러너 1.9.0 / 웹 엔진 1.1.0부터 대상 종류와 실행 환경을 분리한다.
공통 러너는 데스크톱 입력 드라이버를 설치하거나 제공하지 않는다. 실제 데스크톱 앱의 기동·요소 수집·클릭·비교는 프로젝트가 검토한 하네스가 수행한다. 하네스가 없으면 **구성 필요/실행 불가**이며 통과가 아니다.

다른 등록 프로젝트에서도 공통 러너 1.9.0 이상이면 `python3 scripts/agentstoz-maintainer.py sweep contract --root . --json`으로 같은 계약을 읽을 수 있다. 이 명령은 구성·문서 유무와 무관하며 설치·실행·AI 호출·파일 쓰기를 하지 않는다. `capabilities`의 `clickSweepContract:2`와 `sweep contract` 항목으로 지원 여부를 구분한다. 이 문서는 저장소의 상세 참고이며 공통 패키지에 복사될 필요가 없다.

## 구성

`.agentstoz/click-sweep.json`은 프로젝트 Git 소유다. 새 구성은 `schemaVersion:2`, 대상 1~8개다.

```json
{
  "schemaVersion": 2,
  "surfaces": [
    {"id":"web","target":"web","environment":"browser","url":"http://127.0.0.1:9050/"},
    {"id":"mac-app","target":"desktop","environment":"native","platform":"darwin","command":["<프로젝트가 구현한 실제 데스크톱 하네스>"]}
  ]
}
```

두 번째 command는 **설명용 자리표시자**다. 실행 가능한 하네스가 들어 있지 않다. 실제 프로젝트의 명령과 인자를 지정해야 한다.

- `web`: loopback `url` 또는 프로젝트 `command`. 공통 Playwright 엔진이 내는 증거는 항상 `web/browser`다. 브라우저에서 Tauri UI를 렌더링해도 네이티브 앱 실행 증거가 되지 않는다.
- `desktop`: `command` 필수, `url`·`serve` 금지. `environment`는 `native` 또는 `fixture`, `platform`은 `darwin`, `win32`, `linux` 중 하나다. 현재 호스트와 다른 플랫폼의 하네스는 시작하지 않는다.
- `fixture`: 프로토콜/모의 하네스의 증거다. 실제 데스크톱 앱 검증으로 표시하지 않는다.
- 같은 설정 안의 대상별 기준선 경로는 달라야 한다. 선택 `baseline`은 프로젝트 내부 상대 경로다.
- 포트가 없는 프로젝트도 데스크톱 command를 구성할 수 있다. 앱의 「웹 켜기」만 등록 포트를 사용한다.

## 독립 저장 위치

| 범위 | 기본 기준선 | 실행 증거 |
| --- | --- | --- |
| 웹/이전 하네스 | `.agentstoz/click-sweep/<id>.json` | `.agentstoz/maintainer/click-sweep/<id>/` |
| 데스크톱 | `.agentstoz/click-sweep/desktop/<environment>/<platform>/<id>.json` | `.agentstoz/maintainer/click-sweep/desktop/<environment>/<platform>/<id>/` |

명시한 기준선도 대상·환경·플랫폼·surface가 일치해야 한다. 웹 기준선이나 fixture 기준선을 native로 승격하거나, `--update`로 덮어쓰지 않는다. 해당 범위에 맞는 별도 경로를 구성한다. 설정 전환만으로 기준선을 삭제하거나 다시 만들지 않는다.

## 데스크톱 프로젝트 하네스 연결

러너는 command의 기존 인자에 `updateArgs`(기본 `["--update"]`)만 필요할 때 붙인다. 다음 비밀이 아닌 환경값을 전달한다. 이 값은 권한이나 OS 실행 증명이 아니다.

| 환경값 | 의미 |
| --- | --- |
| `AGENTSTOZ_SWEEP_RUN_ID` | 이번 실행의 새 UUID. 과거 결과 재사용 방지 |
| `AGENTSTOZ_SWEEP_SURFACE` | 구성된 id |
| `AGENTSTOZ_SWEEP_TARGET` | `desktop` |
| `AGENTSTOZ_SWEEP_ENVIRONMENT` | `native` 또는 `fixture` |
| `AGENTSTOZ_SWEEP_PLATFORM` | 구성된 플랫폼 |
| `AGENTSTOZ_SWEEP_BASELINE_PATH` | 프로젝트 상대 기준선 경로 |
| `AGENTSTOZ_SWEEP_RESULT_PATH` | 프로젝트 상대 `harness-result.json` 경로 |
| `AGENTSTOZ_SWEEP_UPDATE` | `1`: 명시적 기준선 작성/갱신, `0`: 비교 |

하네스는 기존 프로젝트 테스트 도구로 실제 대상과 클릭 결과를 수집·비교한다. 실제 앱·OS 승인·입력 정책은 기존 프로젝트 경계를 따라야 한다. 이 프로토콜이 별도 권한을 부여하지 않는다.

하네스가 쓰는 기준선은 2,000,000바이트 이하 정규 JSON 파일이며 다음 메타데이터와 프로젝트 소유의 비어 있지 않은 `inventory` 객체가 필요하다.

- `schemaVersion:2`, `surface:<id>`, `target:"desktop"`, `environment:<구성값>`, `platform:<구성값>`
- `inventory`: 하네스가 실제로 수집·비교하는 대상 목록. 공통 러너가 가짜 요소를 만들지 않는다.

일반 비교 실행은 시작 전·후 기준선 원본 SHA가 같아야 한다. 하네스가 updated:false로 보고해도 기준선을 바꿨다면 통과하지 않는다. 파일은 자동 복원/삭제하지 않으며 변경을 보존한다. 이는 프로젝트 command의 파일 쓰기 자체를 통제한다는 뜻이 아니다.

비교 실행에서 기준선이 없으면 하네스를 시작하지 않는다. 먼저 검토한 하네스로 명시적인 `sweep run --surface <id> --update`를 수행한다.

완료 뒤 하네스는 `AGENTSTOZ_SWEEP_RESULT_PATH`에 아래 **정확한 13개 필드**의 JSON을 쓴다(16,384바이트 이하).

| 필드 | 값 |
| --- | --- |
| `schemaVersion` | `2` |
| `runId` | 전달받은 이번 UUID |
| `surface`, `target`, `environment`, `platform` | 이번 구성과 일치 |
| `baselinePath` | 전달받은 상대 경로 문자열 |
| `baselineSha256` | 기준선 원본 바이트의 소문자 SHA-256 |
| `passed`, `updated` | boolean. 통과는 exit 0, 실패는 exit 1과 일치하며 updated는 요청한 UPDATE와 일치 |
| `elements`, `clicked`, `failures` | 0~1,000,000 정수. elements·clicked는 모두 1 이상, passed일 때 failures는 0, 실패일 때는 1 이상 |

exit 0만 반환, 빈 UI/0개 대상/0회 클릭, 결과 없음, 과거 runId, 다른 target/environment/platform, 기준선 해시 불일치는 통과가 아니다. 비대화형 앱은 전수 클릭 대상 없음/미검증으로 남긴다.

공통 러너는 현재 실행과 범위가 맞는 완료 보고를 확인한 뒤 작은 `summary.json`을 정규화한다. 이것은 **신뢰한 프로젝트 하네스의 범위 선언과 완료 보고**이며, OS 실행 attestation·보안 인증·실제 화면 입력 성공의 독립 증명은 아니다. 이 저장소의 회귀는 임시 `fixture` 하네스만 실행한다.

## 이전 프로젝트 호환과 업그레이드

- schemaVersion 1은 계속 읽는다. URL은 웹으로 분류한다. target 없는 command는 `legacy/unknown`이며 종료 기록을 보존하지만 데스크톱 통과로 표시하지 않는다.
- 이전 웹 기준선·summary를 그대로 읽는다. 웹 범위는 누락된 기존 metadata를 `web/browser`로 해석한다. 이 저장소의 `desktop` id는 데스크톱 **화면 크기인 웹 fixture**다. id/기준선 파일을 보존하고 라벨과 target을 웹으로 명시했다.
- 공통 runner/engine의 공식 이전 해시만 업그레이드한다. 사용자 설정·기준선·실행 결과와 로컬 편집 엔진은 덮어쓰지 않는다. 커스텀 엔진은 확인이 필요하다고 보고한다.
- 앱은 대상별로 기준선 파일·최근 결과·실행 방법·환경을 표시한다. 웹 통과가 다른 데스크톱 대상의 준비 완료를 뜻하지 않는다.

실행: `python3 scripts/agentstoz-maintainer.py sweep status --root .`, `sweep run --root . --surface <id>`, 기준선은 명시한 `--update`. 0 통과, 1 검사 실패, 2 미구성/설정 오류, 3 실행 불가이며 2·3은 통과가 아니다.
