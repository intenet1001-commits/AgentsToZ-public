import React,{useMemo} from 'react';
import {DeviceOperatingMemoryPanel} from './DeviceOperatingMemoryPanel';
import {createMetaMemoryRemoteRequester} from './metaCommonMemoryRemoteClient';
import {useAppLanguage} from './useAppLanguage';
import {t} from './i18n';
import type {MobileWorkspaceRequest,MobileWorkspaceResult} from './mobileWorkspaceProtocol';
export function RemoteDeviceMemoryPanel({visible,available,online,transport,rpcV2=false}:{visible:boolean;available:boolean;online:boolean;transport:(request:MobileWorkspaceRequest)=>Promise<MobileWorkspaceResult>;rpcV2?:boolean}){
 const [lang]=useAppLanguage();const request=useMemo(()=>createMetaMemoryRemoteRequester(transport,'device-memory',{rpcV2}),[transport,rpcV2]);
 return <section hidden={!visible}><p>{t(lang,'connectMemory')}</p>{!online?<p>{t(lang,'offlineMemory')}</p>:!available?<p>{t(lang,'updateHost')}</p>:<DeviceOperatingMemoryPanel visible={visible} request={request}/>}</section>;
}
