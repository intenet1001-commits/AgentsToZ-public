#!/usr/bin/env bun
import { executeMacOSDirectDistribution } from './src/macOSDirectDistributionPipeline';

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--help') {
  console.log('bun build-macos-direct-distribution.ts --profile PROFILE [--keychain /absolute/path]\nBuilds, Developer ID signs, notarizes and staples an arm64 DMG. It does not install or publish the DMG.');
  process.exit(0);
}

try {
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    if (!flag || !['--profile', '--keychain'].includes(flag) || !value || flags.has(flag)) {
      throw new Error('Use --profile PROFILE and optionally --keychain /absolute/path.');
    }
    flags.set(flag, value);
  }
  const profile = flags.get('--profile');
  if (!profile) throw new Error('Use --profile PROFILE and optionally --keychain /absolute/path.');
  const receipt = await executeMacOSDirectDistribution({ profile, keychain: flags.get('--keychain') });
  console.log(JSON.stringify(receipt, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Mac direct distribution failed');
  process.exit(2);
}
