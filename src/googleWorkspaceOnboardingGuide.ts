/** Static, credential-free handoff. Never interpolate a client file, email, token, path or stored account. */
export const GOOGLE_WORKSPACE_COMPUTER_USE_HANDOFF = `AgentsToZ의 Google Workspace CLI 첫 연결을 브라우저의 컴퓨터 사용으로 도와주세요. CLI 명령이나 긴 설명서를 따라 치게 하지 말고 현재 화면을 확인하며 다음 필요한 단계 하나씩 진행하세요.

목표: 본인의 Google Cloud 프로젝트에서 필요한 API·OAuth 동의 화면·Desktop app 클라이언트를 준비한 뒤, 사용자가 JSON을 AgentsToZ에 직접 첨부하고 공식 Google 로그인과 실제 연결 검사를 완료합니다.

1. 실제 제공되는 컴퓨터 사용 도구와 관련 브라우저 지침을 먼저 확인하세요. 지원되지 않으면 자동화했다고 말하지 말고 현재 공식 화면에서 다음 클릭을 안내하세요. 이 안내 복사는 AI 실행이나 계정 변경 승인이 아닙니다. 사용자가 이 요청을 보낸 뒤 해당 범위에서 진행하세요.
2. Google Cloud Console https://console.cloud.google.com/ 에서 사용할 계정과 프로젝트를 확인하세요. 기존 프로젝트·API·OAuth 클라이언트를 먼저 확인하고 그대로 활용하세요. 새 프로젝트가 필요하면 대상과 이유를 설명하세요. 과금 연결·공개 배포·조직 전체 권한은 이 요청에 포함되지 않습니다.
3. 앱의 Google 설정 따라하기와 같은 순서로 진행하세요. API Library의 기본 준비 목록은 Drive·Docs·Sheets·Slides·Gmail·Calendar·Forms·Tasks·People·Chat입니다. 사용자가 선택한 서비스만 같은 프로젝트에서 사용 설정하고 이미 켜진 것은 재사용하세요. 현재 앱의 첫 연결 로그인은 Drive 읽기 권한입니다. API를 켰다는 이유로 메일·문서의 쓰기 권한이나 조직 전체 권한을 일괄 승인하지 마세요. API 사용 설정과 OAuth 접근 승인은 별도입니다.
4. Google Auth Platform의 Branding·Audience·Data Access를 현재 화면에서 준비하세요. 개인 Gmail이면 External이며 Testing 상태에서는 연결할 이메일을 각각 Test users에 추가합니다. 조직 정책으로 막히면 관리자 확인 항목을 알리고 우회하지 마세요.
5. Clients에서 Desktop app 유형을 선택하세요. Supabase Google 로그인용 Web application 클라이언트와 구분하세요. 생성 결과에 비밀값이 표시되기 직전에는 사용자에게 넘겨 클라이언트 생성·JSON 다운로드·민감 화면 닫기를 직접 완료하게 하세요.
6. JSON을 열거나 파일·클립보드 내용을 읽지 마세요. 파일 내용을 대화·인계문·스크린샷·로그에 남기지 마세요. 사용자에게 Mac에 저장한 파일을 AgentsToZ의 “Google Console 클라이언트 JSON”에서 직접 선택하거나 첨부 영역으로 드래그하게 하세요. AI 대화나 브라우저 업로드 칸에 첨부하지 않습니다.
7. Google 비밀번호·2단계 인증·권한 승인과 OS 키체인 승인은 사용자가 직접 처리합니다. 민감 화면이 열려 있는 동안 화면 캡처·DOM 읽기를 멈추고, 사용자가 닫았다고 알린 뒤 다시 확인하세요. 컴퓨터 사용도 화면 내용을 AI 문맥으로 처리할 수 있으므로 비밀이 자동으로 격리된다고 설명하지 마세요.
8. 앱에서 사용할 이메일로 “브라우저로 계정 연결”을 진행하고, “이메일 인증 완료”와 실제 “연결 확인” 결과를 확인하세요. JSON 첨부나 수동 체크만으로 성공 처리하지 마세요. 이미 연결된 다른 계정·기본값·프로젝트 설정은 보존하세요. Supabase 저장소나 모바일 Google Provider는 이 과정으로 자동 설정되지 않습니다.

마지막에는 실제 확인 결과, 남은 단계와 다음 클릭 하나를 짧게 알려주세요. 공식 참고: https://github.com/googleworkspace/cli#manual-oauth-setup-google-cloud-console`;
