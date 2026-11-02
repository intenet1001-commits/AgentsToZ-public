# Control의 공통 등록 인증

이 경로는 `agent.communicate`, `teams.run`, `computer-use.agent-settings`, `computer-use.browser`를 위한 목적별 관리형 어댑터 인증이다.
기존 전체 Mac/앱 입력 grant와 `standing-key.v1`을 만들거나 바꾸지 않는다. 일반 컴퓨터 유즈의
요청·승인·CGEvent/AX 가드는 기존 계약을 따른다. 이 인증서를 얻었다는 이유로 기존 임의 화면 입력을
자동 승인해서는 안 된다.

## 신원과 키

고정 Developer ID Main만 기존 XPC에 접속할 수 있다. 요청은 그 Main의 PID·프로세스 시작에 결속한다.
신규 요청은 `v:3, channel:"management"`만 허용하며 agent/MCP 채널에는 노출하지 않는다.
Control이 자체 접근 그룹 안에 `control.community-candidate.v1` Secure Enclave 키를 만들고 공개키만
반환한다. privateKeyUsage와 WhenUnlockedThisDeviceOnly를 사용하며 후보 키 자체는 아무 권한도 아니다.
기존 승인·standing 키와 다른 tag이며 개인 키나 wrapped blob을 Viewer/Main/JS에 보내지 않는다.

공통 Plan의 `controlKey`와 최종 Authorization의 같은 필드가 이 공개키와 일치해야 한다. 다른 키로
발급된 Viewer 인증서를 Control에 설치할 수 없다. 공개 빌드는 명시적인 서명 번들의 `AgentsToZCommunityConfigurationV1` 설정(origin/issuerPublicKey/profileId)을 엄격하게 읽는다. 설정이 없으면 미설정으로 닫는다. 명시적인 `CONTROL_COMMUNITY_QA` 빌드는 고정 개인 QA issuer/profile만 사용한다. 서버 health, 파일, 환경 변수나
요청으로 issuer를 바꾸지 않는다.

## 관리 API

공통 봉투는 `{v:3,channel:"management",op:<아래 이름>,...}`이며 표에 없는 키를 거절한다.

| op | 필드 | 효과/성공 본문 |
|---|---|---|
| community-status | 없음 | 키 생성 없이 configured, storeAvailable, binding 또는 null |
| community-prepare | profileId, deviceId, 실제 Main이 읽은 agentDeviceId: 소문자 UUID | 공개 controlKey와 같은 기기 결속, candidateOnly:true |
| community-install | requestId: UUID, envelope:{payload,signature} | issuer 서명과 자체 키 결속을 확인한 뒤 installed:true, revision, expiresAt |
| community-authorize | capability: 위 4개 중 하나 | 현재 Main 세대·목적의 authorized:true, communityId,profileId,deviceId,revision,expiresAt,desktopGrant:false |
| community-disable | 없음 | 기존 정책을 꺼 두고 disabled:true |

응답에는 기존 `success,halted`가 붙는다. `community-authorize`는 실행 완료나 화면 입력 권한이 아니다.
호출자는 이 결과를 영구 캐시하지 않고 expiresAt 전에 목적별 원래 실행 경로에서 다시 검증해야 한다.
부모 Main에서 보호된 어댑터에 전달하고, 임의 body의 boolean으로 인증을 대체하지 않는다.

Authorization 응답만 설치한다. issuer 서명 도메인은 `agentstoz.community-access.response/v2\0`,
P-256 P1363 base64url이다. 요청 ID, 전체 객체의 키 집합, 고정 profile, desktop, 네 공개키의 독립성,
capability 순서/동반 권한, revision/keyEpoch, 응답 freshness와 최대90초 lease를 확인한다.
Directory/오래된 receipt/별도 screen-v1 서명을 Authorization으로 바꾸어 받지 않는다.

## 재시작·만료·끄기

후보 공개키와 profile/device, 최고 revision/keyEpoch/issuedAt, 정책 digest, 로컬 off fence만 Control의
private Keychain에 저장한다. 후보 키가 사라졌는데 기록이 남아 있으면 새 키를 만들지 않는다.
같은 revision의 다른 정책·이전 epoch·이전 lease를 거절한다. 저장이 성공한 뒤에만 권한이 활성화된다.
프로세스 재시작에는 lease가 없으며 기존 등록의 새 서버 lease를 받아 설치하면 된다. 새 생체 인증은
요구하지 않는다. Main 프로세스 세대가 끝나면 활성 lease를 끝낸다.

벽시계와 uptime 양쪽의 만료를 검사하고, uptime 역행·사람이 제어 중인 상태를 거절한다.
Control의 중단 및 기존 standing-off는 공통 인증도 끈다. 로컬 off는 마지막 설치 revision까지
영속적으로 막으므로 같은 정책의 새 lease가 자동으로 되살리지 못한다. 재등록·다시 허용은
관리자가 새 revision에 승인한 정책이 필요하다. 저장 실패 때는 즉시 RAM 권한을 끝내고 후보 개인 키
삭제를 시도하며, 실패를 `community-disable-unconfirmed`로 보고한다. 이를 저장 완료로 표시하지 않는다.

## 검증과 적용 범위

`CommunityControlChecks`는 임시 메모리 소프트웨어 키와 가짜 저장소로 서명·신원·형식·시간·목적·
소유자·사람 제어·rollback·끄기·재시작·저장 실패를 검사한다. Keychain이나 실제 XPC/TCC/화면 제어는
실행하지 않는다. 서명된 Main 브리지와 목적별 어댑터 연결 및 실제 기기 확인은 별도 통합 검증 대상이다.

`src/communityAdapterAuthorization.ts`는 감사된 inherited Main 연결에서 읽기 전용
`community-adapter-authorize`를 요청한다. Main은 고정된 두 capability만 위 Control 관리 읽기로
위임한다. 전후 Main 검증, 정확한 응답 키·90초 상한·기기 신원·revision을 확인한 메모리 witness를
만든다. agent body가 witness 객체를 만들 수 없으며 복사한 객체도 받아들이지 않는다.

`WorkroomBrowserHost`의 trusted dependency로 주입하면 처음 연결하는 새 내장 브라우저 한 페이지에만
등록 동의를 재사용한다. 기존 Chrome/저장 작업/재연결에는 자동 부여하지 않는다. 매 에이전트 동작에서
현재 native lease를 다시 확인하며 사람 takeover, navigation, unknown receipt, tab set와 epoch 검사는
그대로다. 수동 handback은 공통 인증의 갱신과 구별된다. `workroomEffortPolicy`는 공동 요청이 기존
워크룸 auto/recommend/off 선택을 읽도록 할 뿐 파일·사람의 OFF·고정 강도·외부 데스크톱 조언 설정을
바꾸지 않는다. 없는 vendor용 세션별 effort connector를 구현했다고 주장하지 않는다.


## 다른 Mac AI 수신 복구

2026-11-03 구현은 `community-receive-status/restrict/review/review-status` 네 관리 operation을 사용한다.
기존 전체 Mac standing 키와 현재 issuer의 agent.communicate 인증이 모두 있을 때만 최초 수신 정책을
추가 생체 인증 없이 한 번 bootstrap한다. 좁은 settings/browser 인증으로 standing을 만들지 않는다.
Control private Keychain의 별도 policy/ready marker가 정본이다. record 유실·rollback·저장 실패는 거절하며,
기존 JS 파일은 차단의 보수적 이행과 표시 이름에만 사용한다. status 응답은 최대5초의 현재 Native 증거다.

끄기·기기/연결 차단은 먼저 입력을 끝내고 Native revision을 저장한다. 복구 제안은 expectedRevision과
UUID 요청 ID에 결속된 단일 pending이며, Main 응답만으로 권한이 늘지 않는다. 사람이 중앙 권한관리에서
누른 경우에만 Control의 LAContext가 실행되고, 성공 후 현재 Main 세대·issuer revision·binding·wall clock과
uptime 60초 기한·CAS를 재검사해 직접 커밋한다. 승인 API나 JS 승인 boolean은 없다. Main 종료·취소·만료의
늦은 인증은 폐기한다. 재시작 뒤 미완료 review는 unknown이며 자동 재요청하지 않는다. 실제 연결에는 재인증하지 않는다.

수신 peer는 감사된 Main이 구성한 `rcu_<실제 portal UUID>_<인증된 instance32hex>_<nonce UUID>`에
결속한다. 매 Native 원격 요청과 실제 action guard에서 현재 policy와 standing을 다시 검사한다. 일반 caller
형식은 바꾸지 않는다. 화면 Viewer/생체 UI·기존 보호 앱·human hold·unknown 정지는 그대로다.

## 모바일 목적별 실행

`mobile-agent`, `mobile-teams`, `mobile-agent-settings`, `mobile-browser`는 각각 위 네 목적과만 결속한다.
Native는 typed access/component-session, 자신의 host ticket relay-bind, `mobile-host-handshake`만 서명한다.
모바일 cert의 null controlKey/agentDeviceId와 독립 RAM use 키, 현재 issuer use episode, 자체 Control 키,
24필드 transcript를 검증한 뒤 host-domain proof를 만든다. 임의 bytes 서명이나 v1 handshake 호환은 없다.
정확한 bytes와 공유 software golden은 `MOBILE-CONTROL-V2.md`를 따른다.

`createCommunityMobileConsumers`는 verified principal과 Root의 매 effect fresh guard를 받아 실제 기존
Teams/CLI/owned-browser 런타임을 호출한다. prepare는 실행하지 않으며 원래 operationId/createdAt를 backend
영수증에 기록한 뒤에만 effect를 호출한다. 결과가 없으면 unknown으로 남기고 재실행하지 않는다.
Teams는 기존 default-none 프로젝트 허용과 실제 registration identity를 재검사하고 endpoint 없는 별도 모바일
opaque ref/generation을 사용한다. CLI settings는 auto/recommend/off와 pinned 모델·강도를 보존하며 Desktop
네이티브 앱 강도를 자동 변경하지 않는다. Browser는 이미 agent에게 넘긴 owned context/epoch/관찰 요소만
사용하며 grant를 외부로 내보내지 않는다. 실제 OS·생체 승인 및 실기 테스트는 이 소프트웨어 검증과 별개다.
