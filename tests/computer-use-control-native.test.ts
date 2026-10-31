import {expect, test} from 'bun:test';
import {join} from 'node:path';

// AgentsToZ Control's Swift core (XPC contract samples, owner generation, disconnect-owner, one-use open-grant, per-process
// change order) compiled alone with swiftc and run. It lives inside native-workflow-foundations because the manifest is at
// its check limit, as AgentsToZ Screen's Swift core runs inside ios-core.
test.skipIf(process.platform !== 'darwin')('AgentsToZ Control Swift core checks and bundle templates pass', () => {
  const result = Bun.spawnSync(['bun', join(import.meta.dir, '..', 'scripts', 'check-computer-use-control.ts')], {stdout:'pipe', stderr:'pipe'});
  const out = result.stdout.toString();
  expect(result.exitCode, out + result.stderr.toString()).toBe(0);
  const passed = /^(\d+)\/(\d+) computer-use control checks passed$/m.exec(out);
  expect(passed?.[1]).toBe(passed?.[2]);
  expect(Number(passed?.[1])).toBeGreaterThanOrEqual(17);
  expect(out).toContain('bundle templates: Info.plist, LaunchAgent and entitlements are valid property lists');
}, 240_000);
