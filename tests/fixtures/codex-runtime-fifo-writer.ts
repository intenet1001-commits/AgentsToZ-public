import { closeSync, openSync } from 'node:fs';

const fifoPath = process.argv[2];
if (!fifoPath) process.exit(64);

// If production hashing accidentally drops O_NONBLOCK, this delayed writer
// releases the test instead of hanging the entire suite forever.
await Bun.sleep(1_000);
const descriptor = openSync(fifoPath, 'w');
closeSync(descriptor);
