# iPhone native + Web remote control release hardening plan

**Status:** ready for execution

**Created:** 2026-09-12

**Baseline source:** `e2135a12b1528b9c6c313463d3e085a743489244`

**Scope:** AgentsToZ Mac host, iPhone native app, LAN remote UI, Internet/Vercel remote UI, relay/E2EE, Workroom runtime, release evidence

## 1. Goal gate

### Goal statement

연결된 실제 iPhone과 운영 웹에서 AgentsToZ 원격제어가 빠르기 이전에 정확하고 복구 가능하게
작동하도록 만들고, 성능·안정성·보안·버전 일치가 재현 가능한 증거로 확인된 빌드만 배포한다.

### Success criteria

1. 현재 Git 커밋에 결속된 Mac host, Web production, iPhone build가 식별되고 지원 protocol 범위를
   서로 확인한다.
2. 실제 iPhone에서 LAN과 5G Internet 경로의 연결, 프로젝트 조회/생성, Workroom 시작/입력/출력,
   background/cold resume, revoke가 중복 실행·입력 유실·권한 확대 없이 통과한다.
3. 정해진 성능 예산과 장시간 안정성 시험을 통과하고, 실패 시 결과를 성공으로 표시하거나 자동
   재실행하지 않는다.
4. 자동화 결과, 실기기 결과, 운영 배포 결과가 분리된 release evidence와 rollback 절차가 남는다.

## 2. Current evidence and honest verdict

| Area | 2026-09-12 evidence | Verdict |
|---|---|---|
| Repository | local and `origin/main` are both `e2135a12...` | current source identified |
| Mac app | v448 built, installed and running | current Mac host installed |
| iOS core | `bun run test:ios`: 11 groups; real URLSession↔Bun pairing, one-use QR, session resume, redirect rejection and cancellation passed | automated contract passed |
| iPhone build | connected iPhone is an Xcode destination; current source signed device build succeeded | buildable, not runtime proof |
| Existing iPhone installs | production `0.1.0 (1)` and development `0.1.0 (5)` detected | versions are older/separate from Mac v448 |
| Physical fixture | isolated `com.intenet.agentstoz.workspacetest` install rejected by the free-profile three-app limit | physical E2E blocked, not passed |
| Web deployment | latest Vercel production deployment is `READY` and owns production aliases | deployed, exact source binding absent |
| Web performance | `tests/perf-measure.mjs` targets localhost and contains hard-coded historical bundle sizes | current production performance unproven |
| Internet native auth | build 5 fixed empty trailing-fragment handling; actual Google re-login→PKCE→SAS→work remains pending | unverified |

The product is therefore **not release-verified as one end-to-end system yet**. Existing tests are useful and
must stay green, but simulator/fixture/build/`READY` results cannot replace physical iPhone and production
workflow evidence.

## 3. Architecture decision

Use the existing SwiftUI/WKWebView client, Bun host, strict MCP/runtime boundaries and Vercel relay design.
Do not rewrite the transport in Python and do not relax QR, OAuth, grant, path or duplicate-request guards to
improve speed. First add traceable release identity and stage timing, then fix only measured failures.

Keep these authorities separate:

| Authority | Owner |
|---|---|
| Project/path/process execution | registered Mac host |
| LAN pairing and terminal grant | Mac LAN listener/session |
| Internet account, encrypted relay and SAS approval | portal + Mac host + controller session |
| Native lifecycle and system auth return | iPhone app |
| Conversation/project memory | canonical project root and its memory ID |
| Release identity | immutable source commit + surface build ID + protocol version |

## 4. Phase gates

### P0 — Freeze and identify every surface

- [ ] Record the clean Git commit used by Mac, Web and iOS.
- [ ] Generate a non-secret `release-meta.json` during Web and iOS builds with source commit, build number,
      remote protocol version, minimum compatible host/client version and build timestamp.
- [ ] Show the same information in a bounded diagnostics screen and return it from a read-only health path.
- [ ] Make Vercel deployment evidence include the source commit; a `READY` deployment without this binding is
      not releasable.
- [ ] Replace the checked-in iOS `0.1.0 (1)` default with an explicit build-number policy. Development,
      USB and TestFlight builds must never reuse an already installed/distributed build number.
- [ ] Capture source hashes for the Swift container, native core, mobile page, relay contract and Mac host.

**Gate P0:** a screenshot or API response from each surface identifies the same compatible release family.

### P1 — Restore a safe physical-device test lane

Two valid lanes are required:

1. **Upgrade lane:** build the next `com.intenet.agentstoz.mobile.dev` version and install over the existing
   development app. Verify that saved origin/session state migrates or is rejected with a clear re-pairing
   message. This lane does not consume another free-profile slot.
2. **Isolated clean-install lane:** use `com.intenet.agentstoz.workspacetest` and the existing fixture. Before
   this lane, the user chooses one currently installed free-profile development app to remove, or supplies a
   paid-team provisioning lane. Never delete an existing app automatically.

- [ ] Re-run signed device build from the frozen commit.
- [ ] Install and read back bundle ID, version, build number, signing identity class and launch state.
- [ ] Preserve the production app and its data while testing the development/fixture bundle.
- [ ] Record the three-app-limit failure as a blocked gate until one of the two choices above resolves it.

**Gate P1:** both an in-place development update and an isolated clean install can launch on the physical
iPhone, or the release explicitly remains blocked.

### P2 — Native LAN correctness on the physical iPhone

Run against a disposable Mac fixture first, then one registered non-critical project.

- [ ] Camera permission: allow, deny, Settings recovery and a real QR scan.
- [ ] Local Network permission: allow, deny, recovery and exact private IPv4 host display.
- [ ] One-use QR: first connect succeeds; QR replay, wrong host, redirect, expired and revoked tokens fail.
- [ ] Project list uses opaque IDs and never exposes local paths, commands, tokens or memory content.
- [ ] Create one disposable project in an approved root; confirm one folder, one registration and one initial
      Git commit. Repeat the same request ID and confirm no duplicate project.
- [ ] Start one fake Workroom agent, then a real installed agent after its login/readiness check. Read output
      before sending the first instruction.
- [ ] Enter Korean composition, a long bounded instruction, Enter/Esc/Ctrl+C and resize/rotation. Lost or
      duplicate inputs must remain zero.
- [ ] Background, screen lock, foreground, process termination and cold launch restore the same valid session
      without resending start/input.
- [ ] Explicit terminal stop, connection disconnect and Mac-side revoke remain three distinct actions.
- [ ] Mac restart restores pairing/listener when allowed but never claims the old PTY still exists.

**Gate P2:** all scenarios pass twice consecutively from a clean fixture; a failure leaves a stable reason code,
no false success and no unintended mutation.

### P3 — Native Internet/5G correctness

- [ ] Start from Wi-Fi, scan the Internet QR, switch the phone to cellular and confirm HTTPS transport.
- [ ] Perform real Google login through `ASWebAuthenticationSession`.
- [ ] Verify callback scheme/host/path, original state, PKCE code-only result and absent/empty fragment policy.
- [ ] Test cancel, late callback, duplicate callback, wrong state and non-empty fragment without logging URL,
      code, state, token or QR material.
- [ ] Compare SAS on Mac and iPhone, approve once, set exact project/terminal/conversation scopes and verify
      the controller cannot exceed them.
- [ ] List projects, create one disposable project, open one Workroom session, send one bounded instruction and
      observe its result on both iPhone and Mac.
- [ ] Switch Wi-Fi↔5G, background/foreground, restart the iPhone app, restart the Mac host and simulate a relay
      interruption. Uncertain mutations stay locked and are not automatically retried.
- [ ] Revoke from iPhone and Mac separately; verify the other side observes revocation and persisted secrets are
      removed according to policy.

**Gate P3:** real Google return→E2EE→SAS→scoped work→reconnect→revoke passes on cellular. Anonymous portal,
memory relay and browser-only evidence do not satisfy this gate.

### P4 — Web preview and production verification

- [ ] Build `dist-portal` from the frozen source and verify its manifest, CSP hashes, asset hashes and
      `release-meta.json`.
- [ ] Deploy an isolated preview first. Run desktop 1440px, tablet 768px and mobile 390/430px tests in light and
      dark themes.
- [ ] Test Google auth, relay connection, SAS, scope editing, project selection, project creation, Workroom
      start/input/output/stop, reconnect and revoke against the staging Mac host.
- [ ] Verify Safari/WebKit and Chromium. Check soft keyboard, Korean IME, rotation, back navigation, refresh,
      stale service/cache and accessibility labels.
- [ ] Confirm `/remote`, `/remote/`, static assets and WebSocket paths keep exact method/origin/CSP restrictions.
- [ ] Promote the exact preview artifact to Production; do not rebuild a different tree during promotion.
- [ ] Read production aliases, response headers, asset hashes and release identity after deployment.

**Gate P4:** production serves the exact tested artifact and all required smoke tests pass from outside the
development process.

### P5 — Performance and resource budgets

First instrument these timestamps on both client and host without recording prompt/output text:

`tap → local feedback → encrypted send → host receive → action accepted → first output → rendered output`.

Separate transport/UI latency from provider startup and model-response time.

| Scenario | Release target |
|---|---|
| Tap/submit visual feedback | p95 ≤ 100 ms |
| Warm LAN request accepted by host | p95 ≤ 500 ms |
| Warm Internet request accepted after established E2EE | p95 ≤ 1,500 ms |
| Output available at host → visible on phone | p95 ≤ 500 ms LAN, ≤ 1,500 ms Internet |
| QR connect → project list, excluding human approval | p95 ≤ 3 s LAN, ≤ 5 s Internet |
| Valid background reconnect | p95 ≤ 5 s LAN, ≤ 8 s Internet |
| Web FCP/LCP/CLS/TBT on mobile production | FCP ≤ 1.8 s, LCP ≤ 2.5 s, CLS ≤ 0.1, TBT ≤ 200 ms |
| Input correctness under 100 sequential commands | 0 lost, 0 duplicated, order preserved |
| Reconnect/restart campaign | 50 cycles, 0 duplicate mutation, 0 silent permission expansion |
| Thirty-minute terminal stream | bounded buffers respected; no monotonic unbounded memory growth |
| Idle connection | no busy polling or sustained unexplained CPU/energy activity |

- [ ] Replace `tests/perf-measure.mjs` fixed localhost URL and hard-coded bundle sizes with a required target,
      runtime resource measurements, cold/warm cache modes and machine-readable thresholds.
- [ ] Add LAN and relay latency injection, delayed/duplicated/out-of-order response cases and slow provider
      startup without extending protocol limits.
- [ ] Use Instruments/XCTest metrics for launch, memory, CPU, hangs and energy on the physical iPhone.
- [ ] Record Mac app, sidecar, WebKit and provider processes separately; one process's RSS is not total usage.
- [ ] Repeat production Web measurements enough to report median/p95 rather than one favorable run.

**Gate P5:** all correctness invariants pass first. A budget miss is profiled and fixed without weakening
authorization, verification, bounded queues or failure reporting.

### P6 — Fault, compatibility and security matrix

- [ ] Current iPhone ↔ current host, previous iPhone ↔ current host, current iPhone ↔ previous supported host.
- [ ] Unsupported protocol combinations show update-required and perform no mutation.
- [ ] Mac asleep/offline, sidecar down, relay down, stale DNS, changed LAN address and clock skew.
- [ ] Expired/replayed QR, stale socket epoch, old delayed frame, revoked grant and scope downgrade.
- [ ] App crash/force quit during create/start/input/stop. Each result is completed, failed or unknown with an
      idempotency receipt; unknown is never converted to success by timeout.
- [ ] Oversized input/output, output truncation cursor, 12 active/24 listed session limits and rate limiting.
- [ ] Logs, screenshots, diagnostics and Vercel artifacts contain no path, QR, OAuth code/state, token, raw
      transcript, credential or service-role data.

**Gate P6:** the compatibility and fault matrix has no P0/P1 defect and every uncertain mutation can be
reconciled without blind replay.

### P7 — Release sequence and rollback

1. Freeze source and database migrations; complete P0–P6 on staging/fixture identities.
2. Ship the compatible Mac host first and verify installed version, sidecar health and capability response.
3. Promote the exact Web preview artifact to Production and run post-deploy smoke/performance sampling.
4. Install the versioned iPhone development build over USB and repeat the production LAN/Internet critical path.
5. When App Store requirements are complete, create a signed archive and TestFlight build with a unique build
   number; USB development installation remains a separate distribution channel.
6. Roll back Web by promoting the last known-good immutable deployment. Roll back Mac/iPhone only to a version
   whose protocol compatibility is explicitly declared. Revoke sessions if a security boundary changed.

Stop the rollout on any of these conditions:

- source/build/protocol identity mismatch;
- authentication or SAS ambiguity;
- duplicate project/session/input;
- input loss or wrong-project execution;
- revoke/expiry failure;
- secret/path leakage;
- crash loop, unbounded resource growth or unresolved P0/P1 defect.

## 5. Test implementation order

Use TDD for missing contracts and preserve existing passing behavior.

1. **RED:** release identity and protocol mismatch tests.
2. **GREEN:** build manifest, health/readback and compatibility UI.
3. **RED:** production performance runner rejects absent/stale/fixed metrics.
4. **GREEN:** parameterized cold/warm Web and remote-action timing collector.
5. **RED:** iOS upgrade migration, duplicate/late request and background/cold resume cases.
6. **GREEN:** native lifecycle fixes observed on the physical device.
7. **RED/GREEN:** failures discovered by LAN and 5G physical runs, one contract at a time.
8. **REFACTOR:** consolidate release evidence and keep UI, transport and provider timing separate.

Required automated commands before a release candidate:

```sh
bun run typecheck
bun run test
cd src-tauri && cargo test
bun run test:smoke
bun run test:ios
swift test --package-path mobile/ios/AgentsToZCore
bun run preflight:ios
bun mobile/ios/scripts/check-workroom.ts
python3 mobile/ios/scripts/check-ui.py
bun run build:portal
bun run test:smoke:vercel
bun run test:smoke:mobile
```

Physical and authenticated tests are separate required evidence. They must never be silently replaced by the
commands above.

## 6. Evidence record

For every run, save a redacted record with:

- source commit, release/build/protocol versions and asset hashes;
- Mac model/OS, iPhone model/iOS and network class without device identifiers;
- fixture/staging/production classification;
- start/end time, scenario, measured stages, result and stable error code;
- whether real Google, real relay, real Mac host, real project and real provider were used;
- cleanup, revoke and rollback result.

Maintain one `EXECUTION.md` beside this plan. Checkboxes move only from current evidence. Do not copy historical
simulator success into a physical-device row and do not count a skipped test as passed.

## 7. Immediate next actions

1. Add release identity/protocol metadata and repair the production performance runner.
2. Build the next development iPhone build number and update the existing development app over USB.
3. Ask the user only for the physical action that cannot be automated: choose a free-profile app slot for the
   isolated clean-install test, unlock/approve the phone, complete Google login/SAS and switch Wi-Fi/5G when
   prompted.
4. Execute P2–P6, fix observed failures and rerun the exact affected scenario plus the full release suite.
5. Promote only the artifact that passed the gates, then update the evidence and project memory.
