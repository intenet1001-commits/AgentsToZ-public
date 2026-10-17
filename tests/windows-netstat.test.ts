import { describe, expect, test } from 'bun:test';
import {
  parseWindowsNetstatListeners,
  windowsListenerPidsForPort,
  windowsListeningPorts,
} from '../src/windowsNetstat';

const localizedNetstat = `
  Proto  Lokale Adresse      Remoteadresse      Status        PID
  TCP    127.0.0.1:3001      0.0.0.0:0          ABHÖREN       101
  TCP    [::1]:9000          [::]:0             ÉCOUTE        202
  TCP    127.0.0.1:3001      127.0.0.1:52000    HERGESTELLT   303
  TCP    127.0.0.1:4000      0.0.0.0:0          BOUND         404
  UDP    0.0.0.0:5000        *:*                               505
`;

describe('localized Windows netstat listeners', () => {
  test('uses the wildcard foreign endpoint instead of an English state token', () => {
    expect(parseWindowsNetstatListeners(localizedNetstat)).toEqual([
      { port: 3001, pid: 101 },
      { port: 9000, pid: 202 },
    ]);
    expect(windowsListenerPidsForPort(localizedNetstat, 3001)).toEqual(['101']);
    expect([...windowsListeningPorts(localizedNetstat)]).toEqual([3001, 9000]);
  });
});
