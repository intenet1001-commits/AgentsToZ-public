import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createBuildInfo } from '../build-info';

const PORTAL = readFileSync(new URL('../src/remote-control-portal-main.tsx', import.meta.url), 'utf8');
const PORTAL_CSS = readFileSync(new URL('../src/remote-control-portal.css', import.meta.url), 'utf8');

/**
 * "Is the deploy actually out?" was unanswerable from the screen.
 *
 * The portal ships to Vercel separately from the Mac app, so a phone can sit on
 * a cached bundle while the repository is several commits ahead — and nothing
 * on the page said which build it was. Printing the build number with the
 * source commit makes that a glance instead of a bisect.
 */
describe('portal build stamp', () => {
  test('createBuildInfo takes the commit Vercel exposes, not only the desktop env', () => {
    const info = createBuildInfo({
      command: 'build',
      tauriVersionPolicy: 'if-present',
      env: { VERCEL_GIT_COMMIT_SHA: 'a'.repeat(40) },
    });
    expect(info.sourceCommit).toBe('a'.repeat(40));
  });

  test('the desktop release SHA still wins when both are present', () => {
    const info = createBuildInfo({
      command: 'build',
      tauriVersionPolicy: 'if-present',
      env: {
        AGENTSTOZ_RELEASE_SOURCE_SHA: 'b'.repeat(40),
        VERCEL_GIT_COMMIT_SHA: 'a'.repeat(40),
      },
    });
    expect(info.sourceCommit).toBe('b'.repeat(40));
  });

  test('a malformed commit is rejected rather than displayed', () => {
    const info = createBuildInfo({
      command: 'build',
      tauriVersionPolicy: 'if-present',
      env: { VERCEL_GIT_COMMIT_SHA: 'not-a-sha' },
    });
    expect(info.sourceCommit).toBe('');
  });

  test('the remote screen renders the build number and short commit', () => {
    // The stamp reads the Vite-injected constant through src/buildInfo.ts
    // rather than touching __BUILD_INFO__ directly, so unit tests and non-Vite
    // tooling get the safe fallback instead of a ReferenceError.
    expect(PORTAL).toContain("from './buildInfo'");
    expect(PORTAL).toContain('BUILD_INFO.buildNumber');
    expect(PORTAL).toContain('BUILD_INFO.sourceCommit');
    expect(PORTAL).toContain('remote-build-stamp');
    expect(PORTAL_CSS).toContain('.remote-build-stamp');
  });
});

/**
 * The reload control only existed while disconnected, which is exactly when it
 * is least needed: a phone holding a stale bundle usually connects fine and
 * simply lacks the newest UI. It has to be reachable while online too.
 */
describe('portal reload control', () => {
  test('reloading is available regardless of connection state', () => {
    // Previously gated behind `status.state !== 'online'`.
    expect(PORTAL).not.toContain("{status.state !== 'online' && (\n        <button type=\"button\" className=\"remote-reload\"");
    expect(PORTAL).toContain('data-testid="remote-reload-app"');
  });

  test('the reload still clears caches so a stale bundle cannot survive it', () => {
    expect(PORTAL).toContain('caches.keys()');
    expect(PORTAL).toContain('window.location.reload()');
  });
});
