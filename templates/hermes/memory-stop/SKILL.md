---
name: memory-stop
version: 1.0.0
author: AgentsToZ_byCS
license: MIT
description: "Compatibility alias: /memory_stop disconnects like /memory_unlink."
metadata:
  hermes:
    tags: [project-memory, telegram, session]
    related_skills: [memory-unlink, remember-session, memory-link, memory-sync, memory-status]
---

# Stop Project Memory Binding

Compatibility alias for `/memory_unlink`. Perform the same scoped unbinding, then tell the user the preferred command is `/memory_unlink`.

Use only for `/memory_stop`.

Read `HERMES_SESSION_PLATFORM`, `HERMES_SESSION_CHAT_ID`, and `HERMES_SESSION_THREAD_ID`, then call `http://127.0.0.1:3001/api/project-memory/thread/stop` once with those JSON fields.

This removes only the current chat/thread mapping. It must not delete `.agent-memory`, revisions, journals, Supabase data, or another topic's binding. Report `removed: true` as disconnected and `removed: false` as already disconnected.
