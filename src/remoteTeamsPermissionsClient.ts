import {invoke,isTauri} from '@tauri-apps/api/core';

export const REMOTE_TEAMS_PERMISSIONS_PATH='/api/agent-runtime/remote-teams' as const;
export interface RemoteTeamsProject {projectId:string;name:string;allowed:boolean}
export interface RemoteTeamsPermissions {revision:number;projects:RemoteTeamsProject[];configured:boolean}
export type RemoteTeamsPermissionsRequest={operation:'permissions'}|{operation:'set-permissions';expectedRevision:number;projectIds:string[]};
export class RemoteTeamsPermissionsError extends Error {
  constructor(readonly code:string,message:string,readonly status:number|null=null){super(message);this.name='RemoteTeamsPermissionsError';}
}
const invalid=()=>new RemoteTeamsPermissionsError('REMOTE_TEAMS_INVALID','원격 Teams 설정 응답을 확인하지 못했습니다. 최신 앱에서 현재 상태를 다시 확인하세요.');
const projectId=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const object=(value:unknown,keys:string[]):Record<string,unknown>=>{
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join('\0')!==[...keys].sort().join('\0'))throw invalid();
  return value as Record<string,unknown>;
};
export function parseRemoteTeamsPermissions(value:unknown):RemoteTeamsPermissions{
  const data=object(value,['revision','projects','configured']);
  if(!Number.isSafeInteger(data.revision)||(data.revision as number)<0||typeof data.configured!=='boolean'||!Array.isArray(data.projects)||data.projects.length>200)throw invalid();
  const projects=data.projects.map(value=>{
    const item=object(value,['projectId','name','allowed']);
    if(!projectId(item.projectId)||typeof item.name!=='string'||!item.name.trim()||new TextEncoder().encode(item.name).length>240||typeof item.allowed!=='boolean')throw invalid();
    return {projectId:item.projectId,name:item.name,allowed:item.allowed};
  });
  if(new Set(projects.map(project=>project.projectId)).size!==projects.length)throw invalid();
  return {revision:data.revision as number,projects,configured:data.configured};
}
function checkedRequest(body:RemoteTeamsPermissionsRequest):RemoteTeamsPermissionsRequest{
  if(body.operation==='permissions'){object(body,['operation']);return {operation:'permissions'};}
  object(body,['operation','expectedRevision','projectIds']);
  if(body.operation!=='set-permissions'||!Number.isSafeInteger(body.expectedRevision)||body.expectedRevision<0||!Array.isArray(body.projectIds)||body.projectIds.length>200||!body.projectIds.every(projectId)||new Set(body.projectIds).size!==body.projectIds.length)throw invalid();
  return {operation:'set-permissions',expectedRevision:body.expectedRevision,projectIds:[...body.projectIds]};
}
export type RemoteTeamsPermissionsRequester=(body:RemoteTeamsPermissionsRequest)=>Promise<RemoteTeamsPermissions>;
/** Production uses the signed Main's existing capability proxy. No browser, remote, or direct HTTP fallback. */
export function createRemoteTeamsPermissionsRequester(options:{native?:()=>boolean;invoke?:(command:string,args:Record<string,unknown>)=>Promise<unknown>}={}):RemoteTeamsPermissionsRequester{
  const native=options.native??isTauri,call=options.invoke??invoke;
  return async input=>{
    const body=checkedRequest(input);
    if(!native())throw new RemoteTeamsPermissionsError('REMOTE_TEAMS_MAIN_REQUIRED','원격 Teams 프로젝트 설정은 이 Mac의 기본 AgentsToZ 앱 창에서만 변경할 수 있습니다.');
    let result:unknown;
    try{result=await call('agent_runtime_request',{path:REMOTE_TEAMS_PERMISSIONS_PATH,method:'POST',body});}
    catch{throw new RemoteTeamsPermissionsError('REMOTE_TEAMS_UNCONFIRMED','설정 결과를 확인하지 못했습니다. 같은 변경을 자동으로 반복하지 않습니다. 현재 허용 상태를 새로 읽어 확인하세요.');}
    if(!result||typeof result!=='object'||!Number.isInteger((result as any).status))throw invalid();
    const response=result as {status:number;body:unknown};
    if(response.status<200||response.status>=300){
      const error=response.body&&typeof response.body==='object'?response.body as Record<string,unknown>:{};
      const code=typeof error.code==='string'?error.code:'REMOTE_TEAMS_UNCONFIRMED';
      const messages:Record<string,string>={
        REMOTE_TEAMS_REVISION_CONFLICT:'다른 창에서 설정이 바뀌었습니다. 최신 목록을 불러와 선택을 다시 확인한 뒤 저장하세요.',
        REMOTE_TEAMS_PROJECT_CHANGED:'등록 프로젝트 또는 기기 신원이 바뀌었습니다. 최신 목록에서 선택을 다시 확인하세요.',
        REMOTE_TEAMS_CONSENT_REQUIRED:'이 기기의 공통 등록에서 Teams 사용 권한을 먼저 확인하세요. 프로젝트를 선택하는 것만으로 Teams 권한이 생기지는 않습니다.',
        REMOTE_TEAMS_INVALID:'선택한 프로젝트를 확인하지 못했습니다. 최신 목록을 다시 불러오세요.',
      };
      throw new RemoteTeamsPermissionsError(code,messages[code]??'원격 Teams 설정을 확인하지 못했습니다. 현재 허용 상태를 다시 읽어 확인하세요.',response.status);
    }
    return parseRemoteTeamsPermissions(response.body);
  };
}
export const requestRemoteTeamsPermissions=createRemoteTeamsPermissionsRequester();
