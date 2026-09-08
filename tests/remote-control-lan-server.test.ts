import { describe, expect, test } from 'bun:test';
import {
  RemoteControlLanServer,
  isAllowedRemoteControlLanRoute,
  isPrivateRemoteControlIpv4,
  remoteControlLanRequestAllowed,
} from '../src/remoteControlLanServer';
import type { RemoteControlGateway } from '../src/remoteControlCore';

const gateway: RemoteControlGateway = {
  listRegisteredProjects: () => [],
  executeRegisteredProjectAction: () => undefined,
};

describe('QR remote-control LAN listener boundary', () => {
  test('accepts only one explicitly selected RFC1918 IPv4 address', () => {
    for (const address of ['10.0.0.1', '10.255.255.254', '172.16.0.1', '172.31.255.254', '192.168.0.10']) {
      expect(isPrivateRemoteControlIpv4(address)).toBe(true);
    }
    for (const address of [
      '0.0.0.0', '127.0.0.1', '169.254.1.2', '172.15.0.1', '172.32.0.1',
      '192.0.2.1', '8.8.8.8', '192.168.001.2', '::1', 'fd00::1', '', ' 192.168.1.2',
    ]) {
      expect(isPrivateRemoteControlIpv4(address)).toBe(false);
    }
    expect(() => new RemoteControlLanServer({ bindAddress: '0.0.0.0', hostName: 'Mac', gateway })).toThrow('RFC1918');
    expect(() => new RemoteControlLanServer({ bindAddress: '127.0.0.1', hostName: 'Mac', gateway })).toThrow('RFC1918');
  });

  test('remains off after construction and does not create a listener until start', () => {
    const server = new RemoteControlLanServer({
      bindAddress: '192.168.10.20',
      hostName: 'Mac',
      gateway,
    });
    expect(server.status()).toEqual({ enabled: false, listener: null, pairing: null, sessions: [] });
  });

  test('has an exact static/health/WebSocket route allowlist under /remote/', () => {
    for (const path of [
      '/remote/',
      '/remote/index.html',
      '/remote/app.js',
      '/remote/styles.css',
      '/remote/manifest.webmanifest',
      '/remote/icon.svg',
      '/remote/health',
      '/remote/ws',
    ]) expect(isAllowedRemoteControlLanRoute(path)).toBe(true);

    for (const path of [
      '/', '/api/ports', '/api/execute-command', '/api/install-app', '/api/what-i-said/feed',
      '/remote', '/remote/api', '/remote/../api/ports', '/remote/sw.js', '/favicon.ico',
    ]) expect(isAllowedRemoteControlLanRoute(path)).toBe(false);
  });

  test('requires exact Host and same-origin WebSocket and refuses query/method/CORS expansion', () => {
    const base = {
      method: 'GET',
      pathname: '/remote/',
      search: '',
      host: '192.168.10.20:43123',
      origin: null,
      expectedHost: '192.168.10.20:43123',
      expectedOrigin: 'http://192.168.10.20:43123',
      websocket: false,
    };
    expect(remoteControlLanRequestAllowed(base)).toBe(true);
    expect(remoteControlLanRequestAllowed({ ...base, origin: base.expectedOrigin })).toBe(true);
    expect(remoteControlLanRequestAllowed({ ...base, method: 'POST' })).toBe(false);
    expect(remoteControlLanRequestAllowed({ ...base, search: '?next=/api/ports' })).toBe(false);
    expect(remoteControlLanRequestAllowed({ ...base, host: 'evil.example' })).toBe(false);
    expect(remoteControlLanRequestAllowed({ ...base, origin: 'https://evil.example' })).toBe(false);

    const websocket = { ...base, pathname: '/remote/ws', websocket: true, origin: base.expectedOrigin };
    expect(remoteControlLanRequestAllowed(websocket)).toBe(true);
    expect(remoteControlLanRequestAllowed({ ...websocket, origin: null })).toBe(false);
    expect(remoteControlLanRequestAllowed({ ...websocket, origin: 'null' })).toBe(false);
    expect(remoteControlLanRequestAllowed({ ...websocket, origin: 'http://192.168.10.21:43123' })).toBe(false);
    expect(remoteControlLanRequestAllowed({ ...base, pathname: '/remote/ws' })).toBe(false);
  });

  test('rejects privileged and accidental ports while allowing OS-assigned port zero', () => {
    expect(() => new RemoteControlLanServer({ bindAddress: '192.168.1.4', hostName: 'Mac', gateway, port: 80 })).toThrow('port');
    expect(() => new RemoteControlLanServer({ bindAddress: '192.168.1.4', hostName: 'Mac', gateway, port: 65_536 })).toThrow('port');
    expect(new RemoteControlLanServer({ bindAddress: '192.168.1.4', hostName: 'Mac', gateway, port: 0 }).status().enabled).toBe(false);
  });
});
