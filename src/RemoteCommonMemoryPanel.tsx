import React,{useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {CommonMemoryPanel} from './CommonMemoryPanel';
import {CommonMemorySurfaceContext} from './MetaCommonMemoryPanel';
import {createCommonMemoryClient} from './commonMemoryClient';
import type {CommonMemoryWorkroomBridge} from './commonMemoryFollowup';
import {createMetaMemoryRemoteRequester} from './metaCommonMemoryRemoteClient';
import type {MobileWorkspaceRequest,MobileWorkspaceResult} from './mobileWorkspaceProtocol';
import {phoneOfflineNotice} from './phoneNetwork';
/** A phone connection without the Mac's OPS project (it sorts first, so a listed connection that has one shows it). */
export const REMOTE_COMMON_MEMORY_NO_OPS='이 연결에는 아젠투지(OPS) 프로젝트가 허용되지 않아 AI 정리를 시작할 수 없습니다. 기억 항목은 직접 작성할 수 있고, AI 정리는 Mac의 원격제어에서 OPS 프로젝트를 허용한 뒤 사용하세요.';
export function RemoteCommonMemoryPanel({visible,available,online,phoneOnline=true,hostName,transport,onProjectsChanged,rpcV2=false,cacheKey,onCloudList,workroom,focusMemoryId,onFocusHandled}:{visible:boolean;available:boolean;online:boolean;/** The phone's own network: without it the Mac's state is unknown, and the panel says so instead of asking to connect a Mac. */phoneOnline?:boolean;hostName?:string;rpcV2?:boolean;/** One connection to one Mac: its last list is shown at once when this tab comes back. */cacheKey?:string;transport:(request:MobileWorkspaceRequest)=>Promise<MobileWorkspaceResult>;onProjectsChanged?:()=>void;/** Each list read: whether the cloud list answered and how many local groups still wait (see portalLocalCommonVisible). */onCloudList?:(state:{ok:boolean;localPending:number|null})=>void;
  /** The connected Mac's OPS workroom: the AI buttons fill its composer on this phone (nothing runs until the person sends). */workroom?:CommonMemoryWorkroomBridge;
  /** A long-term memory picked in the phone's memory list: opens the group that links it, or creating one with it preset. */focusMemoryId?:string;
  /** The focus was used (or refused for an unsaved draft): the parent drops it, so a remount does not jump again. */onFocusHandled?:()=>void}){
  const client=useMemo(()=>{const rpc=createMetaMemoryRemoteRequester(transport,'common-memory',{rpcV2});return createCommonMemoryClient((operation,input)=>rpc({operation,input}));},[transport,rpcV2]);
  // A tab switch unmounts the panel (its list comes back from the cache and refreshes) unless something typed there is
  // not saved yet, or a save's result is unknown: then it stays mounted, only hidden. The parent keys this component by
  // connection, so a kept draft never reaches another Mac.
  const drafts=useRef(new Set<object>()),[keep,setKeep]=useState(false);
  const keepDraft=useCallback((owner:object,unsaved:boolean)=>{if(unsaved)drafts.current.add(owner);else drafts.current.delete(owner);setKeep(drafts.current.size>0);},[]);
  const host=hostName??'연결한 Mac';
  const surface=useMemo(()=>({hostName:host,keepDraft}),[host,keepDraft]);
  const shown=visible&&online&&available;
  // A jump would swap the open group and lose what is typed there, so with an unsaved draft it is refused and said.
  const [focusRefused,setFocusRefused]=useState(false);
  useEffect(()=>{if(!focusMemoryId||!keep)return;setFocusRefused(true);onFocusHandled?.();},[focusMemoryId,keep]);
  useEffect(()=>{if(!keep)setFocusRefused(false);},[keep]);
  return <section className="meta-common-memory-mobile" hidden={!visible} data-testid="remote-cloud-common-memory">
    {!online&&<p role="status">{phoneOnline?'관리할 Mac에 연결하면 그 Mac과 같은 클라우드의 공통기억을 사용할 수 있습니다.':phoneOfflineNotice()}</p>}
    {online&&!available&&<p role="status">연결한 Mac 앱을 업데이트하면 클라우드 공통기억을 관리할 수 있습니다.</p>}
    {(shown||keep)&&<div hidden={!shown}><p className="text-sm">연결한 Mac: {host} · 같은 클라우드의 공통기억을 관리합니다.</p>{focusRefused&&<p role="status" className="text-sm" data-testid="common-memory-focus-refused">작성 중인 공통기억이 있어 고른 장기기억으로 옮기지 않았습니다. 저장하거나 취소한 뒤 다시 누르세요.</p>}<CommonMemorySurfaceContext.Provider value={surface}><CommonMemoryPanel client={client} initiallyOpen focusMemoryId={keep?undefined:focusMemoryId} onFocusHandled={onFocusHandled} phoneCacheKey={cacheKey??hostName??'connected-mac'} onProjectsChanged={onProjectsChanged} onCloudList={onCloudList} workroom={workroom} workroomUnavailable={workroom?.targetId?undefined:REMOTE_COMMON_MEMORY_NO_OPS}/></CommonMemorySurfaceContext.Provider></div>}
  </section>;
}
