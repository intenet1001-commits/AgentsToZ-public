#!/usr/bin/env bun

import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { parseMacOSRuntimeBrokerFixtureProofLine } from './src/macOSRuntimeBrokerFixture';

const iterationCount = 100;
const fixtureName = 'com.intenet.agentstozbycs.runtime-broker-fixture';
const artifactRoot = realpathSync(join(
  import.meta.dir,
  'src-tauri',
  'native',
  'macos-runtime',
  '.artifacts',
));
const fixturePath = join(artifactRoot, 'bin', fixtureName);
const manifestPath = join(artifactRoot, 'manifest.json');

if (process.argv.length !== 2) {
  console.error('usage: bun test-macos-runtime-native-repeat.ts');
  process.exit(64);
}

const fixtureStat = lstatSync(fixturePath);
const manifestStat = lstatSync(manifestPath);
if (!fixtureStat.isFile()
  || fixtureStat.isSymbolicLink()
  || fixtureStat.nlink !== 1
  || (fixtureStat.mode & 0o111) === 0
  || !manifestStat.isFile()
  || manifestStat.isSymbolicLink()
  || manifestStat.nlink !== 1
  || realpathSync(fixturePath) !== fixturePath
  || realpathSync(manifestPath) !== manifestPath) {
  throw new Error('macOS runtime repeat fixture artifact rejected');
}
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
  schemaVersion?: unknown;
  kind?: unknown;
  mode?: unknown;
  brokerFixture?: { name?: unknown; sha256?: unknown };
  authoritative?: unknown;
  reusable?: unknown;
  ready?: unknown;
};
const digest = createHash('sha256').update(readFileSync(fixturePath)).digest('hex');
if (manifest.schemaVersion !== 1
  || manifest.kind !== 'macos-runtime-native-development-build'
  || manifest.mode !== 'development-ad-hoc'
  || manifest.brokerFixture?.name !== fixtureName
  || manifest.brokerFixture.sha256 !== digest
  || manifest.authoritative !== false
  || manifest.reusable !== false
  || manifest.ready !== false) {
  throw new Error('macOS runtime repeat fixture manifest rejected');
}

const startedAt = Date.now();
for (let iteration = 0; iteration < iterationCount; iteration += 1) {
  const execution = Bun.spawnSync([fixturePath, '--harmless-self-test-v1'], {
    cwd: '/',
    env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 5_000,
  });
  if (execution.exitCode !== 0
    || execution.stdout.byteLength > 4_096
    || execution.stderr.byteLength !== 0) {
    throw new Error(`macOS runtime repeat fixture failed at iteration ${iteration + 1}`);
  }
  const proof = parseMacOSRuntimeBrokerFixtureProofLine(execution.stdout.toString());
  if (proof.result !== 'passed'
    || proof.serviceRegistered !== false
    || proof.accountCreated !== false
    || proof.containerInvoked !== false
    || proof.authoritative !== false
    || proof.reusable !== false
    || proof.ready !== false) {
    throw new Error(`macOS runtime repeat proof rejected at iteration ${iteration + 1}`);
  }
}

process.stdout.write(`${JSON.stringify(Object.freeze({
  schemaVersion: 1,
  kind: 'macos-runtime-harmless-repeat-fixture',
  iterations: iterationCount,
  result: 'passed',
  durationMs: Date.now() - startedAt,
  serviceRegistered: false,
  accountCreated: false,
  containerInvoked: false,
  authoritative: false,
  reusable: false,
  ready: false,
}))}\n`);
