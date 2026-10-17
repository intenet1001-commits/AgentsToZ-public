import type { BuildInfo } from '../build-info';
import { REMOTE_CONTROL_PROTOCOL_VERSION } from './remoteControlProtocol';
import { REMOTE_CONTROL_TASK_TRANSPORT_VERSION } from './remoteControlTaskProtocol';

export interface ReleaseMetadata {
  schemaVersion: 1;
  product: 'AgentsToZ';
  surface: 'web-portal';
  build: BuildInfo;
  protocols: {
    remoteControl: typeof REMOTE_CONTROL_PROTOCOL_VERSION;
    taskTransport: typeof REMOTE_CONTROL_TASK_TRANSPORT_VERSION;
  };
  compatibility: {
    minimumIOS: '17.0';
    protocolPolicy: 'exact';
  };
}

export function createReleaseMetadata(build: BuildInfo): ReleaseMetadata {
  return {
    schemaVersion: 1,
    product: 'AgentsToZ',
    surface: 'web-portal',
    build,
    protocols: {
      remoteControl: REMOTE_CONTROL_PROTOCOL_VERSION,
      taskTransport: REMOTE_CONTROL_TASK_TRANSPORT_VERSION,
    },
    compatibility: { minimumIOS: '17.0', protocolPolicy: 'exact' },
  };
}
