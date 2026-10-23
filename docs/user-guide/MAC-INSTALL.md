# AgentsToZ v1165 Mac 설치 안내

Apple Silicon(M1·M2·M3·M4 등) Mac용 테스트 버전입니다. 최소 macOS 13이며 Intel Mac용은 아닙니다.

[Mac 설치 파일 다운로드](https://github.com/intenet1001-commits/AgentsToZ-public/releases/download/v1165.0.0/AgentsToZ_byCS_1165_arm64.dmg) · [버전 안내](https://github.com/intenet1001-commits/AgentsToZ-public/releases/tag/v1165.0.0)

1. 다운로드한 DMG를 엽니다.
2. `AgentsToZ_byCS.app`을 `Applications` 폴더로 끌어다 놓습니다. 기존 앱을 업데이트한다면 먼저 앱과 진행 중인 작업을 종료하세요.
3. Applications에서 앱을 열고, 우선 **로컬로 바로 시작**을 선택합니다. 필요한 도구는 **아젠투지 호출** 창 오른쪽 위의 **헬프데스크**에서 한 번에 준비하고, 사용할 Codex 또는 Claude를 공식 인증한 뒤 질문으로 설정을 마무리하세요.

앱 설치와 로컬 사용에는 GitHub·Supabase·Vercel 계정이 필요 없습니다. Git·Bun·소스 다운로드도 앱 설치의 선행 조건이 아닙니다.

계정은 필요한 기능에만 연결하세요.

- **AI로 작업:** 사용할 Codex·Claude 등 해당 AI 서비스에 로그인합니다.
- **GitHub 코드 작업·Vercel 배포·프로젝트 DB 작업:** **프로젝트 작업용 서비스 계정**에서 사용할 서비스만 연결합니다.
- **여러 기기에서 앱 데이터 동기화·장기기억 백업:** **앱 데이터 저장·기기 동기화**에서 본인의 Supabase 저장소를 연결합니다.
- **개인 웹 포털:** 별도 웹 주소가 필요할 때만 Vercel 등 웹 포털 설정을 진행합니다.

**고급 토큰·JSON 등록**은 선택한 서비스의 프로젝트 작업용 계정을 직접 등록할 때만 씁니다. 처음에는 브라우저 로그인을 사용하세요. 서비스 계정 로그인만으로 앱 데이터 저장소가 바뀌지는 않습니다.

로그인·키체인 승인은 Mac에서 직접 처리하고 비밀번호·토큰을 채팅으로 보내지 마세요. 업데이트는 새 DMG를 받아 설치합니다.

Apple 서명·공증을 마친 사전 배포입니다. 이 버전의 설치 Mac에서 헬프데스크 진입·기존 도구 확인·실제 AI 답변을 확인했습니다. 새 macOS 사용자·별도 Mac 첫 설치, 같은 버전의 핵심 작업 반복·iPhone·다른 네트워크·장시간 운용은 별도 검증 대상입니다. Mac TestFlight 배포가 아닙니다.

**TestFlight와 구분하세요.** Mac 전체 기능은 이 공증 DMG 앱에서 제공합니다. TestFlight의 AgentsToZ는 다른 컴퓨터에 연결하는 원격 클라이언트이며, iPhone/iPad 앱의 Mac 호환판입니다. 두 앱의 버전과 실제 실행 위치는 서로 다릅니다.

최신 소스의 필수 계정·전용 저장소 자동 준비를 포함한 전체 흐름은 [헬프데스크 사용법](HELPDESK.md)과 [후속 새 Mac 안내](MAC-NEWCOMER.md)에서 확인하세요. 이 문서의 v1165 설치본과 후속 빌드의 기능·검증 범위는 다릅니다.
