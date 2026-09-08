# Mac 앱 직접 배포

작성: 2026-09-07. 권장 경로는 공개 GitHub Releases에 서명·공증한 DMG를 게시하고, 공식 다운로드 안내 페이지에서 해당 버전으로 연결하는 것이다. 이 문서는 배포 준비 기준이며 현재 공개 DMG가 준비됐다는 뜻이 아니다.

[Mac 배포·기존 단말 전환 상세 설계](design/mac-distribution-migration.md)는 이미 있는 production 서명 경로를 확장하는 방법, 기본 앱과 강화 runtime의 지원 조건, 불변 소스 빌드, 공증·설치·복구 검증을 정의한다. 실제 구현은 이 상세 계약을 따른다.

## 배포자와 사용자의 역할

GitHub Releases는 설치 파일과 버전별 변경 내용을 함께 제공할 수 있다. 사용자에게는 DMG 다운로드 → 앱 설치 → 로컬 사용 또는 본인의 Supabase 연결 순서로 안내한다. 다운로드만을 위해 사용자별 GitHub·Vercel 가입을 요구하지 않는다. GitHub 저장소 작업에 필요한 로그인은 앱의 해당 기능에서 별도로 다룬다. [GitHub Releases 문서](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases)

공식 다운로드 페이지는 운영자가 관리하는 정적 웹 페이지로 충분하다. 처음에는 공개 저장소의 README에서 Releases로 연결해도 된다. 모바일 공통 웹앱과 단말 등록 중계는 별도의 운영 기능이며, DMG 다운로드 서버가 이를 대신하지 않는다. 사용자별 Vercel 배포를 없애는 모바일 구조는 [기존 단말·공통 모바일 계획](onboarding-qr-device-migration-plan.md)을 따른다.

## 출하 전 준비

Apple은 Mac App Store 밖의 배포에 Developer ID 서명과 공증 절차를 제공한다. 공증은 제출한 소프트웨어를 검사하고 티켓을 발급하는 절차이며, 앱의 기능 검증을 대신하지 않는다. 배포 시 Hardened Runtime과 필요한 entitlement를 확인하고 공증 티켓을 첨부한다. [Apple Developer ID 안내](https://developer.apple.com/developer-id/)

1. 개발 정본에서 변경을 검증하고 승인된 원격 반영을 마친다. 공식 빌드의 clean worktree·실제 원격 기본 브랜치 HEAD 검사와 출처 기록을 유지한다. `--allow-unpublished-source` 산출물은 설치·배포본으로 쓰지 않는다.
2. 배포용 서명 모드를 구현·검증한다. 현재 `tauri.conf.json`의 `signingIdentity: "-"`와 `build-macos.ts`의 후처리 `codesign --sign -`는 ad-hoc 경로다. 환경변수에 인증서만 지정하면 후처리에서 서명이 유지될 것이라고 가정하지 않는다. 출시 모드는 내부 실행 파일·helper부터 앱까지 Developer ID 서명을 보존하고, 개발 모드와 구분해야 한다.
3. 실제 앱의 번들 ID·Team ID, 서명 체인, Hardened Runtime과 entitlement를 검사한다. 잘못된 출하 서명은 빌드를 실패시킨다. 작은 canary 파일의 서명 성공은 앱 전체의 검증 증거가 아니다.
4. 앱/설치 패키지를 Apple `notarytool`로 공증하고 결과를 확인한 뒤 `stapler`로 티켓을 첨부·검증한다. 비밀키와 공증 인증 정보는 키체인 등 비밀 저장소에서만 사용한다. 명령 출력·저장소·DMG에 복사하지 않는다.
5. 최종 DMG를 새 환경에서 내려받아 Gatekeeper 검사, 설치·첫 실행·업데이트·제거를 확인한다. 설치와 업데이트가 기존 단말 ID, 프로젝트 경로, 로컬 기억, 북마크와 동기화 이력을 보존하는지 검증한다. AI 실행 helper의 권한 승인·종료·복구도 실제 서명본으로 확인한다.
6. 검증된 파일만 Releases에 첨부한다. 실제 지원 아키텍처·최소 macOS, 버전, 변경 내용, 알려진 제한, SHA-256과 검증한 소스 출처를 기록한다. 공증·티켓 첨부 뒤 최종 파일로 해시를 계산한다. 아직 검증하지 않은 Intel 지원을 표시하지 않는다.

이 저장소의 공개 스냅샷은 private 이력을 분리하는 orphan 방식이다. 공개 릴리스 태그와 검증한 공개 스냅샷의 관계를 확인하고, 배포 파일의 출처와 혼동하지 않게 기록한다. private 커밋 이력·설정 파일을 릴리스 자산이나 공개 메모에 포함하지 않는다.

## 업데이트

첫 배포에서는 새 DMG를 내려받아 설치하는 수동 업데이트 경로를 검증한다. 추후 앱 내 업데이트를 제공하려면 업데이트 메타데이터·패키지 서명, 버전 비교, 다운로드 검증, 작업 종료 대기와 교체 실패 복구를 별도로 구현해야 한다. Developer ID 서명만으로 자동 업데이트가 생기는 것은 아니다.

## 현재 확인한 상태

- 공개 저장소를 별도 QA 폴더에 clone하고 AgentsToZ 프로젝트로 등록했다. 공개 소스 준비와 설치 파일 배포는 별개다.
- 설치된 v396 앱은 ad-hoc 서명이다. Developer ID 인증서와 실제 키의 canary 서명은 검증했지만 앱 전체 서명·공증·설치 검증은 남아 있다.
- native 빌드의 CLT/Swift 도구 충돌 복구와 공증 인증 설정이 남아 있다. 인증서 발급 완료를 이 절차들의 완료로 표시하지 않는다.
- 기존 단말용 마법사 개선은 개발 소스에서 검증을 마쳤으며 설치된 앱에 반영된 상태가 아니다. GitHub Push나 Release 게시는 수행하지 않았다.

사용자용 설치 안내와 다운로드 버튼은 실제 검증된 DMG가 준비됐을 때 해당 버전에 맞춰 갱신한다.
