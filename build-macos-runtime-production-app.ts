#!/usr/bin/env bun

import { executeMacOSRuntimeProductionAppPipeline } from './src/macOSRuntimeProductionAppPipeline';

if (process.argv.length !== 2) {
  console.error('usage: bun build-macos-runtime-production-app.ts');
  process.exit(64);
}

try {
  const receipt = await executeMacOSRuntimeProductionAppPipeline();
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
} catch (cause) {
  console.error(cause instanceof Error
    ? cause.message
    : 'macOS runtime production app pipeline failed');
  process.exit(2);
}
