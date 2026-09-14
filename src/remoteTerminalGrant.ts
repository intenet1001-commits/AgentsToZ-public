import {normalizeWorkspaceScopes,type MobileWorkspaceScope} from './mobileWorkspaceProtocol';
/** Device consent is independent of the current transport owner and of legacy session consent. */
export type RemoteTerminalGrantScope =
 | {kind:'targets';targetIds:readonly string[]}
 | {kind:'controller-created-projects';workspaceRoots:readonly {workspaceRootId:string;identityHash:string}[]};
export interface RemoteTerminalGrant {workspaceScopes?:MobileWorkspaceScope[];hostId:string;controllerId:string;scope:RemoteTerminalGrantScope;grantedAt:string;expiresAt:string;revision:number;revokedAt:string|null}
export interface RemoteTerminalGrantStore {
 find(hostId:string,controllerId:string):Promise<RemoteTerminalGrant|null>;
 update(grant:RemoteTerminalGrant,expectedRevision:number|null):Promise<boolean>;
}
export const REMOTE_TERMINAL_GRANT_TTL_MS=30*24*60*60*1000;
const identifier=(x:unknown):x is string=>typeof x==='string'&&x.length>0&&x.length<=256;
export function validateRemoteTerminalGrant(g:RemoteTerminalGrant):void {
 if(!g||!identifier(g.hostId)||!identifier(g.controllerId)||!Number.isSafeInteger(g.revision)||g.revision<1||!Number.isFinite(Date.parse(g.grantedAt))||!Number.isFinite(Date.parse(g.expiresAt))||Date.parse(g.expiresAt)<=Date.parse(g.grantedAt)||Date.parse(g.expiresAt)-Date.parse(g.grantedAt)>REMOTE_TERMINAL_GRANT_TTL_MS||g.revokedAt!==null&&!Number.isFinite(Date.parse(g.revokedAt)))throw new Error('워크룸 기기 권한 형식이 올바르지 않습니다.');
 if(g.workspaceScopes!==undefined)normalizeWorkspaceScopes(g.workspaceScopes);
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
