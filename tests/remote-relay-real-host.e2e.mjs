// J1-RELAY-WEB (emulator harness WP5): the production portal bundle in Playwright WebKit (402x874, served at
// https://portal.test by a route) ↔ the https PGlite Supabase shim ↔ a sandboxed isolated source sidecar acting as the
// Mac. QR with `supabase`, email-code login, phone SAS == host SAS (Mac approval scripted through the fixture host's
// management API), project start/stop, workroom, resume after a host restart, a foreign-Supabase QR refused with zero
// claim RPCs, and the bundled-portal variant once. The lane itself lives in scripts/emulator-e2e/relayWebJourney.ts.
//
// This entry only runs the harness lane, so the preflight, sandbox, evidence and exit codes are the harness's own
// (pass 0 · fail 1 · usage 2 · blocked 3 · skipped 4 — blocked and skipped are not a pass). It runs under node or bun
// (sibling entries are started either way); the harness itself always runs under bun. Run it from a copy outside the
// registered workspace root — the preflight refuses a worktree inside it (scripts/emulator-e2e/preflight.ts), which is
// also why this lane is not in the check-maintainer-web workroom suite: the maintainer runs from the main checkout,
// inside the registered root (the lane's ~2 min would fit that suite's 900 s budget).
//   node tests/remote-relay-real-host.e2e.mjs [--keep-scratch]
// Evidence: mobile/ios/build/emulator-evidence/<runId>/index.json (+ relay-web/, supabase-shim/relay-web/).
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const flags = process.argv.slice(2).filter(arg => arg === '--keep-scratch');
// Under bun, process.execPath is bun itself; under node, bun comes from PATH (BUN overrides it).
const bun = process.versions.bun ? process.execPath : (process.env.BUN || 'bun');
const child = spawn(bun, ['--env-file=/dev/null', 'scripts/emulator-e2e.ts', 'j1-relay-web', ...flags], {
  cwd: root, stdio: ['ignore', 'inherit', 'inherit'],
});
const forward = signal => () => { try { child.kill(signal); } catch {} };
process.on('SIGINT', forward('SIGINT'));
process.on('SIGTERM', forward('SIGTERM'));
child.on('error', error => { process.stderr.write(`could not start bun (${bun}): ${error.message}\n`); process.exit(2); });
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
