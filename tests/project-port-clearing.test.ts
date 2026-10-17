import {describe, expect, test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const app = readFileSync(join(import.meta.dir, '..', 'src', 'App.tsx'), 'utf8');

// Clearing a project's port must store "no port", not the number 0.
//
// `0` is not a sentinel here: the server resolves a running process with
// `lsof -ti:<port>`, and `lsof -ti:0` matches unrelated system processes
// (identityservicesd, sharingd, RemotePairing...). A port-less project then
// reports isRunning=true forever, and 중지/강제 재실행 on that row would target
// whatever those PIDs happen to be. The create path already stores undefined;
// the edit path must agree.
describe('clearing a project port', () => {
  test('the edit path stores undefined, never 0', () => {
    expect(app).not.toContain('port: editPort ? parseInt(editPort) : 0');
    expect(app).toContain('port: editPort ? parseInt(editPort) : undefined');
  });

  test('no save path falls back to a numeric 0 port', () => {
    const zeroFallbacks = [...app.matchAll(/port:\s*[A-Za-z0-9_.]+\s*\?\s*parseInt\([^)]*\)\s*:\s*0\b/g)];
    expect(zeroFallbacks.map(m => m[0])).toEqual([]);
  });

  test('clearing the port also clears the stale running flag', () => {
    // The edit spreads `...original`, so a previously-true isRunning would survive
    // the removal of the very port that justified it and freeze the row as running.
    expect(app).toContain('...(editPort ? {} : { isRunning: false })');
  });
});
