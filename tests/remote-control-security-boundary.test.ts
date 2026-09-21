import { describe, expect, test } from 'bun:test';
import {
  REMOTE_CONTROL_PROTOCOL_VERSION,
  RemoteControlCore,
  type RemoteControlActionRequest,
  type RemoteControlGateway,
} from '../src/remoteControlCore';
import type { RemoteControlRegisteredTarget } from '../src/remoteControlProcessGateway';

const INTERNAL_MARKERS = {
  internalId: 'real-project-id-secret',
  folderPath: '/Users/private/secret-project',
  command: 'bun run secret-command --token hidden',
  pid: 98_765,
  deviceId: 'device-private-identity',
  gitRemote: 'git@github.com:private/secret.git',
  memoryId: 'memory-private-identity',
  whatISaid: 'what-i-said-private-prompt',
} as const;

function sequentialRandomBytes(): (length: number) => Uint8Array {
  let value = 1;
  return (length) => {
    const bytes = new Uint8Array(length);
    bytes.fill(value);
    value += 1;
    return bytes;
  };
}

function pairingToken(pairingUrl: string): string {
  const token = new URLSearchParams(new URL(pairingUrl).hash.slice(1)).get('pair');
  if (!token) throw new Error('pairing URL did not contain a fragment token');
  return token;
}

function assertPublicProjectShape(value: unknown): void {
  expect(value).toBeObject();
  expect(Object.keys(value as Record<string, unknown>).sort()).toEqual([
    'actions',
    'alias',
    'branch',
    'controlId',
    'kind',
    'name',
    'port',
    'status',
    'workspaceRoot',
  ]);
}

function assertNoInternalMarkers(value: unknown): void {
  const serialized = JSON.stringify(value);
  for (const marker of Object.values(INTERNAL_MARKERS)) {
    expect(serialized).not.toContain(String(marker));
  }
  for (const forbiddenKey of [
    'internalId',
    'folderPath',
    'command',
    'pid',
    'deviceId',
    'gitRemote',
    'memoryId',
    'whatISaid',
  ]) {
    expect(serialized).not.toContain(`"${forbiddenKey}"`);
  }
}

describe('QR remote-control LAN serialization boundary', () => {
  test('serializes only opaque control IDs and the explicit public project DTO', async () => {
    const target = {
      internalId: INTERNAL_MARKERS.internalId,
      name: 'Public project name',
      port: 43_210,
      kind: 'worktree',
      folderPath: INTERNAL_MARKERS.folderPath,
      command: INTERNAL_MARKERS.command,
      status: 'stopped',
      actions: ['start'],
      pid: INTERNAL_MARKERS.pid,
      deviceId: INTERNAL_MARKERS.deviceId,
      gitRemote: INTERNAL_MARKERS.gitRemote,
      memoryId: INTERNAL_MARKERS.memoryId,
      whatISaid: INTERNAL_MARKERS.whatISaid,
    } as RemoteControlRegisteredTarget & {
      pid: number;
      deviceId: string;
      gitRemote: string;
      memoryId: string;
      whatISaid: string;
    };
    const executed: RemoteControlRegisteredTarget[] = [];
    const gateway: RemoteControlGateway = {
      listRegisteredProjects: () => [target],
      executeRegisteredProjectAction: ({ target: current }) => {
        executed.push(current);
      },
    };
    const core = new RemoteControlCore(gateway, {
      hostName: 'Test Mac',
      randomBytes: sequentialRandomBytes(),
    });
    const pairing = core.enable('http://192.168.50.8:43210');
    const ready = await core.pair(pairingToken(pairing.pairingUrl));

    expect(ready.projects).toHaveLength(1);
    assertPublicProjectShape(ready.projects[0]);
    expect(ready.projects[0]!.controlId).not.toBe(INTERNAL_MARKERS.internalId);
    assertNoInternalMarkers(ready);

    const listRequest: RemoteControlActionRequest = {
      type: 'action.request',
      protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION,
      sessionToken: ready.sessionToken,
      actionId: 'list-1',
      action: 'projects.list',
    };
    const listed = await core.perform(listRequest);
    expect(listed.ok).toBe(true);
    if (listed.ok && 'projects' in listed) assertPublicProjectShape(listed.projects[0]);
    assertNoInternalMarkers(listed);

    const status = await core.perform({
      type: 'action.request',
      protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION,
      sessionToken: ready.sessionToken,
      actionId: 'status-1',
      action: 'project.status',
      controlId: ready.projects[0]!.controlId,
    });
    expect(status.ok).toBe(true);
    if (status.ok && 'project' in status) assertPublicProjectShape(status.project);
    assertNoInternalMarkers(status);

    const started = await core.perform({
      type: 'action.request',
      protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION,
      sessionToken: ready.sessionToken,
      actionId: 'start-1',
      action: 'start',
      controlId: ready.projects[0]!.controlId,
      remoteConfirmed: true,
    });
    expect(started.ok).toBe(true);
    expect(executed).toHaveLength(1);
    expect(executed[0]!.internalId).toBe(INTERNAL_MARKERS.internalId);
    if (started.ok && 'project' in started) assertPublicProjectShape(started.project);
    assertNoInternalMarkers(started);
  });
});
