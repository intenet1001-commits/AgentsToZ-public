---
name: memory-status
version: 1.0.0
author: AgentsToZ_byCS
license: MIT
description: "Use when /memory_status checks this thread's project."
metadata:
  hermes:
    tags: [project-memory, supabase, telegram, session]
    related_skills: [remember-session, memory-link, memory-sync, memory-unlink]
---

# Bound Project Memory Status

Use only for `/memory_status`.

Read `HERMES_SESSION_PLATFORM`, `HERMES_SESSION_CHAT_ID`, and `HERMES_SESSION_THREAD_ID`, then call `http://127.0.0.1:3001/api/project-memory/thread/status` once with those JSON fields. Preserve the JSON body on 404/409.

Report: current route (root or thread ID), bound project ID/name, stable `memoryId` (abbreviated), local memory existence, `needsRemember`, automatic backup setting, and local last-sync status. Do not expose memory contents or secrets. If unbound, suggest `/memory_link <memoryId>`; if identity mismatch, require re-binding and do not guess a path.
