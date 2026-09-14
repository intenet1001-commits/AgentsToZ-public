---
name: memory-unlink
version: 1.0.0
author: AgentsToZ_byCS
license: MIT
description: "Use when /memory_unlink disconnects this Telegram topic from project memory."
metadata:
  hermes:
    tags: [project-memory, telegram, session]
    related_skills: [remember-session, memory-link, memory-sync, memory-status]
---

# Unlink This Telegram Topic

Use only for `/memory_unlink`.

Read `HERMES_SESSION_PLATFORM`, `HERMES_SESSION_CHAT_ID`, and `HERMES_SESSION_THREAD_ID`, then call `http://127.0.0.1:3001/api/project-memory/thread/stop` once with those JSON fields.

This removes only the current chat/topic mapping. It must not delete `.agent-memory`, revisions, journals, Supabase data, the AWS clone, or another topic's binding. Report `removed: true` as disconnected and `removed: false` as already disconnected.
