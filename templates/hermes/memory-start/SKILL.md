---
name: memory-start
version: 2.0.0
author: AgentsToZ_byCS
license: MIT
description: "Use when /memory_start creates a new standalone memory for this Telegram DM topic and backs it up to Supabase."
metadata:
  hermes:
    tags: [project-memory, supabase, telegram, session]
    related_skills: [memory-link, remember-session, memory-sync, memory-status, memory-unlink]
---

# Create New Standalone Memory For This Topic

Use only for `/memory_start [기억 이름]` in a Telegram DM topic.

This command creates a **new independent memory**, registers its local backing folder, binds the current topic, and writes its initial revision to Supabase. It is not an alias for `/memory_link`; `/memory_link <memoryId>` connects an already-existing registered project memory.

## Contract

- Read the current route from `HERMES_SESSION_PLATFORM`, `HERMES_SESSION_CHAT_ID`, and `HERMES_SESSION_THREAD_ID`.
- Require Telegram and a non-empty topic/thread ID. Never create in the root/“모두/General” lobby.
- If the user supplied an argument, use it as the exact memory name.
- If no argument was supplied, derive the name from the current Hermes session title in the profile's `state.db`, matching the exact `chat_id` and `thread_id`. Use `HERMES_HOME/state.db` when set, otherwise `~/.hermes/state.db`. If no non-empty title exists, use `Telegram topic <threadId>`; do not guess from conversation prose.
- Never scan for repositories, use gateway cwd, or reuse another topic's binding.

Call `http://127.0.0.1:3001/api/project-memory/thread/create` once with JSON fields `platform`, `chatId`, `threadId`, and `name`. Preserve the JSON body on non-2xx responses. A safe Python `urllib.request` call is preferred over shell interpolation.

Report local creation and Supabase backup independently. Claim completion only when `ok: true`, `localCreated: true`, and `supabaseSaved: true`. If local creation succeeded but Supabase failed, keep the binding and advise `/memory_sync` after fixing the reported cause. Explain that `/remember_session` curates the topic conversation into the new memory; `/memory_sync` only reconciles already-saved memory.
