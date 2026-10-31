# External team app investigation — 2026-10-28

## Actual installed Orca read

Observed Orca 1.4.211, PID 555. The durable execution
`team_1b04d3b6061e:m2` remained bound to the same runtime, terminal incarnation,
worktree and Claude identity. Its journal revision was 168, instruction was
`written`, and all recorded operations were settled. The active team's target,
canonical cwd, agent, surface and generation matched the saved execution.

The source recovery adapter executed exactly `terminal show`, `terminal read`,
`terminal show`; the journal revision stayed unchanged. It returned a bounded
400-character tail and cursor `21`. A subsequent installed MCP
`agentstoz_use_team_member` read returned:

```json
{"success":true,"performed":true,"effect":"read-only","memberId":"m2","surface":"orca-worktree","cursor":"21","agentVerified":false,"outcome":"read","reason":"EXTERNAL_HOST_RESTART_READ_ONLY"}
```

This is actual installed-app evidence, not a fixture. It does not prove a model
turn, model/effort selection, safe input state or new transmission. No input,
approval, reveal, close, restart or journal edit was performed.

The installed AgentsToZ bundle reports 1544.0.0; its sidecar contains the existing
`EXTERNAL_HOST_RESTART_READ_ONLY` implementation and was listening on local port
3001 as PID 39619. Thus the prior handoff's `EXTERNAL_GENERATION_STALE` failure is
historical, not the result of this current MCP read. A bundle version and marker
presence alone do not identify every long-lived MCP process's loaded code.

## Source changes and limits

Recovery inspection now returns fixed diagnostic reasons for scope mismatch,
team change, missing CLI, transport failure, native incarnation change, cwd
change, unverified agent, disconnection and malformed read evidence. The bridge
propagates a diagnostic only while the journal revision and team binding still
match. No native handle or raw error is included. The older nullable read helper
remains available for compatibility.

A settled transport attempt is not necessarily a resolved operation. Recovery
now also refuses `sending`/`unknown` instruction receipts and unresolved
close/outcome reasons, in addition to reserved operations. Native host identity
and the saved runtime/incarnation tuple are validated before invoking Orca.
A connected writable PTY now has activity `unknown` unless an actual execution
observer supplies activity; it may be running, contain a draft or await approval.

Focused regression run: 53 pass, 0 fail across `team-orca-recovery-read`,
`team-runtime-bridge`, `team-external-host`, `team-restart-read-only`. These
regressions are fixtures, separate from the live read above.

Restart recovery remains read-only. It does not migrate the durable owner to the
new host, and cannot authorize sending, reveal or closure. Hermes's authenticated
managed app bridge remains unimplemented; see
[Hermes evidence](hermes-desktop-team-bridge-evidence.md).
