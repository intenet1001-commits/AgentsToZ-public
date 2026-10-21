import { writeFileSync } from 'node:fs';

const [readyPath, termPath] = process.argv.slice(2);
if (!readyPath || !termPath) process.exit(64);

process.on('SIGTERM', () => {
  // Deliberately remain alive so the production guard must escalate to the
  // task-group SIGKILL path exercised by the vertical runtime test.
  writeFileSync(termPath, String(process.pid), { mode: 0o600 });
});
writeFileSync(readyPath, String(process.pid), { mode: 0o600 });
setInterval(() => {}, 1_000);
