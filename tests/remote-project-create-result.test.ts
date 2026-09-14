import {expect,test} from 'bun:test';
import {RemoteControlCore,REMOTE_CONTROL_PROTOCOL_VERSION,parseRemoteControlClientMessage,type RemoteControlActionRequest,type RemoteControlCreateProjectAction} from '../src/remoteControlCore';
import type {RemoteControlRegisteredTarget} from '../src/remoteControlProcessGateway';

test('new project outside page zero returns its exact safe card and receives trusted controller identity',async()=>{
  const target=(id:string,name:string):RemoteControlRegisteredTarget=>({internalId:id,name,kind:'main',folderPath:'/private/'+id,command:null,port:null,status:'unknown',actions:['folder.open']});
  let projects=Array.from({length:45},(_,i)=>target('id-'+i,'a-'+i));let creation:RemoteControlCreateProjectAction|undefined;
  const core=new RemoteControlCore({listRegisteredProjects:()=>projects,executeRegisteredProjectAction:()=>{},listWorkspaceRoots:()=>[{internalId:'root-1',name:'root'}],createProject:input=>{
    creation=input;projects.push(target('created-internal-id','zz-last-created'));return{internalId:'created-internal-id'};
  }},{hostName:'Fixture Mac'});
  const url=new URL(core.enable('http://192.168.1.20:43210').pairingUrl);
  const ready=await core.pair(new URLSearchParams(url.hash.slice(1)).get('pair')!);
  const request=(input:Partial<RemoteControlActionRequest>):RemoteControlActionRequest=>({type:'action.request',protocolVersion:REMOTE_CONTROL_PROTOCOL_VERSION,sessionToken:ready.sessionToken,actionId:'roots',action:'workspace-roots.list',...input});
  const roots=await core.perform(request({}));if(!roots.ok||!('workspaceRoots' in roots))throw Error('roots missing');
  const create=request({actionId:'create-1',action:'project.create',input:'zz-last-created',workspaceRootId:roots.workspaceRoots[0]!.controlId,remoteConfirmed:true});
  const result=await core.perform(create,{controllerId:'internet:trusted-controller',expiresAt:'2026-10-10T00:00:00Z'});
  expect(result).toMatchObject({ok:true,project:{name:'zz-last-created'}});expect(result).not.toHaveProperty('projects');
  expect(JSON.stringify(result)).not.toContain('created-internal-id');expect(JSON.stringify(result)).not.toContain('/private/');
  expect(creation).toMatchObject({controllerId:'internet:trusted-controller',sessionExpiresAt:'2026-10-10T00:00:00Z'});
  expect(()=>parseRemoteControlClientMessage({...create,controllerId:'forged-controller'})).toThrow();
});
