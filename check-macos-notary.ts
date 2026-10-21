import { checkMacOSNotary } from './src/macOSNotaryPreflight';

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--help') {
  console.log('bun check-macos-notary.ts --profile PROFILE [--keychain /absolute/path]\nRead-only credential preflight. Never prompts for or changes a password.');
} else {
  try {
    if (process.platform !== 'darwin') throw new Error('This check requires macOS.');
    const flags = new Map<string, string>();
    for (let i = 0; i < args.length; i += 2) {
      const flag = args[i]; const value = args[i + 1];
      if (!flag || !['--profile', '--keychain'].includes(flag) || !value || flags.has(flag)) {
        throw new Error('Use --profile PROFILE and optionally --keychain /absolute/path.');
      }
      flags.set(flag, value);
    }
    const result = checkMacOSNotary({ profile: flags.get('--profile') ?? '', keychain: flags.get('--keychain') });
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.ready ? 0 : 2;
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Notary preflight failed.');
    process.exitCode = 1;
  }
}
