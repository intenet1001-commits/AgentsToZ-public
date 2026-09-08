import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { remoteControlActionLabel } from '../src/RemoteControlProjectCard';
import { remoteControlExternalLaunchRoute } from '../src/remoteControlExternalLaunchRoute';

describe('remote-control external launch route matrix', () => {
  test('Hermes app and Orca actions resolve to different fixed destinations', () => {
    expect(remoteControlExternalLaunchRoute('app.hermes')).toEqual({
      surface: 'desktop-app', endpoint: '/api/open-code-app', agent: 'hermes',
    });
    expect(remoteControlExternalLaunchRoute('agent.hermes')).toEqual({
      surface: 'orca-agent', endpoint: '/api/open-orca-agent', agent: 'hermes',
    });
    expect(remoteControlActionLabel('app.hermes')).toBe('최근 Hermes 대화 열기 요청');
    expect(remoteControlActionLabel('agent.hermes')).toBe('Orca · Hermes');
  });

  test('every external action has an explicit non-fallthrough route', () => {
    expect(remoteControlExternalLaunchRoute('agent.claude')).toMatchObject({ surface: 'orca-agent', agent: 'claude' });
    expect(remoteControlExternalLaunchRoute('agent.codex')).toMatchObject({ surface: 'orca-agent', agent: 'codex' });
    expect(remoteControlExternalLaunchRoute('agent.agy')).toMatchObject({ surface: 'orca-agent', agent: 'agy' });
    expect(remoteControlExternalLaunchRoute('app.codex')).toMatchObject({ surface: 'desktop-app', agent: 'codex' });
    expect(remoteControlExternalLaunchRoute('app.claude')).toMatchObject({ surface: 'orca-agent', agent: 'claude' });
    expect(remoteControlExternalLaunchRoute('folder.open')).toBeNull();
  });

  test('the shared LAN/Internet executor consumes the route matrix and logs the resolved target', () => {
    const source = readFileSync(new URL('../api-server.ts', import.meta.url), 'utf8');
    expect(source).toContain('const externalLaunchRoute = remoteControlExternalLaunchRoute(action);');
    expect(source).toContain('target=${externalLaunchRoute.surface}:${externalLaunchRoute.agent}');
    expect(source).not.toContain("action.startsWith('agent.') || action === 'app.claude'");
    expect(source).not.toContain("body = { agent: action.slice('app.'.length), folderPath: workingPath }");
  });
});
