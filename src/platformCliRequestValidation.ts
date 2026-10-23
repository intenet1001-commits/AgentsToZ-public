import {PlatformCliError,platformCliProvider,platformCliText,platformCliAccountPurpose} from './platformCliProtocol';
export const PLATFORM_CLI_AGENT_OPERATIONS=['project','bind','push-options','prepare-push','execute-push'] as const;
export function validatePlatformCliRequest(value:unknown,agent=false):Record<string,any> {
  const r=value as Record<string,any>;
  const fields:Record<string,string[]>={'google-client-status':[],'google-client-save':['clientJson'],'set-default':['provider','email','accountId','requestId'],'login-start':['provider','email','requestId','purpose'],'login-status':['loginId'],'login-code':['loginId','code'],'login-cancel':['loginId'],'native-github-accounts':['requestId'],'connect-github':['login','requestId'],list:['provider'],create:['provider','label','credential','requestId'],check:['accountId','requestId'],archive:['accountId','requestId'],project:['targetId'],bind:['targetId','provider','binding','requestId'],'push-options':['targetId','folderPath'],'prepare-push':['targetId','accountId','remote','folderPath'],'execute-push':['targetId','planId','requestId']};
  Object.assign(fields,{'setup-status':[],'connect-native':['provider','email','requestId','purpose'],'supabase-projects':['accountId'],'supabase-client-key':['accountId','ref']});
  Object.assign(fields,{'login-onboarding-start':['provider','requestId','purpose']});
  Object.assign(fields,{'check-start':['accountId','requestId'],'connect-native-start':['provider','email','requestId','purpose'],'connection-status':['requestId']});
  if(!r||typeof r!=='object'||Array.isArray(r)||!Object.hasOwn(fields,r.operation)||Object.keys(r).some(k=>k!=='operation'&&!fields[r.operation]!.includes(k)))throw new PlatformCliError('CLI 계정 요청 형식을 확인하세요.');
  if(agent&&(!(PLATFORM_CLI_AGENT_OPERATIONS as readonly string[]).includes(r.operation)||r.folderPath!==undefined))throw new PlatformCliError('계정 등록·인증 정보·로컬 경로는 앱에서 관리하세요.');
  if(r.provider!==undefined&&!platformCliProvider(r.provider))throw new PlatformCliError('지원하는 CLI를 선택하세요.');
  if(['project','bind','push-options','prepare-push','execute-push'].includes(r.operation)&&(!platformCliText(r.targetId,200)||!/^[A-Za-z0-9_-]+$/.test(r.targetId)))throw new PlatformCliError('등록 프로젝트를 선택하세요.');
  if(['login-start','connect-native','connect-native-start'].includes(r.operation))platformCliAccountPurpose(r.purpose,r.provider);
  if(r.folderPath!==undefined&&(typeof r.folderPath!=='string'||r.folderPath.length>2048||/[\x00\r\n]/.test(r.folderPath)))throw new PlatformCliError('워크트리 위치를 확인하세요.');
  if(JSON.stringify(r).length>24_576)throw new PlatformCliError('CLI 계정 요청이 너무 큽니다.');
  return {...r};
}
