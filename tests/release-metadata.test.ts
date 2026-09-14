import { expect, test } from 'bun:test';
import { createReleaseMetadata } from '../src/releaseMetadata';

test('web release metadata binds the build and exact remote protocols', () => {
  const build = {
    buildNumber: 448,
    version: '448.0.0',
    builtAt: '2026-09-12T00:00:00.000Z',
    mode: 'production' as const,
    sourceCommit: 'a'.repeat(40),
    sourcePublished: true,
  };
  const metadata = createReleaseMetadata(build);
  expect(metadata.build).toEqual(build);
  expect(metadata.protocols).toEqual({
    remoteControl: 'agentstoz-local-v7',
    taskTransport: 'agentstoz-local-v8',
  });
  expect(metadata.compatibility).toEqual({ minimumIOS: '17.0', protocolPolicy: 'exact' });
});
