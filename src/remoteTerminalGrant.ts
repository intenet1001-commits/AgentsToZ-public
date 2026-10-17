import {normalizeWorkspaceScopes,type MobileWorkspaceScope} from './mobileWorkspaceProtocol';
import {normalizeHistoryScopes,type RemoteHistoryScope} from './workroomHistoryRemoteProtocol';
/** Device consent is independent of the current transport owner and of legacy session consent. */
export type RemoteTerminalGrantScope =
 | {kind:'targets';targetIds:readonly string[]}
 | {kind:'controller-created-projects';workspaceRoots:readonly {workspaceRootId:string;identityHash:string}[]};
/** `historyScopes` is a separate, versioned field: readers before it ignore an unknown key (rollback keeps working and
 *  grants nothing), while `workspaceScopes` readers reject unknown names. Absent = no history access. */
export interface RemoteTerminalGrant {workspaceScopes?:MobileWorkspaceScope[];historyScopes?:RemoteHistoryScope[];hostId:string;controllerId:string;scope:RemoteTerminalGrantScope;grantedAt:string;expiresAt:string;revision:number;revokedAt:string|null}
export interface RemoteTerminalGrantStore {
 find(hostId:string,controllerId:string):Promise<RemoteTerminalGrant|null>;
 update(grant:RemoteTerminalGrant,expectedRevision:number|null):Promise<boolean>;
}
export const REMOTE_TERMINAL_GRANT_TTL_MS=30*24*60*60*1000;
const identifier=(x:unknown):x is string=>typeof x==='string'&&x.length>0&&x.length<=256;
export function validateRemoteTerminalGrant(g:RemoteTerminalGrant):void {
 if(!g||!identifier(g.hostId)||!identifier(g.controllerId)||!Number.isSafeInteger(g.revision)||g.revision<1||!Number.isFinite(Date.parse(g.grantedAt))||!Number.isFinite(Date.parse(g.expiresAt))||Date.parse(g.expiresAt)<=Date.parse(g.grantedAt)||Date.parse(g.expiresAt)-Date.parse(g.grantedAt)>REMOTE_TERMINAL_GRANT_TTL_MS||g.revokedAt!==null&&!Number.isFinite(Date.parse(g.revokedAt)))throw new Error('워크룸 기기 권한 형식이 올바르지 않습니다.');
 if(g.workspaceScopes!==undefined)normalizeWorkspaceScopes(g.workspaceScopes);
 if(g.historyScopes!==undefined)normalizeHistoryScopes(g.historyScopes);
 const scope=g.scope;
 if(scope?.kind==='targets') {if(!Array.isArray(scope.targetIds)||!scope.targetIds.length||scope.targetIds.length>256||!scope.targetIds.every(identifier)||new Set(scope.targetIds).size!==scope.targetIds.length)throw new Error('허용 프로젝트를 확인하세요.');}
 else if(scope?.kind==='controller-created-projects') {if(!Array.isArray(scope.workspaceRoots)||!scope.workspaceRoots.length||scope.workspaceRoots.length>64||!scope.workspaceRoots.every(r=>identifier(r.workspaceRootId)&&identifier(r.identityHash)))throw new Error('허용 작업 폴더를 확인하세요.');}
 else throw new Error('워크룸 권한 범위를 확인하세요.');
}
export interface RemoteTerminalGrantBinding {hostId:string;controllerId:string;expiresAt:string}
export function remoteTerminalGrantValid(g:RemoteTerminalGrant|null,b:RemoteTerminalGrantBinding,now=Date.now()):g is RemoteTerminalGrant {
 if(!g)return false;
 try{validateRemoteTerminalGrant(g);}catch{return false;}
 return g.hostId===b.hostId&&g.controllerId===b.controllerId&&g.revokedAt===null&&Date.parse(g.grantedAt)<=now&&now<Math.min(Date.parse(g.expiresAt),Date.parse(b.expiresAt));
}
export interface RemoteTerminalCreatedProjectEvidence {controllerId:string;workspaceRootId:string;identityHash:string;registered:boolean}
export function remoteTerminalGrantAllowsTarget(g:RemoteTerminalGrant,targetId:string,evidence?:RemoteTerminalCreatedProjectEvidence):boolean {
 return g.scope.kind==='targets'?g.scope.targetIds.includes(targetId):!!evidence&&evidence.registered&&evidence.controllerId===g.controllerId&&g.scope.workspaceRoots.some(r=>r.workspaceRootId===evidence.workspaceRootId&&r.identityHash===evidence.identityHash);
}
/** The scope a device's Workroom history permission was granted for, in the shape of the `/access` save body. Only on the
 *  Mac's local management listing (never on the relay wire), so the Mac panel's save — which replaces the scope — carries
 *  history only into the scope a person approved it for. A folder no longer the one granted (its identity changed or it is
 *  gone) is left out. Null when the grant holds no history. */
export function remoteTerminalHistoryGrantScope(g:RemoteTerminalGrant,roots:readonly {workspaceRootId:string;path:string}[],identityOf:(path:string)=>string):{targetIds:string[]}|{workspaceRootIds:string[]}|null {
 if(!g.historyScopes?.length)return null;
 if(g.scope.kind==='targets')return {targetIds:[...g.scope.targetIds]};
 return {workspaceRootIds:g.scope.workspaceRoots.filter(granted=>{
  const root=roots.find(r=>r.workspaceRootId===granted.workspaceRootId);
  if(!root)return false;
  try{return identityOf(root.path)===granted.identityHash}catch{return false}
 }).map(granted=>granted.workspaceRootId)};
}
