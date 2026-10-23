import {PLATFORM_CLI_LABELS,type PlatformCliProvider,type PlatformCliAccountPurpose} from './platformCliProtocol';
import type {PlatformCliSetupStatus} from './platformCliSetup';
export const PLATFORM_CLI_INSTALL_URLS:Record<PlatformCliProvider,string>={github:'https://cli.github.com/',vercel:'https://vercel.com/docs/cli',supabase:'https://supabase.com/docs/guides/local-development/cli/getting-started','google-workspace':'https://github.com/googleworkspace/cli#installation'};
export const PLATFORM_SIGNUP_URLS:Record<PlatformCliProvider,string>={github:'https://github.com/signup',supabase:'https://supabase.com/dashboard/sign-up',vercel:'https://vercel.com/signup','google-workspace':'https://accounts.google.com/signup'};
export function buildPlatformCliSetupHandoff(provider:PlatformCliProvider,status:PlatformCliSetupStatus|null,platform:string,purpose:PlatformCliAccountPurpose='project-cli'):string{
  if(purpose==='app-sync-account')return `아젠투지 자체 데이터 저장소의 Supabase 관리 로그인 연결을 도와주세요. 이 작업은 프로젝트 작업용 CLI 계정 관리와 별개입니다.
CLI 설치 상태: ${status?.installed===true?'설치됨':status?.installed===false?'찾지 못함':'확인 필요'}. 먼저 다시 검사하고 없을 때만 공식 안내 ${PLATFORM_CLI_INSTALL_URLS.supabase} 에 따라 설치하세요. 이미 설치된 CLI는 재설치하지 마세요.
첫 기기 동기화 설정의 “Supabase 관리 로그인 추가”에서 사용할 이메일을 입력하고 “기존 로그인 확인·연결” 또는 “브라우저로 계정 연결”을 진행하세요. 계정이 없으면 공식 로그인 화면에서 가입합니다. 승인은 해당 계정 브라우저 프로필에서 진행하고 비밀번호·2FA·토큰·키를 AI 대화에 넣지 마세요.
연결 결과를 확인한 뒤 위의 “연결한 계정 다시 읽기”를 누르고 “Supabase 관리 계정”과 데이터를 저장할 프로젝트를 명시적으로 선택하세요. 프로젝트 작업용 CLI 기본 계정은 바꾸지 마세요. 기존 앱 데이터 저장소도 명시적 설정 완료 전에는 바꾸지 마세요. 다른 기기에서 이미 동기화 중이면 새 DB를 만들지 말고 추가 기기로 연결하세요. 마지막에 앱에서 실제 상태와 다음 클릭 하나를 알려주세요.`;
  return `AgentsToZ의 ${PLATFORM_CLI_LABELS[provider]} 계정 연결을 도와주세요. 현재 기기: ${platform==='MacIntel'||platform==='MacPPC'?'macOS':platform==='Win32'?'Windows':'현재 기기'}.
앱이 확인한 CLI 설치 상태: ${status?.installed===true?'설치됨':status?.installed===false?'찾지 못함':'확인 필요'}. 앱에 이메일 확인 후 연결한 계정: ${status?.connected??0}개. 이 기록은 복사 시점의 상태이므로 먼저 다시 검사하세요.
1. 앱을 로컬로 쓰는 데 네 서비스 전부가 필요하지 않습니다. 이번에 선택한 서비스만 준비하세요. 이미 설치된 CLI는 재설치하지 마세요. 필요한 런타임·패키지 관리자가 없으면 공식 문서 ${PLATFORM_CLI_INSTALL_URLS[provider]} 를 확인해 필요한 것부터 설치하고 버전을 확인하세요. 설치·제거 명령을 임의로 실행하지 마세요.
2. 앱의 “CLI 계정 관리 → CLI 설치·계정 연결 → 설치 상태 다시 확인”을 누르세요. 설치된 뒤 사용자에게 사용할 이메일을 정하게 하고 “기존 로그인 확인·연결” 또는 “브라우저로 계정 연결”로 진행하세요. 기존 로그인의 이메일이 다르면 자동 전환하지 말고 브라우저에서 해당 계정으로 로그인하세요. 계정이 없으면 제공자 공식 화면에서 가입하도록 안내하세요.
3. OAuth 승인은 해당 계정의 브라우저 프로필에서 진행합니다. Google은 Desktop OAuth JSON을 앱에 첨부하거나 드래그하고 Drive 읽기 권한을 승인합니다. JSON 내용, 비밀번호, 2FA, 토큰·키를 AI 대화나 인계문에 넣지 마세요. 앱의 연결 확인 결과가 있어야 완료입니다.
4. 연결된 계정 중 “기본 계정으로 사용”을 선택하세요. 프로젝트에 지정한 다른 계정은 유지하세요. CLI 로그인이나 기본 계정 변경만으로 아젠투지 자체 동기화 DB를 바꾸지 마세요.
5. 여러 기기 동기화가 필요할 때만 “첫 기기 · 동기화 설정”에서 사용할 Supabase 계정과 아젠투지 데이터를 둘 프로젝트를 명시적으로 선택하세요. 기존 동기화를 쓰는 PC가 있으면 새 DB를 만들지 말고 “두 번째·추가 기기 연결”로 이어가세요. 새 프로젝트·과금·기존 설정 교체는 구체적 대상을 먼저 확인하세요. 마지막에 앱에서 실제 상태와 다음 클릭 하나를 알려주세요.`;
}
