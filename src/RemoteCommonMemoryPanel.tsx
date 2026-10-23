import React,{useMemo} from 'react';
import {CommonMemoryPanel} from './CommonMemoryPanel';
import {createCommonMemoryClient} from './commonMemoryClient';
import {createMetaMemoryRemoteRequester} from './metaCommonMemoryRemoteClient';
import type {MobileWorkspaceRequest,MobileWorkspaceResult} from './mobileWorkspaceProtocol';
export function RemoteCommonMemoryPanel({visible,available,online,hostName,transport,onProjectsChanged,rpcV2=false,cacheKey,onCloudList}:{visible:boolean;available:boolean;online:boolean;hostName?:string;rpcV2?:boolean;/** One connection to one Mac: its last list is shown at once when this tab comes back. */cacheKey?:string;transport:(request:MobileWorkspaceRequest)=>Promise<MobileWorkspaceResult>;onProjectsChanged?:()=>void;/** Each list read: whether the cloud list answered and how many local groups still wait (see portalLocalCommonVisible). */onCloudList?:(state:{ok:boolean;localPending:number|null})=>void}){
  const client=useMemo(()=>{const rpc=createMetaMemoryRemoteRequester(transport,'common-memory',{rpcV2});return createCommonMemoryClient((operation,input)=>rpc({operation,input}));},[transport,rpcV2]);
  return <section className="meta-common-memory-mobile" hidden={!visible} data-testid="remote-cloud-common-memory">
    {!online&&<p role="status">관리할 Mac에 연결하면 그 Mac과 같은 클라우드의 공통기억을 사용할 수 있습니다.</p>}
    {online&&!available&&<p role="status">연결한 Mac 앱을 업데이트하면 클라우드 공통기억을 관리할 수 있습니다.</p>}
    {visible&&online&&available&&<><p className="text-sm">{hostName??'연결한 Mac'}의 클라우드 · 원본 장기기억은 보존됩니다.</p><CommonMemoryPanel client={client} initiallyOpen phoneCacheKey={cacheKey??hostName??'connected-mac'} onProjectsChanged={onProjectsChanged} onCloudList={onCloudList}/></>}
  </section>;
}
