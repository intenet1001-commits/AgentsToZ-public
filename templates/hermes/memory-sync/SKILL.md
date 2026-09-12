---
name: memory-sync
version: 1.0.0
author: AgentsToZ_byCS
license: MIT
description: "Use when /memory_sync reconciles bound project memory."
metadata:
  hermes:
    tags: [project-memory, supabase, telegram, session]
    related_skills: [remember-session, memory-link, memory-status, memory-unlink]
---

# Sync Bound Project Memory

Use only for `/memory_sync` with no project argument.

Read `HERMES_SESSION_PLATFORM`, `HERMES_SESSION_CHAT_ID`, and `HERMES_SESSION_THREAD_ID`, then call `http://127.0.0.1:3001/api/project-memory/thread/sync` once with those three JSON fields. Preserve structured JSON on non-2xx responses.

This command never curates the current conversation and never edits memory prose. It is an explicit manual sync request, so it runs even when automatic backup is disabled. It only chooses a safe hash-based action: `none`, `pull`, or `push`. If the API returns conflict/409, do not force, overwrite, or retry. Report the project, direction, action, curated-revision result, journal result, and any partial backup error separately.
