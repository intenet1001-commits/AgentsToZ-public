import {describe, expect, test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {lane as modelLane} from '../scripts/emulator-e2e/screenViewerModelLane';
import {lane as boundaryLane} from '../scripts/emulator-e2e/screenBoundaryLane';
const root = resolve(import.meta.dir, '..');
const script = join(root, 'mobile/ios/scripts/check-ui.py');
function plan(...args: string[]) {
  const result = Bun.spawnSync(['/usr/bin/python3', '-I', script, ...args, '--plan'], {cwd: root, env: {PATH: '/usr/bin:/bin'}, stdout: 'pipe', stderr: 'pipe'});
  return {code: result.exitCode, data: result.exitCode === 0 ? JSON.parse(result.stdout.toString()) : null};
}
describe('screen registration boundaries', () => {
  test('boundary-only is one simulator test with no host or LAN, and rejects device and gesture modes', () => {
    const p = plan('--boundary-only');
    expect(p.code).toBe(0); expect(p.data.expected.passed).toBe(1); expect(p.data.expected.skipped).toBe(0);
    expect(p.data.lanJourney).toBe(false); expect(p.data.screenViewer).toBe(false);
    const commands = JSON.stringify(p.data.commands);
    expect(commands).toContain('test30MacControllerInviteIsRejectedByDeviceRegistration');
    expect(commands).not.toContain('lan-journey-host'); expect(commands).not.toContain('screenFixtureHost');
    expect(plan('--boundary-only', '--screen-gestures').code).not.toBe(0);
    expect(plan('--boundary-only', '--device', '00000000-0000000000000000').code).not.toBe(0);
    expect(plan('--boundary-only', '--lan-port', '45000').code).not.toBe(0);
  });
  test('only a simulator constructs a synthetic controller invitation and never invokes registration', () => {
    const source = readFileSync(join(root, 'mobile/ios/UITests/WorkspaceUITests.swift'), 'utf8');
    const start = source.indexOf('func test30MacControllerInviteIsRejectedByDeviceRegistration()');
    const end = source.indexOf('/// J1-LAN-APP', start);
    const body = source.slice(start, end);
    expect(body).toContain('#if targetEnvironment(simulator)'); expect(body).toContain('throw XCTSkip');
    expect(body).toContain('app.open(url)'); expect(body).toContain('Mac 컨트롤러 전용 QR');
    expect(body).not.toMatch(/\.tap\(|createDeviceKey|generateKey|attestKey/);
  });
  test('protected-key viewer model is blocked rather than falsely passing without a capability measurement', () => {
    expect(boundaryLane.id).toBe('j2-boundary'); expect(modelLane.id).toBe('j2-model');
    expect(modelLane.preconditions!({} as never).join(' ')).toContain('not been measured');
  });
});
