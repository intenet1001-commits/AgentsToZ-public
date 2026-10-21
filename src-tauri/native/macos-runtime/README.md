# AgentsToZ macOS runtime boundary

This dependency-free Swift package is the native, production-shaped boundary
for the future managed runtime. Its client is wired only into the Tauri main
process and the development build can stage a non-authorizing bundle layout;
it is not wired into any runtime execution path.

The `com.intenet.agentstozbycs.runtime-broker` executable has three bounded
`NSData` XPC methods: a 32-byte liveness probe, a fixed dedicated-identity
fixture, and fixed dedicated-account provisioning. Each accepts only a
32-byte challenge; none can receive an
executable, argv, path, environment, credential, or provider request.
It exits before creating a listener unless all of these are true:

- macOS 26 or newer
- effective UID and GID are root
- its parent is launchd
- a non-placeholder Developer ID Team ID is compiled into the source
- its live code satisfies the exact broker identifier, Developer ID chain, Team
  ID, and `service-v1` entitlement requirement

New XPC connections are rejected by Foundation before the delegate unless the
client satisfies the exact application identifier, same Team ID, Developer ID
chain, and `client-v1` entitlement requirement. A future native application
client calls `NSXPCConnection.setCodeSigningRequirement` with the exact
broker requirement before resuming, so authentication is mutual.

The Tauri main binary now links a native Objective-C client bridge for
`SMAppService` status/register/unregister, mutual-signature XPC probe, account
provisioning, and the dedicated-identity fixture. Every operation first requires macOS 26, the exact
`/Applications/AgentsToZ_byCS.app` location and identifier, a compile-time
non-placeholder Team ID, the live client signing requirement, and the embedded
broker/plist. The checked-in Team ID is deliberately `nil`, so development and
ad-hoc builds return `production-identity-unavailable` before touching
ServiceManagement. Mutating Tauri commands additionally require an exact
confirmation boolean; their result is always `executionAuthorized:false`,
`reusable:false`, and `ready:false`.

`com.intenet.agentstozbycs.runtime-broker-fixture`,
`com.intenet.agentstozbycs.runtime-worker-fixture`, and
`com.intenet.agentstozbycs.runtime-dedicated-worker-fixture` are separate
development-only executables.
They prove a bounded same-UID challenge round trip without registering an
SMAppService, creating an account, invoking `launchctl`, or touching Apple
Container. They are never placed in the application bundle by this phase.

The dedicated worker is a second-stage binary, not executed by the development
build. It can succeed only as `_agentstoz` with a UID/GID in 400...499, the
fixed `/var/empty` home and `/usr/bin/false` shell, launchd parent PID 1, no
root/admin supplementary group, and `launchctl managername` equal to
`Background`. It reads one root-owned 32-byte challenge and emits one bounded
canonical proof. The signed root broker contains a fixed coordinator that can
bootstrap only the checked-in worker plist into `user/<uid>` and independently
validates that proof. The macOS build wrapper now stages only the broker,
dedicated worker and their two fixed plists into the production-shaped app
directories before re-sealing the existing development app. That stage embeds
no Team ID or production entitlement and reports `ready:false`. The root broker
contains an OpenDirectory provisioner for one fixed `_agentstoz`
non-login/no-password/non-admin account. It rejects partial or foreign records,
rolls back only records created by the current request, and binds the validated
UID/GID and GeneratedUID values to a root-owned 0444 manifest. Production
signing, service approval, actual account creation, reboot validation, and
execution of the dedicated fixture are still intentionally absent.

Run the isolated build and harmless fixture from the repository root:

```bash
bun run test:macos-runtime-native
bun run test:macos-runtime-native:repeat
bun run test:macos-runtime-production-sources
bun run build:macos-runtime-native
bun run build:macos-runtime-native:production
bun run inspect:macos-runtime-production
```

The production inspection command does not accept a Team ID or identity from
arguments or environment. It selects exactly one Developer ID Application
identity from a bounded `/usr/bin/security` snapshot, then proves private-key
access by signing a temporary `/usr/bin/true` copy with hardened runtime and a
secure timestamp. It validates the exact Team ID, Apple Developer ID chain and
OID requirement, removes the canary, exposes no private identity metadata, and
exits 2 unless both snapshots pass. Even a passing result remains explicitly
non-authoritative and cannot register or enable the service.

After the canary, `src/macOSRuntimeProductionSourcePin.ts` can generate the four
matching compile-time source pins for Swift, Objective-C and the static signing
probe. It takes no raw Team ID, requires every checked-in `nil` sentinel exactly
once, and never writes the repository. The scratch production build that will
consume this all-or-nothing source set is not connected yet.

The test-only production-source fixture compiles that scratch Swift package,
its protocol self-test, the generated Objective-C bridge at the app's macOS
10.13 deployment target, and the generated TypeScript probe. It uses a fixed
fake Team ID only in the disposable tree and performs no signing, installation,
ServiceManagement call, account creation, or runtime execution.

The production-native command consumes the real canary result, compiles the
scratch Swift package, signs and re-verifies only the broker and dedicated
worker in inside-out order, and removes all generated artifacts after its
callback. On a machine without exactly one usable Developer ID Application
identity it exits 2 before staging. Even a successful native manifest still
states that the app is unsigned, unnotarized, uninstalled and not ready.

The normal cross-platform Bun suite checks the portable source/layout contract.
The `macos-runtime-native` job in `.github/workflows/verify.yml` additionally
compiles and executes this fixture on the `macos-26` Apple Silicon runner.

The build stages ignored development artifacts under `.artifacts/`. Its
manifest and fixture output both say `ready: false`; neither is an execution
capability or containment proof.

The staged broker is ad-hoc signed without the production role entitlement so
that its fail-closed startup can be tested locally. macOS terminates an ad-hoc
binary that attempts to claim this production entitlement. The separate
entitlement plist is only an input to the future Developer ID inside-out
signing pipeline.

## Interrupted artifact publishing

Publishing uses the fail-closed `.artifacts-publish.lock` directory. It is not
automatically reclaimed from a PID because PID reuse cannot prove that an old
publisher is gone. If a build crashes and leaves the lock behind:

1. Confirm no `build-macos-runtime-native.ts` or Swift build process is alive.
2. Inspect `.artifacts`, every `.artifacts-stage-*`, and every
   `.artifacts-backup-*` directory without following symlinks.
3. If `.artifacts` is absent and exactly one complete backup contains all four
   binaries, all four config files, and `manifest.json`, restore that backup.
   Otherwise do not guess which backup is authoritative.
4. Remove only incomplete generated stage/backup directories after inspection,
   then remove the exact `.artifacts-publish.lock` directory and rerun the
   build.
