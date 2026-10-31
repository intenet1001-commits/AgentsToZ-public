import React, { useMemo } from 'react';
import { RemoteMetaCommonMemoryCloudHint } from './RemoteMetaCommonMemoryCloudHint';
import { createMetaMemoryRemoteRequester } from './metaCommonMemoryRemoteClient';
import type { MobileWorkspaceRequest, MobileWorkspaceResult } from './mobileWorkspaceProtocol';
import { phoneOfflineNotice } from './phoneNetwork';
import { REMOTE_FEATURE_CHECKING } from './remoteFeatureAvailability';
export function RemoteMetaCommonMemoryPanel({ visible, available, checking = false, online, phoneOnline = true, hostName, transport, rpcV2 = false }: {
  visible: boolean; available: boolean; /** Features not confirmed yet: not an old Mac. */ checking?: boolean; online: boolean; /** The phone's own network (see RemoteCommonMemoryPanel). */ phoneOnline?: boolean; hostName?: string; rpcV2?: boolean;
  transport: (request: MobileWorkspaceRequest) => Promise<MobileWorkspaceResult>;
}) {
  const request = useMemo(() => createMetaMemoryRemoteRequester(transport, 'meta-memory', { rpcV2 }), [transport, rpcV2]);
  return <section className="meta-common-memory-mobile" hidden={!visible}>
    {!online && <p role="status">{phoneOnline ? '관리할 Mac에 연결하면 이전 로컬 기억을 조회하고 변경할 수 있습니다. 저장된 내용은 해당 Mac에 보존됩니다.' : phoneOfflineNotice()}</p>}
    {online && !available && <p role="status">{checking ? REMOTE_FEATURE_CHECKING : '연결한 Mac 앱을 업데이트하면 공통기억을 관리할 수 있습니다.'}</p>}
    {available && <div hidden={!online}><RemoteMetaCommonMemoryCloudHint visible={visible && online} request={request} remote hostName={hostName} /></div>}
  </section>;
}
