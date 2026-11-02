import type {CommunityAdapterAuthorization} from './communityAdapterAuthorization';
import type {NativeCommunityComponentIdentity} from './communityComponentIdentity';
import type {WorkroomEffortSettingStore} from './workroomEffortSetting';

/** Host-only receiver wiring: the endpoint comes from the authenticated control receipt owner, never a wire claim. */
export async function communityWorkroomEffortPolicy(deps:{adapter:CommunityAdapterAuthorization;identity:Pick<NativeCommunityComponentIdentity,'directory'>;devices:()=>Promise<{inside:boolean;devices:readonly {deviceId:string;endpointId:string}[]}>},owner:string,setting:WorkroomEffortSettingStore){
  const endpoint=/^community:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(owner)?.[1];
  if(!endpoint)throw Error('설정 조정의 인증된 발신 기기를 확인하지 못했습니다.');
  const policy=await deps.adapter.workroomEffortPolicy(setting);
  const peer=async()=>{
    const devices=await deps.devices(),member=devices.inside?devices.devices.filter(d=>d.endpointId===endpoint):[];
    if(member.length!==1)throw Error('현재 커뮤니티 설정 조정 끝점을 확인하지 못했습니다.');
    const choices=(await deps.identity.directory('agent')).filter(a=>a.body.agentDeviceId===member[0]!.deviceId&&a.body.deviceId!==policy.witness.deviceId&&a.body.profileId===policy.witness.profileId&&a.body.communityId===policy.witness.communityId&&a.body.capabilities.includes('computer-use.agent-settings')&&a.permits('agent',Date.now()));
    if(choices.length!==1)throw Error('발신 Mac의 설정 조정 선택을 확인하지 못했습니다.');return choices[0]!;
  };
  const admitted=await peer();return{mode:policy.mode,isAuthorized:()=>policy.isAuthorized()&&admitted.permits('agent',Date.now()),beforeEffect:async()=>{
    if(!await policy.beforeEffect())return false;try{return(await peer()).policyDigest===admitted.policyDigest&&policy.isAuthorized();}catch{return false;}
  }};
}
