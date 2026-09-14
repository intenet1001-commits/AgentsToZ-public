#!/usr/bin/env bun
import { executeMacOSBaseAppPipeline } from './src/macOSBaseAppPipeline';
if (process.argv.length !== 2) {
  console.error('usage: bun build-macos-developer-id-base.ts');
  process.exit(64);
}
try {
  console.log(JSON.stringify(await executeMacOSBaseAppPipeline()));
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Developer ID base build failed');
  process.exit(2);
}
