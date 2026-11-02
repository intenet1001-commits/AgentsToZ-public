# iPad mini → 현재 Mac, 5G 실기 확인 (2026-11-02)

## 판정

2026-11-02 08:29 KST 이후, **이미 등록된 iPad mini의 5G 화면 보기·클릭·스크롤이 확인됐다.**
사용자가 Mac 행을 직접 선택하고 생체 인증했다. AI는 사람 Viewer 세션 시작·입력·생체 승인을 수행하지 않았다(SR-23).

- 사용자 확인: 「Mac 화면이 보임」, 이후 「클릭·스크롤 모두 정상」.
- 앞선 iPad 관찰: Wi-Fi 꺼짐, 5G + VPN 표시, One Agent 포함 경로에 현재 Mac `/32` 도착.
- 실제 iPad 캡처: 「연결 경로: 사설망 · Cloudflare」, 「Mac은 잠겨 있지 않습니다」와 현재 Mac의 실제 데스크톱 영상.
- 같은 시도 호스트: PID 42349, `capture:true`, `viewing:true`, `control:true`.
- 이 Mac 전용 connector: `cloudflared_tcp_active_sessions 1`, `cloudflared_tcp_total_sessions 1`, HA 연결 4.
- Cloudflare Gateway: 2026-11-02 08:27:21 KST, `192.168.0.6:52741` ALLOW 1건. 이전의 결과 없음은 연결 전 시각까지 고정된 조회 범위였고, 최근 30분 범위에서 실제 수신을 확인했다.
- 클릭·스크롤 결과는 사용자의 실기 확인이다. AI가 원격 입력을 보내거나 입력별 호스트 영수증을 수집한 결과로 바꾸어 표현하지 않는다.

초기 AX 조회에는 로컬 입력 보류 안내가 있었고, 후속 캡처에서는 사라졌다. 로컬 우선 정책은 마지막 Mac 입력 후 3초 대기다.
이번 일시 안내만으로 모니터 고장 또는 영구 입력 장애라고 판단하지 않는다.

## 확인한 원인과 구성 변경

등록된 대상은 1호가 아니라 **현재 작업 중인 Mac**이었다. 이 Mac은 이전 LAN `192.168.219.138`에서 `192.168.0.6`으로 바뀌었고,
기존 1호 connector의 이전 LAN 경로와 저장 주소만으로는 현재 Mac에 닿지 않았다.

1. 공식 Cloudflare `cloudflared` Darwin arm64 2026.10.7을 릴리스 SHA256 대조 후 사용자 실행 경로에 설치했다.
2. 현재 Mac 전용 터널 `agentstoz-screen-cs-work`를 만들고 사용자 LaunchAgent로 실행했다. 1호 터널은 보존했다.
3. 현재 Mac `192.168.0.6/32`만 private route와 One Agent include에 추가했다.
4. 기존 소유자 이메일 AND TCP AND 목적지 포트 52741 허용 정책에 이 주소만 추가하고, 뒤의 기타 접근 차단 정책에도 동일 주소를 추가했다.
5. iPad에 저장된 이 Mac의 사설망 주소를 `192.168.0.6`으로 바꾸고 「사설망 · Cloudflare」를 선택했다.
6. 프로필 반영 후 iPad에서 새 `/32`를 읽어 확인했고, 사용자가 연결을 시작했다.

터널 token은 사용자 `.cloudflared` 폴더의 0600 파일에만 있으며 Git·이 문서·테스트 로그에 포함하지 않는다.
실행 설정도 token 자체 대신 `--token-file`을 참조한다. sudo, TCC 변경, 키 재등록, 설치 Screen 재시작은 하지 않았다.

## 남은 범위

- 현재는 사설 IP를 고정한 구성이다. Mac이 다른 Wi-Fi로 옮겨 IP가 바뀌어도 자동으로 찾아가는 기능은 미완료다.
- 이미 LAN에서 등록한 iPad의 5G 접속 성공이다. 새 기기의 5G 최초 등록은 이번에 시험하지 않았다.
- Mac↔Mac Viewer 실제 서명/설치/두 Mac 조작과 AI 커뮤니티 신뢰 경로 완료를 뜻하지 않는다.
- 성능 지연·장시간 재연결·Mac 잠금/깨우기·계정 해지 실기는 별도다. 비용·항상 연결 보장은 확인하지 않았다.

## 로컬 증거와 검증

민감한 화면 원본은 공개 커밋에 넣지 않고 원본 저장소의 gitignored
`tests/results/remote-continuation-20261102/live-5g/`에 보관했다.
`cellular-before-view.png`, `ipad-human-started-view.png`, `ipad-human-started-view.xml`,
`screen-status.json`, `tunnel-live.prom`이 실제 관찰 자료다.

`b4f19c825b83a05042fce0080488fd065b7e4109`를 커밋하고 깨끗한 같은 브랜치에서 `bun run verify`를 끝까지 실행해 **exit 0**을 확인했다.
유지보수 138개, 타입 검사, Bun **10,312 pass / 12 skip / 0 fail**(1,136파일), Rust **165 pass / 0 fail / 1 ignored**다.
원격 사용자·접근성 페르소나도 공통 runner로 **10개 검사 통과, 실패 0개**이며 source unchanged가 true다.
원격 사용자는 contract 5 + screen 3, 접근성 사용자는 contract 1 + screen 3으로 중복 검사를 공유한다.
전체 quick·전체 페르소나를 통과했다는 뜻은 아니다. 물리 Mac 창을 띄우는 quick 항목은 HANDOFF 안전 범위 때문에 실행하지 않았다.

이전 Rust guard 간헐 실패는 이번 전체 실행에서 재현되지 않았다. 원인이 해결됐다고 판정하지 않는다.
이 검증 뒤 갱신한 것은 결과·연구 문서뿐이며 제품 소스는 동일하다.
로그는 `verify-b4f19c82.log`, 페르소나 원본 보고서는 `personas-report/`에 보관했다.
이동/주소 변경 사용자의 새 여정은 검사가 없는 needs checks 후보로만 제안하며 활성화하지 않는다.
