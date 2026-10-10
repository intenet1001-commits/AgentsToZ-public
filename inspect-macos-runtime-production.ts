#!/usr/bin/env bun

import { inspectMacOSRuntimeProductionSigningCanary } from './src/macOSRuntimeProductionCanary';
import { inspectMacOSRuntimeProductionIdentity } from './src/macOSRuntimeProductionIdentity';

const identity = await inspectMacOSRuntimeProductionIdentity();
const canary = await inspectMacOSRuntimeProductionSigningCanary();

process.stdout.write(`${JSON.stringify(Object.freeze({
  schemaVersion: 1,
  kind: 'macos-runtime-production-build-preflight',
  identity,
  canary,
  authoritative: false,
  reusable: false,
  ready: false,
}))}\n`);

if (identity.result !== 'snapshot-verified' || canary.result !== 'snapshot-verified') {
  process.exitCode = 2;
}
