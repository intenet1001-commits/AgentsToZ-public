# Execution record

This file records only evidence observed while executing
[`PLAN.md`](./PLAN.md). A build, simulator, fixture, physical device and production deployment are separate
surfaces and must remain separate rows.

## 2026-09-12 baseline

| Check | Result | Classification |
|---|---|---|
| Git source | local HEAD and `origin/main` matched `e2135a12...` | source identity |
| Mac application | installed and running version `448.0.0` | installed Mac host |
| iPhone discovery | Xcode reported one connected physical iPhone destination | physical connection only |
| Existing iPhone apps | production `0.1.0 (1)`, development `0.1.0 (5)` | installed-version readback |
| `bun run test:ios` | exit 0; 11 native groups and real Swift URLSession↔Bun checks passed | automated native/network fixture |
| `bun run preflight:ios` | exit 0; iPhone SDK/build ready; TestFlight and physical checks incomplete | readiness inspection |
| Signed iPhone build | current source compiled and signed successfully for the connected device using the isolated fixture bundle ID | device build, not install/run |
| Isolated iPhone fixture install | failed before launch: free development profile already tracks three applications | **blocked physical E2E** |
| Existing apps altered | none; no existing application was deleted or replaced | cleanup/safety |
| Vercel | latest production deployment reported `READY` and production aliases | deployment status |
| Vercel source binding | deployment inspection did not expose a source commit matching the local build | **unproven artifact identity** |
| Performance suite | existing runner targets localhost and hard-codes historical bundle sizes | **not acceptable as current production proof** |

## Current gate status

- P0 release identity: **partial**
- P1 physical-device lane: **blocked at isolated installation**
- P2 physical LAN: **not run on this source**
- P3 physical Internet/5G: **not run on this source**
- P4 exact Web production artifact: **deployment ready, identity/smoke incomplete**
- P5 performance/resource budgets: **not run**
- P6 compatibility/fault matrix: **not run**
- P7 release: **blocked by P0–P6**

## Next evidence to append

1. Versioned in-place development app update and launch readback.
2. User-selected resolution of the free-profile test slot, followed by isolated clean-install fixture.
3. Physical LAN matrix.
4. Physical cellular Google→E2EE→SAS→work→revoke matrix.
5. Commit-bound Web preview/production performance results.

## 2026-09-12 mobile usability and release-resource pass

| Check | Result | Classification |
|---|---|---|
| iOS AppIcon | existing AgentsToZ artwork converted to an opaque 1024×1024 RGB AppIcon; Xcode produced `Assets.car` and `CFBundleIconName=AppIcon` | build resource passed |
| iOS privacy resources | `PrivacyInfo.xcprivacy` bundled with the app-only UserDefaults reason; export-compliance declaration reads false; data-collection declarations remain intentionally unclaimed | required-API resource passed; privacy audit/App Store answers still pending |
| iOS release identity | app info shows product version, unique build, channel and short source commit; remote/task protocols are embedded in the bundle | implementation passed; physical readback pending |
| iOS onboarding UI | portal address is a visible URL keyboard field; QR remains a separate primary action | simulator UI passed |
| iOS simulator UI | XCUITest passed the Korean input and unsupported-address flow; one authenticated personal-portal case remained explicitly skipped | simulator evidence only |
| iOS Workroom | disposable simulator passed selection, grant, PTY input/output, draft non-execution, duplicate fences, background/cold resume, disconnect, fresh QR, revoke and navigation containment | simulator fixture passed |
| unsigned device archive | arm64/iPhoneOS archive valid; AppIcon, compiled assets, privacy manifest and encryption declaration present | archive rehearsal passed; not installable/distributable |
| Web release identity | portal build emits `/release-meta.json` with build, source and exact remote/task protocols | local artifact passed; production readback pending |
| Production Web performance baseline | mobile Chromium cold/warm 5 runs measured dynamically; cold FCP/LCP p95 was 1,824ms, 24ms above the 1,800ms FCP budget; all other Web-vital budgets passed | **performance gate failed before new deployment** |

The isolated physical fixture remains blocked by the free-development-profile three-app limit. The in-place
`com.intenet.agentstoz.mobile.dev` upgrade lane does not need another slot and is the next physical step after
the source commit is frozen.

## 2026-09-13 pre-deployment verification

| Check | Result | Classification |
|---|---|---|
| Bun suite | 4,180 passed, 0 failed across 558 files | source regression passed |
| Rust suite | 58 passed, 0 failed | native backend regression passed |
| iOS native suite | 11 groups passed, including Swift URLSession↔Bun pairing, resume, redirect rejection and cancellation | native/network fixture passed |
| iOS simulator UI | one flow passed; the personal-portal fixture remained explicitly skipped because no authenticated test portal was supplied | simulator UI passed with named external fixture gap |
| iOS Workroom fixture | connection, grant, PTY I/O, memory draft, cold resume, fresh reconnect, revoke and redirect checks passed | disposable mobile integration passed |
| Local browser smoke | 216 passed, 0 failed against an isolated API on port 3011 | desktop/workroom UI regression passed |
| Workroom smoke fidelity | fixture now preserves concurrent sessions and awaits the exact list response; exact project+agent reuse completed without an extra terminal start | false-positive race removed |
| Portal production build | emitted hashed assets and `release-meta.json` for build `448.0.0` and protocols `agentstoz-local-v7`/`agentstoz-local-v8` | local deploy artifact passed |
| Unsigned iPhone archive | fresh iPhoneOS arm64 archive passed with generated phone/iPad icons, `Assets.car`, `PrivacyInfo.xcprivacy`, version `448.0.0 (448)` and non-exempt encryption false | archive rehearsal passed; still unsigned |
