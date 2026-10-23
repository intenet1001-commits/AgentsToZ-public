import React, { useMemo } from 'react';
import { RemoteMetaCommonMemoryCloudHint } from './RemoteMetaCommonMemoryCloudHint';
import { createMetaMemoryRemoteRequester } from './metaCommonMemoryRemoteClient';
import type { MobileWorkspaceRequest, MobileWorkspaceResult } from './mobileWorkspaceProtocol';
export function RemoteMetaCommonMemoryPanel({ visible, available, online, hostName, transport, rpcV2 = false }: {
  visible: boolean; available: boolean; online: boolean; hostName?: string; rpcV2?: boolean;
  transport: (request: MobileWorkspaceRequest) => Promise<MobileWorkspaceResult>;
}) {
  const request = useMemo(() => createMetaMemoryRemoteRequester(transport, 'meta-memory', { rpcV2 }), [transport, rpcV2]);
  return <section className="meta-common-memory-mobile" hidden={!visible}>
    {!online && <p role="status">관리할 Mac에 연결하면 공통 기억을 조회하고 변경할 수 있습니다. 저장된 내용은 해당 Mac에 보존됩니다.</p>}
    {online && !available && <p role="status">연결한 Mac 앱을 업데이트하면 공통기억을 관리할 수 있습니다.</p>}
    {available && <div hidden={!online}><RemoteMetaCommonMemoryCloudHint visible={visible && online} request={request} remote hostName={hostName} /></div>}
  </section>;
}
