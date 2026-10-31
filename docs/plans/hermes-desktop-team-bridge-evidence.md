# Hermes Desktop team bridge: evidence and remaining work

This note records a source investigation, not a supported integration. The
installed Hermes app reports version 0.17.0 and the local Hermes Desktop source
also reports 0.17.0. Matching version strings alone do not establish that the
installed renderer contains the same SDK or build.

## Observed integration points

- Hermes Desktop's `src/sdk/index.ts` exposes read-only host state including
  `cwd`, model, connection, focused runtime/stored session and its owner, plus
  gateway requests and `openSession`. The focused model is a UI selection, not
  proof of the model or account servicing an arbitrary background session.
- The Desktop source uses `session.create` with a workspace `cwd`, route,
  profile and per-session model/provider/reasoning fields; its existing bots
  plugin uses a specific runtime session ID with `prompt.submit`. These are
  internal SDK/gateway examples, not evidence that an external process can
  invoke them safely, or that they provide durable idempotency.
- Desktop runtime plugins run with full renderer authority. The source's
  `contrib/runtime-loader.ts` explicitly describes them as **not** a security
  boundary; plugin installation must therefore be treated as code installation,
  not as proof of caller identity or permission to access existing sessions.
- AgentsToZ `teamExternalHost.ts` opens Hermes as a manual app launch, and
  `teamExternalRuntime.ts` deliberately excludes `surface: app` from managed
  submission. Opening a project window does not prove a selected conversation,
  selected provider/model, or delivery of a task.
- For a new team member, the host defaults an omitted Hermes `appMode` to
  project-app `open`, matching the builder's first option and allowing a fresh
  worktree without an existing conversation to launch. An explicit `reopen`
  remains a request to reopen the recorded session; it is never converted to
  `open`. The launch journal prevents a repeated request from launching twice.

## Requirements before enabling managed submission

1. Verify compatibility against the actual installed renderer and its SDK,
   including gateway method and route behavior. Establish a supported local
   transport and authenticate both ends: the AgentsToZ host and the intended
   Hermes project instance. A window title, requested cwd, plugin presence,
   loopback address or matching version string is not sufficient evidence.
2. Bind one execution to the current team generation, canonical project and
   worktree, Hermes instance incarnation, connection/profile and a newly owned
   stored and runtime session. Revalidate the binding at every mutation; reject
   stale/replaced instances and never target the currently focused or a user's
   pre-existing draft by inference. Preserve existing drafts and sessions.
3. Prove requested model, provider, account and effort against the actual
   session before claiming they were applied. If unsupported or ambiguous,
   preserve the user's settings and report the missing evidence; do not fall
   back to a different surface, provider, or account.
4. Persist an operation reservation and request fingerprint before any
   non-idempotent create or send. A restart, timeout or lost response after
   reservation produces an unknown outcome and cannot trigger an automatic
   second create or submit. Reconcile only with authoritative session-specific
   evidence; a transport acknowledgement alone does not prove a model turn.
   Keep unknown worktrees and borrowed windows until independently resolved.
5. Validate install/enable consent, plugin upgrades, disconnect and restart,
   replay, concurrency, changed project/session/profile, lost responses,
   preserved drafts, and actual app output with isolated tests first. Live
   task delivery is a separate action after the binding has been verified.

The existing `tests/team-external-host.test.ts` includes a Hermes project-app
case that guards the present manual behavior, model/effort uncertainty, and
idempotent replay. It does not prove a working bridge or test a running app.

## 2026-10-28 installed-app investigation

The running Hermes Desktop is 0.17.0 (`/Applications/Hermes.app`, observed PID
76462). Source inspected at
`/Users/cs-work/forcs/hermes-agent-hash-completions/apps/desktop` already has
uncommitted composer and SDK edits. No Hermes source, plugin, setting or installed
binary was changed in this investigation.

`electron/main.ts` exposes Electron IPC for connection-qualified routing and
session-window navigation (`hermes:connection:for`,
`hermes:gateway:ws-url-for`, `hermes:window:openSession`). These handlers and the
renderer SDK are in-process interfaces; none of the inspected entry points
establishes an authenticated external AgentsToZ caller. `electron/api-transport.ts`
already avoids retrying ambiguous non-idempotent HTTP writes, but that alone does
not supply a session-scoped durable external request receipt. It must not be
replaced by a renderer plugin containing a shared bearer secret or by entering
text into a focused composer.

A production bridge therefore still requires a main/native transport which
verifies the peer process identity and binds requests to a newly owned session,
plus a session-specific gateway route and durable reservation/receipt. Native
peer authentication, installed-build compatibility, authoritative approval state,
and live create/submit/read have **not** been implemented or verified. Opening
Hermes continues to return manual transfer status; the user's Opus 5.5 / Max
selection has not been changed or claimed verified.
