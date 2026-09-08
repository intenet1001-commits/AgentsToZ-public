---
name: memory-link
version: 1.0.0
author: AgentsToZ_byCS
license: MIT
description: "Use when /memory_link binds this Telegram topic to one registered AWS project memory."
metadata:
  hermes:
    tags: [project-memory, supabase, telegram, session]
    related_skills: [remember-session, memory-sync, memory-status, memory-unlink]
---

# Link This Telegram Topic To Project Memory

Use only for `/memory_link <shared memoryId, registered project ID, exact name, or registered absolute path>`.

This command never creates a new independent memory. For a new memory owned by the current Telegram DM topic, use `/memory_start [기억 이름]`.

## Contract

- Require one project argument. If absent, reply: `사용법: /memory_link <공유 memoryId>`.
- Read the current route from `HERMES_SESSION_PLATFORM`, `HERMES_SESSION_CHAT_ID`, and `HERMES_SESSION_THREAD_ID`.
- Bind by stable project `memoryId`, not by topic title or gateway cwd.
- Never scan for repositories, fuzzy-match, or initialize an unregistered path.
- In Telegram DM topic mode, do not claim this works in the root/“모두/General” lobby; use a project topic.

Call `http://127.0.0.1:3001/api/project-memory/thread/start` once with JSON fields `platform`, `chatId`, `threadId`, and `project`. Preserve the JSON body on non-2xx responses. A safe Python `urllib.request` call is preferred over shell interpolation.

Proceed only when the response has `ok: true`. Report the bound project name and whether local memory was newly initialized. Do not claim Supabase synchronization from this command alone. Explain that normal saving uses `/remember_session`, while `/memory_sync` only reconciles already-saved memory.
