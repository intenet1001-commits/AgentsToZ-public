// Keep the original native control contracts and the integrated Workroom contracts
// in one bounded maintainer check; a failed child stops the combined check.
import {readdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const commands = [
  [process.execPath, 'test', ...(await readdir(new URL('.',import.meta.url))).filter(name=>/^workroom-browser.*\.test\.ts$/.test(name)).sort().map(name=>'./tests/'+name)],
];
if (process.platform === 'darwin') commands.push(['python3', 'experiments/owned-browser-native/verify.py', '--contracts-only']);
else console.log('Original macOS native contracts: not applicable on this platform; Workroom host contracts still run.');
for (const argv of commands) {
  const child = Bun.spawn(argv, {cwd: root, stdin: 'ignore', stdout: 'inherit', stderr: 'inherit'});
  const code = await child.exited;
  if (code !== 0) process.exit(code);
}
