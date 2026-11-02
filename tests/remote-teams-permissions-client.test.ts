import {describe,expect,test} from 'bun:test';
import {createRemoteTeamsPermissionsRequester,parseRemoteTeamsPermissions,REMOTE_TEAMS_PERMISSIONS_PATH,RemoteTeamsPermissionsError} from '../src/remoteTeamsPermissionsClient';
const state={revision:0,projects:[{projectId:'project-1',name:'등록 프로젝트',allowed:false}],configured:true};
describe('remote Teams local permissions client',()=>{
  test('only the native Main capability proxy transports a typed CAS update',async()=>{
    const calls:unknown[]=[];
    const request=createRemoteTeamsPermissionsRequester({native:()=>true,invoke:async(command,args)=>{calls.push([command,args]);return {status:200,body:state};}});
    expect(await request({operation:'permissions'})).toEqual(state);
    expect(await request({operation:'set-permissions',expectedRevision:0,projectIds:['project-1']})).toEqual(state);
    expect(calls).toEqual([
      ['agent_runtime_request',{path:REMOTE_TEAMS_PERMISSIONS_PATH,method:'POST',body:{operation:'permissions'}}],
      ['agent_runtime_request',{path:REMOTE_TEAMS_PERMISSIONS_PATH,method:'POST',body:{operation:'set-permissions',expectedRevision:0,projectIds:['project-1']}}],
    ]);
  });
  test('browser mode cannot fall back to HTTP or invoke native management',async()=>{
    let calls=0;
    const request=createRemoteTeamsPermissionsRequester({native:()=>false,invoke:async()=>{calls++;return {};}});
    await expect(request({operation:'permissions'})).rejects.toMatchObject({code:'REMOTE_TEAMS_MAIN_REQUIRED'});
    expect(calls).toBe(0);
  });
  test('malformed/overbroad requests are refused before dispatch',async()=>{
    let calls=0;const request=createRemoteTeamsPermissionsRequester({native:()=>true,invoke:async()=>{calls++;return {};}});
    for(const input of [
      {operation:'permissions',projectIds:['project-1']},
      {operation:'set-permissions',expectedRevision:0,projectIds:['project-1','project-1']},
      {operation:'set-permissions',expectedRevision:0,projectIds:['../private']},
      {operation:'set-permissions',expectedRevision:-1,projectIds:[]},
      {operation:'set-permissions',expectedRevision:0,projectIds:[],allowAll:true},
    ])await expect(request(input as any)).rejects.toBeInstanceOf(RemoteTeamsPermissionsError);
    expect(calls).toBe(0);
  });
  test('the catalog cannot carry paths, duplicate IDs or implicit allow-all',()=>{
    expect(parseRemoteTeamsPermissions(state)).toEqual(state);
    for(const value of [
      {...state,revision:true}, {...state,allowed:true},
      {...state,projects:[{...state.projects[0],path:'/private'}]},
      {...state,projects:[state.projects[0],state.projects[0]]},
      {...state,projects:[{...state.projects[0],allowed:'true'}]},
      {...state,projects:[{...state.projects[0],name:'가'.repeat(81)}]},
    ])expect(()=>parseRemoteTeamsPermissions(value)).toThrow(RemoteTeamsPermissionsError);
  });
  test('CAS and consent refusals never replay the selection',async()=>{
    for(const code of ['REMOTE_TEAMS_REVISION_CONFLICT','REMOTE_TEAMS_PROJECT_CHANGED','REMOTE_TEAMS_CONSENT_REQUIRED']){
      let calls=0;const request=createRemoteTeamsPermissionsRequester({native:()=>true,invoke:async()=>{calls++;return {status:409,body:{code,error:'private server detail'}};}});
      await expect(request({operation:'set-permissions',expectedRevision:3,projectIds:['project-1']})).rejects.toMatchObject({code,status:409});
      expect(calls).toBe(1);
    }
  });
  test('unknown native outcome does not automatically resend a mutation',async()=>{
    let calls=0;const request=createRemoteTeamsPermissionsRequester({native:()=>true,invoke:async()=>{calls++;throw Error('socket lost');}});
    await expect(request({operation:'set-permissions',expectedRevision:0,projectIds:['project-1']})).rejects.toMatchObject({code:'REMOTE_TEAMS_UNCONFIRMED'});
    expect(calls).toBe(1);
  });
});
