# emulator-stage1-fix · fix2:wp3

(agent final report, verbatim)

English translation: "So the idea is that once it's connected, you can just keep using it comfortably, right?"

Both open findings are fixed on `emu/wp3`, now at `beb1530e`. I merged the current `emu/wp0-1` (`5c8d645d`, which includes `daeca98e`), and the j1-pty lane passed a real run under the new sandbox profile. While testing I found that the profile does not actually restrict which en0 ports the sandboxed script can open; WP0-1 has to fix that, and details are at the end.

**Commits**
- `387937ee`: merge of `emu/wp0-1` into `emu/wp3`. It merged cleanly but did not typecheck: the reviewer's 3 TS errors came back (`workroomPty.ts:117,120` and the test at `:179`).
- `4de461ef`: the fixes.
- `beb1530e`: comments and docs only, correcting what they say the sandbox enforces (see the end).

**Finding 4 (`check-workroom.ts:48-49`)**
- A new `claimEvidenceDir()` in `checkWorkroomSupport.ts` empties the folder and writes the verdict. If the folder holds files the script does not own, it leaves them but still overwrites an existing `run-status.json` with `failed`. The usage-error path and the valid-arguments path now both use it.
- `bestEffortEvidenceDir` now returns the folder given with `--evidence-dir` even when `--compile-only` is present. So `--compile-only --evidence-dir <dir>` also leaves `failed` in that folder.
- I reproduced the reviewer's case (`run-status.json` saying passed plus `notes.txt`): the old script left `passed`; the new one leaves `failed` and keeps `notes.txt`. The `--compile-only` case behaves the same way.

**Merge blocker (`workroomPty.ts`)**
- **`sandbox.ts`:** `lanInbound` now accepts `{port, extraPorts?}`. Each port is checked (valid, not 3001/52741/4723, no repeats), and the single-port form is unchanged. `lanListenerViolations` takes the same shape, and `listeningSockets` accepts several pids.
- **`check-workroom.ts`:** new options `--lan-address <IPv4> --lan-ports <server>,<foreign>,<redirect>`. They must be given together and are refused with `--compile-only`. The address must be one of this Mac's private IPv4 addresses, and the simulator run refuses to start without them. The LAN server, `forbidden` and `redirector` bind on those ports; `--device` still uses port 0.
  - I kept three listeners instead of moving two to loopback. The redirect QR has to be a private LAN address, because `LANPairing` rejects anything else. And a foreign origin on the same host but a different port is what catches a check that compares only the host.
- **`workroomPty.ts`:**
  - `reserveLanPorts(3)` picks three different free ports using loopback probes, so the orchestrator never opens a LAN listener itself.
  - The profile is built with `{port, extraPorts}`, and `sandboxedArgv` now gets the hash-checked profile object instead of a path.
  - While the script runs, `watchListeners` checks the script's whole process tree with ps and lsof every second. `listenerProblems` fails the run if anything listens off loopback other than the en0 address on those three ports, and fails a pass that never showed all three.
- **Minor items from the review:** `PLAN.md:248` now lists `bun scripts/emulator-e2e.ts j1-pty`. `HARNESS_SCAN_PATHS` now also covers `checkWorkroomSupport.ts`, `workroomFixtureCompile.ts` and `WorkroomProbe.swift`. `README.md` and `NATIVE-EXECUTION.md` are updated.
- **Tests:** `tests/check-workroom-support.test.ts` has new cases for:
  - parsing the LAN options;
  - `claimEvidenceDir`;
  - both real-script reproductions;
  - the three-port profile, port reservation, the process tree, listener problems and the watcher;
  - the scan paths.

**What I ran**
- `tsc --noEmit` on the root and on `mobile/ios/tsconfig.json`: no errors.
- The six affected test files: 115 pass, 0 fail.
- `bun run test`: 9891 pass, 12 skip, 0 fail, across 1112 files.
- **Real j1-pty lane**, run from a copy under `/Users/cs-work/agentstoz-emulator/wp3-lanports-20261101-140944/wt` (`git archive` plus a real `bun install`), run `20261101-050954-5c71dc`:
  - Exit 0; preflight passed and the lane passed.
  - Ports 58416, 58417 and 58418 were all seen on `192.168.219.138` (92 samples), with no listener problems.
  - The script confirmed it was sandboxed and that a write into the worktree was refused (EPERM).
  - 39 probe checks; 0 requests reached the foreign origin; 0 project-change attempts; no `#pair=` token leaks.
  - The owned simulator was deleted, the 16 existing simulators were unchanged, and no new Simulator.app started.
  - Timing: compile 18 s, boot 26 s, journey 31 s, total 91 s.
- **Not run:** `cargo test` (only TypeScript and docs changed), `test:maintainer`, and the project-tester `ensure` call to 127.0.0.1:3001 (the safety rules forbid connecting to that port).
- **Cleanup:** the copy and my probe scratch are removed. The harness's shared lock file `/Users/cs-work/agentstoz-emulator/sim.lock` (empty, released) was created by this run and left in place because other lanes use it.

**For WP0-1: the sandbox does not limit LAN ports**
I measured this on Darwin 25.5. Under WP1's host profile, a sandboxed process could listen on the en0 address on any port, including port 0 and a port the profile never declared, and a client on the same Mac could connect to it. This held whether or not LAN inbound was declared at all. Removing the two `(allow network-bind|network-inbound (local ip "localhost:*"))` lines made both en0 and loopback binds fail. So `local ip "localhost:*"` also matches the en0 address.

That means:
- The reviewer's expectation that "those binds should be denied" does not hold on this Mac.
- In j1-pty, the lsof listener check is what actually keeps the script to the three ports. `beb1530e` changes the comments and docs to say so.
- WP0-1's claim that the profile opens LAN inbound only on declared ports is not enforced by the OS. This needs a fix on `emu/wp0-1`; I did not change that behaviour.

Your question isn't something this fix task covered, so I can't answer it from what I did here.

Main files, all under `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_35f16659-79d-7/`:
- `mobile/ios/scripts/check-workroom.ts`
- `mobile/ios/scripts/checkWorkroomSupport.ts`
- `scripts/emulator-e2e/workroomPty.ts`
- `scripts/emulator-e2e/sandbox.ts`
- `scripts/emulator-e2e/preflight.ts`
- `tests/check-workroom-support.test.ts`
