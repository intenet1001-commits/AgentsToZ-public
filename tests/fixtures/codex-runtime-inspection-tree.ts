import { spawn } from 'node:child_process';

const mode = process.argv[2];

if (mode === 'descendant') {
  process.on('SIGTERM', () => {
    // The inspection supervisor must escalate to the whole process group.
  });
  setInterval(() => undefined, 1_000);
} else if (mode === 'exit-with-descendant') {
  const descendant = spawn(process.execPath, [import.meta.path, 'descendant'], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  process.stdout.write(`descendant=${descendant.pid ?? 0}\n`, () => process.exit(0));
} else if (mode === 'hang-with-descendant') {
  const descendant = spawn(process.execPath, [import.meta.path, 'descendant'], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  process.on('SIGTERM', () => {
    // Ignore graceful termination to exercise SIGKILL escalation.
  });
  process.stdout.write(`parent=${process.pid} descendant=${descendant.pid ?? 0}\n`);
  setInterval(() => undefined, 1_000);
} else if (mode === 'delayed-success') {
  setTimeout(() => {
    process.stdout.write('late success\n', () => process.exit(0));
  }, 50);
} else {
  process.exitCode = 64;
}
