# Mac·iPhone v493 업데이트

2026-09-24 (KST). 사용자의 두 앱 업데이트 요청으로 진행.

- 기능 소스: `8d74f115dfbead0d02c54db6a82c5c1efa090d92`.
- 공통 v493 버전: `b5bd50a`, 비공개 개발 저장소 main에 fast-forward 반영·Push.
- unrelated runtime-and-decades-memory 계획 파일은 보존하고 커밋하지 않음.

## 검증

- 최종 전체 `verify`: `20260923T145035Z-d2ba2368`, sourceUnchanged=true, Bun 4388 pass / 0 fail, Rust 60 pass / 0 fail, TypeScript 통과.
- 별도 native iOS: 11개 회귀 그룹 및 실제 URLSession/Bun 연결·재연결·취소 통과.
- 실제 iPhone 17 Pro: `20260923T144441Z-50924e87`, 36개 체크 및 시스템 키보드 관찰 통과. 가짜 CLI 기반이며 실제 제공자 응답 속도 시험은 아님.
- 버전 증가 후 릴리스 계약: 14 pass / 0 fail.

## Mac 설치 완료

- 기존 로컬 설치 방식의 공식 `build-macos.ts` 사용. clean checkout·원격 기본 브랜치 HEAD 검증 성공. unpublished override 없음.
- v493 앱·DMG 생성. 이번 로컬 빌드는 기존 설치 채널과 같은 ad-hoc 서명이며 Developer ID 공증 배포로 주장하지 않음.
- `codesign --verify --deep --strict` 통과 후 기존 installer의 staging·backup·atomic replacement 사용.
- 설치 앱 UI에 v493 / 기능 소스 8d74f115 / 원격 기본 브랜치 검증 표시 확인.
- 앱 실행 파일과 실제 API sidecar의 설치본/빌드본 SHA-256 일치. 새 PID의 설치 경로 sidecar가 3001에 응답함을 확인.
- 등록 프로젝트 134개와 ID·폴더 경로 전부 보존됨.
- 이전 앱 백업: `/Applications/.AgentsToZ_byCS-backups/AgentsToZ_byCS-1790175672196-43062.app`.

## 모바일 웹 배포 완료

기존 개인 Vercel 프로젝트의 production 갱신. 실제 `release-meta.json`은 v493.0.0과 두 원격 프로토콜 `agentstoz-local-v9`를 반환했다. `/remote/` HTTP 200 및 no-store 확인. 개인 주소·인증값은 이 기록에 저장하지 않음.

## iPhone

- 기존 TestFlight 번들 ID 유지: `com.intenet.agentstoz.mobile.testflight`.
- 실제 배포 인증서 서명 canary 성공. Xcode managed profile은 automatic export로 처리.
- v493.0.0 (493) archive 생성 후 Apple 업로드 성공 (`EXPORT SUCCEEDED`, uploaded package processing 확인).
- Xcode 업로드 성공 시각은 2026-09-24 00:02:30 KST. 사용자는 TestFlight에 업데이트가 보이지 않는다고 확인했다.
- 사용자 로그인 후 App Store Connect에서 v493 처리 완료·그룹 미지정을 확인했다. 기존 ‘개인 테스트’ 내부 그룹에 v493을 추가했고 해당 그룹 빌드 목록에서 **493.0.0 (493), 테스트 중**을 확인했다. 기존 테스터 1명·기존 빌드들은 유지했다.
- 사용자가 TestFlight에서 업데이트 완료를 알린 뒤 실제 iPhone 17 Pro를 `devicectl device info apps`로 조회했다. 기존 번들 ID의 **version=493.0.0, bundleVersion=493**을 확인했다. Mac Info.plist도 493.0.0으로 최종 확인했다. 두 앱 업데이트 완료.

## v495 후속 설치 확인

- 기능 소스 ba5f57f, 공통 버전 d58b8c7. Mac v495 설치 및 실행, 설치본/빌드본 해시와 서명 검사 완료. 프로젝트 134개 보존.
- iOS v495는 2026-09-24 03:01:59 KST Apple 업로드 성공 후 기존 개인 테스트 그룹에서 테스트 중을 확인했다.
- 2026-09-24 09:05 KST iPhone 17 Pro의 기존 TestFlight bundle을 devicectl로 조회하여 version 495.0.0 / build 495 확인. TestFlight의 v495 상세에서도 열기 버튼을 확인했다.
- 보조 worktree 정리 후 기본 checkout만 유지했다. unrelated runtime-and-decades-memory 계획 폴더는 보존했다.

## v496 Gemini 키 설정 Mac 설치

- 기능 d5f43ea, 버전 5d74172를 origin/main에 반영. clean 임시 worktree에서 공식 build-macos.ts의 원격 기본 브랜치 검증 후 v496 생성.
- 2026-09-24 09:22 KST 기존 installer로 설치. 이전 v495 백업: `/Applications/.AgentsToZ_byCS-backups/AgentsToZ_byCS-1790209346557-87230.app`.
- 설치 UI에서 v496, 소스 d5f43ea9, 원격 기본 브랜치 검증됨 확인. Workroom → Gemini 음성 설정을 열어 실제 native 관리 경로의 API 키 미등록 응답과 입력 가능한 보안 필드를 확인했다. 입력란을 사용자에게 열어 두었으며 실제 API 키를 읽거나 대신 입력하지 않았다.
- 등록 프로젝트 134개 ID·표시명·폴더 보존, 앱 실행 파일 설치본/빌드본 SHA-256 일치, 설치 앱 codesign strict 검증 통과.
- 빌드용 임시 worktree 정리. iPhone은 v495 설치 상태이며 이번 Mac 키 설정만을 위해 iOS 새 빌드를 업로드하지 않았다.
- 실제 사용자 키 저장·Live 공급자 인증 검사는 사용자 입력 후 확인할 단계다. 마이크·오디오·원격 음성은 아직 구현하지 않았다.

## v497 Gemini 저장 상태 UI Mac 설치

- 기능 5cf4c99, 버전 f8c7f1d를 origin/main에 반영했다. clean 임시 worktree의 공식 build-macos.ts에서 원격 기본 브랜치 검증 후 빌드했다.
- 2026-09-24 10:03 KST 기존 installer로 설치했다. 이전 v496 백업: `/Applications/.AgentsToZ_byCS-backups/AgentsToZ_byCS-1790211804354-39388.app`.
- 실제 앱 UI의 v497·소스 5cf4c99d, 설정 버튼의 ‘키 미등록’, 입력란 위 저장 상태 안내, 입력 가능한 secure field를 확인했다. 저장 전 입력값을 접기 동작으로 지우지 않고, 저장 후 재조회가 성공해야 완료로 표시한다.
- 등록 프로젝트 134개 ID·이름·프로젝트/워크트리 경로 보존, 설치본과 빌드본 실행 파일 SHA-256 일치, 설치 앱 codesign strict 검증 통과. 임시 worktree는 제거했다.
- Chromium/WebKit 20개 설정 UI 검사, maintainer quick 및 전체 TypeScript·Bun·Rust verify 통과. 사용자 API 키는 기존 v496과 설치 직후 v497에서 모두 미등록 상태였으며 실제 저장·Google 연결 성공은 아직 확인 전이다. 사용자에게 새 입력란을 열어 두었다.
- 이번 업데이트는 Mac 키 설정 UI에 한정한다. iPhone은 v495이며 마이크·오디오·원격 음성 구현 완료를 의미하지 않는다.

## v498 Gemini 인증 키 호환 Mac 설치

- v497에서 사용자 저장 요청의 형식 오류를 관찰한 뒤, 새 authorization key 형식의 점(`.`)을 거부하는 정규식과 256자 입력 제한을 수정했다. 사용자 키 원문을 조회하지 않고 가짜 긴 `AQ.` 키로 재현·검증했다.
- 기능 19bb394, 버전 ed21f74를 origin/main에 반영했다. clean 공식 빌드·원격 기본 브랜치 검증을 거쳐 2026-09-24 10:17 KST 설치했다.
- 이전 앱 백업: `/Applications/.AgentsToZ_byCS-backups/AgentsToZ_byCS-1790212662741-77318.app`. 실제 앱 UI v498·소스 19bb394c, 등록 프로젝트 134개 ID·이름·경로 보존, 설치본/빌드본 실행 파일 해시 일치와 codesign strict 통과를 확인했다.
- host 8개, Chromium/WebKit UI 22개, quick 및 전체 verify `20260924T010823Z-57af0970` 통과. 빌드용 임시 worktree를 정리했다.
- 설치 직후 실제 키는 아직 미등록이었다. 수정된 입력란을 열어 두고 원본 키 전체를 다시 복사하도록 안내했다. 실제 저장과 Live 인증 성공은 사용자 입력 뒤 별도 확인하며 iPhone/실제 음성 대화는 이번 출하 범위에 포함하지 않는다.
- 2026-09-24 10:21 KST 실제 v498 UI에서 `연결 확인됨`, API 키 Mac 저장, `gemini-3.8-live` Live 세션 준비 응답 성공을 확인했다. 암호화 설정 파일의 존재와 권한 0600, 전용 Keychain 항목의 존재만 확인했으며 키 원문은 조회하지 않았다. 이는 저장·공급자 연결 준비 성공 증거이며 마이크·오디오 대화 구현 완료를 뜻하지 않는다.
