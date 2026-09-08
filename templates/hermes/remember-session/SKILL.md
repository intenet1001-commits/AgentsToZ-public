---
name: remember-session
version: 1.0.0
author: AgentsToZ_byCS
license: MIT
description: "Use when /remember_session saves this Hermes conversation into bound AWS project memory."
metadata:
  hermes:
    tags: [project-memory, supabase, telegram, session]
    related_skills: [memory-link, memory-sync, memory-status, memory-unlink]
---

# Remember This Hermes Session

## Routing

Use only when the user invokes `/remember_session`.

Read the route from `HERMES_SESSION_PLATFORM`, `HERMES_SESSION_CHAT_ID`, and `HERMES_SESSION_THREAD_ID`.

- **If an argument is present**, resolve that registered project through `http://127.0.0.1:3001/api/project-memory/resolve-project`. This is a one-shot local-terminal selection and must not bind the current route.
- **If no argument is present**, resolve the current Telegram topic through `http://127.0.0.1:3001/api/project-memory/thread/status` using JSON `platform`, `chatId`, and `threadId`.
- If the route is unbound, stop with: `이 Telegram topic은 프로젝트와 연결되어 있지 않습니다. /memory_link <memoryId>를 먼저 실행하세요.`
- Never scan the filesystem, fuzzy-match, use gateway cwd, initialize a typo path, or infer a project from a topic title.

Preserve structured JSON bodies on non-2xx responses. Proceed only when the selected result is `ok: true`. Use only its canonical project path, stable `memoryId`, agent, and automatic-backup setting.

## Goal

Use the **current Hermes conversation** to curate one project's durable memory. Local memory is authoritative; Supabase is a recoverable follow-up.

## Procedure

1. When automatic backup is enabled, Pull before editing. Call `POST http://127.0.0.1:3001/api/project-memory/pull` once with JSON `folderPath`.
   - `alreadySynced` and a successful restore are safe.
   - On `conflict`, do not edit or overwrite. Report the conflict and stop.
   - If no remote backup exists, continue with existing local memory.
   - If the API is unavailable, stop rather than retrying.
2. Read `$PROJECT_ROOT/.agent-memory/config.json` and its project-relative `sourcePath`.
   - If `.agent-memory/notes/manifest.json` exists, read the index and only relevant notes. Write notes, never the generated index.
   - Otherwise update the configured single source file.
3. Review the current Hermes conversation and bounded Git evidence. Add only durable, supported decisions, stable constraints, recurring verified issues, and validated project workflows.
   - Every durable `###` entry has `<!-- memory-entry-id:<24 lowercase hex> -->` immediately after its heading.
   - Never remove or regenerate an existing entry ID when renaming its title or moving it to another section. New unrelated entries need new IDs.
4. Never store secrets, environment values, raw transcripts, temporary progress, guesses, or generic knowledge. Preserve existing decisions and put genuine contradictions under `Contested Entries`.
5. After the local edit is safely written, call `POST http://127.0.0.1:3001/api/project-memory/mark-remembered` once with JSON `folderPath` and a one- or two-sentence Korean `narrative` describing what was learned. `markedRemembered: true` and a journal path are required.
6. If automatic backup is enabled, call `POST http://127.0.0.1:3001/api/project-memory/push` once. Do not force a conflict or retry in a loop. If automatic backup is disabled, report that the local save succeeded and the backup was skipped by policy.

## Report

Report independently:

- current Hermes learnings curated locally: saved / not saved;
- append-only journal: recorded / not recorded;
- Supabase curated revision: saved / skipped / retry needed;
- Supabase journal: saved / partial / retry needed;
- conflict or degraded evidence: explicit warning and safe next action.

Never include memory contents, credentials, portal keys, or raw conversation text.
