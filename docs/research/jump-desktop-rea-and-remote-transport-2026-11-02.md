# Jump Desktop·오픈소스 분석과 원격 전송 개선 판단

## 분석 범위와 증거

사용자가 제공한 `JumpDesktopMac (2).zip`을 설치·실행하지 않고 plist와 Mach-O만 별도 임시 폴더에서 분석했다.
ZIP SHA-256은 `03ef0963ba1a3185a30dec90a8a4709903d0b86bffc5c9b8da4750d2a2404dd8`이다.
대상은 host Connect가 아니라 `com.p5sys.jump.mac.viewer.web` Viewer 10.15.51.0(build 1001716), 최소 macOS 11이다.
arm64/x86_64 바이너리 SHA-256은 `a09b742edd4726a479cf7c4bbc89cc75a2f465b06a3672eb7c2cd1e07d5bec9e`이다.

로컬 REA 6.4.0의 Mach-O 분석 영수증은
`ev_78b9ec5c006f20f67ebdef77d37fec5fd90b2f6e47b3bb3f2e4a0bb65ea6ebc0`,
native dispatch 분석 영수증은
`ev_2f1e415fff4133da742a55ee02c3758318658ec48ae7edc1c1da2f8a0686b8f3`이다.
후자는 197개 class/metaclass 및 2,461개 dispatch 구현을 추출했으나 10,000-record 예산에서 잘렸다.
이는 일부 선언의 정적 인벤토리이며 전체 동작·프로토콜 구현을 복원했다는 뜻이 아니다.
Ghidra/IDA provider 미설정, Hopper 미설치로 함수 내부 디컴파일은 수행하지 않았다.
분석 원본은 `/private/tmp/agentstoz-jump-analysis-20261101/`에 있고 제품 소스에는 상용 구현을 복사하지 않았다.

WebRTC, VideoToolbox, Metal, ScreenCaptureKit, libdav1d 링크와 `RDSession`, `KeyboardInputMapper`,
keyDown/keyUp/forceSyncRemoteModifierStates 선언을 확인했다. 라이브러리·이름의 존재만으로 사용 경로·속도·알고리즘은 증명되지 않는다.

## 도입할 설계 원칙

| 항목 | 확인 근거 | AgentsToZ 적용과 완료 기준 |
|---|---|---|
| 경로를 명시하고 단계별 실패를 구분 | [Jump 실시간 통계](https://support.jumpdesktop.com/hc/en-us/articles/4423458049165-Live-Fluid-Connection-Statistics) | 승인/경로 열기/Mac 인증/첫 화면 구분을 소스에 추가. 다음 설치본에서 실제 실패 단계 확인 필요 |
| 직접 연결 우선, relay 대체 | [공식 relay 문서](https://docs.jumpdesktop.com/deployment/relay/) | 기존 명시적 근거리/Cloudflare 경로 유지. 생체 서명 사용 후 경로 대체·자동 재접속 금지. UDP/TURN은 별도 측정 후 설계 |
| 하드웨어·소프트웨어 코덱과 적응 품질 | [공식 코덱 문서](https://docs.jumpdesktop.com/viewer/performance/codecs/) | 현재 VideoToolbox 경로에서 RTT·손실·인코딩/디코딩 시간·첫 화면 시간을 먼저 측정. 상표의 성능 수치를 우리 성능으로 쓰지 않음 |
| 입력 상태 동기화 | 정적 selector 인벤토리 및 현재 입력 해제 검사 | 수정자·누른 키·마우스 버튼은 취소/연결 종료/사람 인계마다 해제. 현재 가짜 입력 회귀와 실제 두 Mac 확인을 분리 |
| 설치 가능한 Viewer | 현재 소스/메인 앱 포장 경로 점검 | 독립 Viewer builder와 Developer ID 번들 포장/서명 보존 추가. H1 전용 프로필 없이는 실패. 실제 서명·공증·설치 증거 필요 |

## Cloudflare와 Supabase 역할

Cloudflare private-network route는 네트워크 도달성을 제공하고, 앱의 Mac 핀·상호 인증·종단간 암호화·권한·사람 우선권을 대체하지 않는다.
사설 경로 등록 외에 One Agent 단말이 목적지 트래픽을 포함해야 한다.
[Cloudflare 사설 CIDR 연결](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/private-net/cloudflared/connect-cidr/),
[Split Tunnels](https://developers.cloudflare.com/cloudflare-one/team-and-resources/devices/cloudflare-one-client/configure/route-traffic/split-tunnels/).

대화형 화면/입력의 전송은 Cloudflare 직접 사설 경로나 독립 전송 계층으로, 커뮤니티 회원·기기 발견·설정·영수증 저장은 Supabase로 나누는 것이 현재 구조에 맞는다.
이는 설계 판단이며 지연 개선을 측정한 결과가 아니다. [Supabase Realtime](https://github.com/supabase/realtime)의 전달 보장은 명령 실행 영수증을 대신하지 않는다.
확인되지 않은 실행은 다시 보내지 않고 기존 request ID의 영수증을 조회해야 한다.

[Zero Trust 무료 플랜](https://www.cloudflare.com/plans/zero-trust-services/)과
[Tunnel FAQ](https://developers.cloudflare.com/cloudflare-one/faq/cloudflare-tunnels-faq/)의 사설망 경로 조건을 확인했다.
현재 계정의 과금 영수증이나 무제한 사용 보장을 확인한 것은 아니다. 공개 hostname 영상 전송 제한과 private network route를 혼동하지 않는다.

## iPad 5G 실기의 갱신 (2026-11-02 아침)

- 이전에는 같은 Wi-Fi에서 등록 성공 후 5G에서 실패했고, 당시 성공 판정은 철회했다.
- 등록 대상은 현재 Mac이었다. 현재 Mac의 주소가 `192.168.219.138`에서 `192.168.0.6`으로 바뀐 것을 확인하고 이 Mac 전용 Cloudflare connector와 `/32` 경로를 구성했다.
- One Agent include·좁은 소유자 TCP 52741 정책·iPad 저장 경로를 맞춘 뒤 사용자가 직접 연결·생체 승인을 했다.
- 실제 iPad 영상, 호스트 `viewing:true`, 전용 터널 TCP 활성 1, Gateway의 현재 Mac TCP 52741 ALLOW를 대조했다. 사용자는 화면과 클릭·스크롤 모두 정상이라고 확인했다.
- **현재 등록된 iPad의 5G 제어는 실기 확인됐다.** 5G 최초 등록, Mac IP 변경 후 자동 복구, Mac↔Mac 완료의 증거는 아니다. [실기 기록](../handoff/2026-11-01-codex/CELLULAR-LIVE-2026-11-02.md)을 따른다.

## 아직 출시를 막는 항목

H1 Viewer 프로필, H10 pushLive, S-M3 물리 입력 보정, 두 Mac의 실제 등록/보기/조작/인계 검사가 남아 있다.
AI 커뮤니티 컴퓨터 유즈의 기존 v1은 DB 키 교체 MITM 및 미확정 실행 후 사람 보류 보존 문제를 별도로 해결해야 한다.
추가된 credential/handshake/key-confirmation 모듈은 독립 신뢰 발급자·online lease·영속 replay 방지 및 실제 native 경로와 아직 통합되지 않았다.
회원 가입 한 번으로 편하게 연결하는 UX 목표는 유지하되, 이 미완료를 회원 확인이나 VPN 연결 성공으로 대체해서는 안 된다.

## 오픈소스 1차 비교와 다음 설계 (2026-11-02)

아래는 공식 문서·README와 표시한 일부 소스의 **범위를 한정한 설계 검토**다.
전체 프로젝트의 코드 감사·정량 성능 비교·AgentsToZ 적용 완료를 뜻하지 않는다.
URL의 현재 내용은 바뀔 수 있으므로 실제 코드 도입 전에는 정본 저장소와 commit을 고정한다.

| 대상 | 확인한 참조점 | AgentsToZ 설계 판단 |
|---|---|---|
| RustDesk | ID 발견 서버와 relay 분리, 직접 연결 실패 시 relay 사용. [공식 구조](https://rustdesk.com/docs/en/self-host/) | Mac 신원을 주소와 분리하고 현재 경로를 발견하는 계층을 우선 설계한다. 인증 서명을 소비한 뒤 다른 경로에 재사용하지 않는다. |
| MeshCentral | 제어 WebSocket, 세션별 relay 연결, 가능한 경우 WebRTC 전환. [공식 설계](https://docs.meshcentral.com/design/) | 발견/제어와 영상 전송의 수명을 분리하는 참고다. 문서상 relay의 TLS 복호화·재암호화 방식을 AgentsToZ의 E2E 대체안으로 채택하지 않는다. |
| HopToDesk | 사용자가 준 [GitHub 주소](https://github.com/hoptodesk/hoptodesk)는 조회 시 chocolatey·res·LICENSE 중심이다. | 이 주소만으로 원격 엔진을 분석했다고 판정할 수 없다. 실제 제품 소스의 정본·revision을 확인한 뒤 평가한다. |
| Apache Guacamole server/client | guacd와 프로토콜 plugin, 브라우저·인증 UI의 역할 분리. [공식 아키텍처](https://guacamole.apache.org/doc/gug/guacamole-architecture.html) | 전송 adapter의 공통 수명·취소·종료 계약을 참조한다. 중앙 proxy 도입은 별도 운영·지연 검증이 필요하다. |
| TigerVNC | RTT·버퍼 지연과 flow control 분석, framebuffer 비교·frame-rate 제한. [지연 설계](https://github.com/TigerVNC/tigervnc/wiki/Development%3A-Latency), [Xvnc 소스](https://github.com/TigerVNC/tigervnc/blob/master/unix/xserver/hw/vnc/Xvnc.man) | 영상 backlog와 프레임 나이를 함께 측정한다. 다른 프로토콜의 조절 상수를 그대로 복사하지 않는다. |
| FreeRDP | H.264/플랫폼 decoder와 scaling 선택. [빌드 문서](https://github.com/FreeRDP/FreeRDP/blob/master/docs/README.building), [GFX 옵션 소스](https://github.com/FreeRDP/FreeRDP/blob/master/client/common/cmdline.h) | 현재 VideoToolbox 경로의 encode/decode 시간·해상도별 부하를 먼저 측정하고 품질 조절을 설계한다. RDP codec 지원을 우리 성능 개선 증거로 쓰지 않는다. |
| Remmina | 연결별 view mode, 탭·toolbar·scaling·재연결 설정. [공식 기능](https://remmina.org/remmina-features/). 사용자 GitHub는 [GitLab 정본 mirror](https://github.com/FreeRDP/Remmina)라고 명시한다. | 기기별 표시 이름·보기 설정·경로 상태를 저장하되 권한이나 Mac 핀과 분리한다. 암호 저장·인증서 무시 옵션은 차용하지 않는다. |
| Agent S | 화면을 보고 GUI 동작을 수행하는 agent framework와 버전별 구현. [공식 README](https://github.com/simular-ai/Agent-S) | 관찰 → 제한된 동작 → 결과 확인의 단계를 분리한다. 벤치마크 성적이나 모델 수치를 현재 Mac의 성공률로 환산하지 않는다. |
| UI-TARS Desktop | GUI operator와 multimodal/browser 계층, hybrid/DOM/visual 모드. [공식 저장소](https://github.com/bytedance/UI-TARS-desktop), [설정 문서](https://github.com/bytedance/UI-TARS-desktop/blob/main/multimodal/websites/docs/docs/en/guide/basic/config.mdx) | 대상 앱/창/문서에 결속된 semantic locator를 우선하고 visual fallback에도 같은 허용 범위를 적용한다. |
| Open Interpreter | 사용자 URL은 조회 시 openinterpreter/openinterpreter로 이동하며 현재 coding agent와 sandbox/approval을 설명한다. [현재 저장소](https://github.com/openinterpreter/openinterpreter), [현재 문서](https://www.openinterpreter.com/docs/terminal) | 예전 Computer API가 현재도 같은 계약이라고 가정하지 않는다. coding/명령 도구를 원격 Computer Use의 허용 목록에 자동 추가하지 않는다. |
| ScreenHand | native AX·CDP·OCR·좌표 fallback과 lease/작업 큐를 제시한다. [공식 README](https://github.com/manushi4/screenhand) | 요소 기반 조작과 동일 대상 lease를 참고한다. README의 속도는 자체 주장으로 남기고 우리 실측으로 표시하지 않는다. |
| Awesome Computer Use 2개 | [philfung](https://github.com/philfung/awesome-computer-use), [12britz](https://github.com/12britz/awesome-computer-use)는 자료/프로젝트 목록이다. | 후보 발굴에만 사용하며 실행 엔진·성능·보안의 근거로 삼지 않는다. |

### 우선순위와 완료 조건

1. **커뮤니티 AI의 신뢰와 실행 장부 통합이 출시 선행 조건이다.**
   회원 인증을 일회성의 편리한 사용 경험으로 연결하되, 기존 v1의 DB 키 교체 문제와 영속 사람 보류·미확정 실행을 먼저 해결한다.
   참여 시 허용한 기기/앱 범위를 유지하고, 매 작업마다 사람 Viewer의 생체 인증을 빌려 쓰지 않는다.
   기기 신뢰 발급·현재 회원 상태·수신 Mac의 기존 허용 범위·단일 실행 소유권을 실제 native 경로까지 검증해야 한다.
2. **주소 변경 복구는 Mac 핀을 유지하는 발견 계층으로 설계한다.**
   현재 사설 IP를 신원으로 삼지 않는다. 서명된 기기 결속·revision·만료를 확인한 경로 힌트도 최종 Mac 상호 인증을 통과해야 한다.
   IP 변경 때 Cloudflare route와 One Agent include가 함께 반영되어야 한다는 운영 조건은 그대로다.
   고정 overlay/사설 이름을 제공하는 경로는 S-N2 실증 뒤 선택하며, 실패 시 별도 중계의 운영·비용을 확인한다.
   전송 계층만 바꾸면 자동으로 주소 변경이 해결된다고 가정하지 않는다.
3. **영상은 현재 구현을 계측한 뒤 조절한다.**
   `VideoPump.swift`에는 이미 maxBacklog=3, 인코딩 전 picture 생략, encoder generation 교체가 있다.
   인코딩된 delta frame의 임의 삭제는 디코딩의 참조 프레임 의존성을 깨뜨리므로 도입하지 않는다.
   첫 화면까지의 단계별 시간, 프레임 나이, backlog, encode/decode 시간, 전송량을 수집하고 같은 화면·해상도·망의 전후 P50/P95와 표본수를 비교한다.
   RTT와 화면을 누른 뒤 보이는 지연은 별도로 측정한다. 원본 화면·입력 문구를 상시 로그로 남기지 않는다.
4. **AI 팀은 관찰과 입력 소유권을 분리한다.**
   한 Mac의 실제 입력 실행은 명확한 소유권/epoch 아래 직렬화하고, 다른 agent는 제한된 관찰 또는 대기를 한다.
   사람이 입력을 가져가면 보류를 영속화하고 모든 실행 경로가 같은 결정을 본다.
   동작 결과를 모르면 같은 request ID의 영수증을 조회하며 클릭·텍스트·명령을 재전송하지 않는다.
   semantic locator가 실패한 visual fallback도 같은 앱·창·scope를 벗어나지 못해야 한다.

### 필요한 시험

- 격리 레인: 주소 A→B 변경, 낡은 경로·서명·revision·만료 거절, 다른 Mac 키 거절, 중복 요청, 소유권 상실, 재시작 뒤 사람 보류와 unknown 영수증 유지.
- 영상 fixture: 느린 수신기와 해상도 변경에서 큐 상한·generation·keyframe 순서를 유지하고 휴대폰 protocol 4 골든 바이트가 동일한지 검사.
- 실기: 사람이 시작한 저장 기기의 5G 연결, Mac 네트워크 변경 뒤 동일 Mac 결속, 연결 종료 시 누른 키/버튼 해제, 두 Mac의 실제 보기·입력·인계.
- Mac Viewer의 H1·S-M3·H10 관문은 별도다. 이번 iPad 5G 성공으로 이 관문을 통과 처리하지 않는다.

이번 비교로 새 원격 엔진이나 agent 패키지를 제품에 설치·이식하지 않았다. 위 항목은 구현 완료 목록이 아니라 다음 구현의 검토 가능한 기준이다.
