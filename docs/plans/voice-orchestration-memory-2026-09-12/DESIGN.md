# Voice orchestration memory

## Decision

AgentsToZ owns one provider-neutral orchestration memory in its application-data
directory. It is not a project, does not create a second `.agent-memory`, and is
not stored inside the AgentsToZ source tree.

The system keeps four runtime authorities and one optional project authority:

1. The provider owns its native conversation history.
2. **What I Said** stores an utterance once, under its existing consent and
   retention policy.
3. A **mission** stores cross-project intent, ordering, dependencies, progress,
   and the integrated result.
4. Each project's existing memory stores only decisions and results that apply
   to that project.
5. An optional `AgentsToZ-Control` project stores stable cross-project aliases,
   relationships, orchestration preferences, and reviewed shared decisions. It
   is a normal Git-backed project with its own memory identity; it does not own
   live mission state or provider transcripts.

References connect these authorities. Text is not copied between them.

The control-center project is portable across Macs through two coordinated
layers: Git transfers its documents and `.agent-memory/config.json`, while
Supabase transfers revisions for that same `memoryId`. A clone must pull before
any backup and must never reinitialize the memory identity.

## Binding rule

Bindings follow verified state transitions, not a language-model guess:

- a successful AgentsToZ project-open or Workroom action establishes a project
  segment;
- a successful switch closes that segment and starts another;
- a multi-project action may bind one event to several project IDs;
- merely listing, mentioning, or reading a project does not update its memory;
- a project gets a memory candidate only after a decision, change, or verified
  result affects that project.

For an A-to-B file copy, the mission records the transfer and B records the
applied result. A records nothing unless A itself changed or gained a durable
decision.

## Mission lifecycle

`active -> paused -> active -> completed`

An unexpected disconnect moves an active mission to `interrupted`. Reopening
Codex Voice never resumes capture automatically. The user must explicitly
resume the mission. Ending orchestration does not terminate provider sessions.

Read-only browsing and a simple application open remain ephemeral audit events.
A durable mission begins only when the user explicitly starts one or when a
multi-project or multi-agent operation is accepted.

## Local schema

The encrypted store contains:

- `missions`: title, goal, lifecycle state, timestamps, checkpoint summary;
- `mission_projects`: opaque registered project IDs plus their role;
- `mission_events`: append-only orchestration actions and verified outcomes;
- `utterance_links`: an existing What I Said event ID linked to a mission and
  zero or more project IDs;
- `project_memory_candidates`: compact result references awaiting the existing
  project-memory save path.

Every mutation accepts a request ID and stores an idempotency receipt. Project
paths, prompts, terminal output, credentials, and provider secrets are excluded.

## Delivery order

1. Add the encrypted local store, lifecycle state machine, idempotency, and
   bounded reads.
2. Add bounded AgentsToZ control tools to create, resume, pause, complete, and
   inspect missions.
3. Record successful Workroom actions as mission events and attach verified
   project IDs.
4. Link What I Said event IDs without copying utterance text.
5. Emit project-memory candidates only for actual decisions, changes, or
   verified results.
6. Add UI review and explicit promotion of global preferences.
7. Add optional account-scoped synchronization as a separate migration after
   local recovery and conflict behavior pass installed-app tests.

## Safety invariants

- No mission operation accepts a filesystem path or shell command.
- No raw utterance or terminal output is stored in the mission database.
- One utterance ID can have many references but one source record.
- Future schema versions fail closed.
- Missing encryption keys never create replacements for an existing store.
- Resume is explicit after pause, interruption, restart, or disconnect.
- Project memory remains canonical in that project's primary worktree.
