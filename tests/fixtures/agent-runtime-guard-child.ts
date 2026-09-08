import { writeFileSync } from 'node:fs';

const pidFile = process.argv[2];
const grandchildSource = process.argv[3];
const outputLine = process.argv[4];
if (!pidFile || !grandchildSource) process.exit(64);
const grandchild = Bun.spawn([process.execPath, '--env-file=/dev/null', grandchildSource], {
  stdin: 'ignore',
  stdout: 'ignore',
  stderr: 'ignore',
  detached: false,
});
writeFileSync(pidFile, JSON.stringify({
  providerPid: process.pid,
  grandchildPid: grandchild.pid,
}), { mode: 0o600 });
if (outputLine) process.stdout.write(`${outputLine}\n`);
setInterval(() => {}, 1_000);
