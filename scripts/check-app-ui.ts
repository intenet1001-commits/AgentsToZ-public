#!/usr/bin/env bun
/**
 * Builds the desktop web bundle into a throwaway directory and runs the
 * real-app UI regressions that need a built bundle (every /api call is mocked;
 * the installed app, its data and remote services are never touched).
 * Used by the tester scenario project.app-ui-e2e.
 */
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const dist = mkdtempSync(join(tmpdir(), 'agentstoz-app-ui-'));
const run = (argv: string[]) => {
  const result = Bun.spawnSync(argv, {stdout: 'inherit', stderr: 'inherit'});
  if (result.exitCode !== 0) throw new Error(`${argv.join(' ')} exited ${result.exitCode}`);
};
try {
  run(['./node_modules/.bin/vite', 'build', '--outDir', dist, '--emptyOutDir', '--logLevel', 'warn']);
  run(['bun', 'tests/onboarding-first-project-app-ui.mjs', dist]);
  run(['bun', 'tests/projects-tab-ui.e2e.mjs', dist]);
} finally {
  rmSync(dist, {recursive: true, force: true});
}
