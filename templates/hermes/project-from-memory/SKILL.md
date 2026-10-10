---
name: project-from-memory
version: 1.0.0
author: AgentsToZ_byCS
license: MIT
description: "Use when /project_from_memory creates a project folder from an existing long-term-memory ID and binds this Telegram topic."
metadata:
  hermes:
    tags: [project-memory, restore, telegram, aws]
    related_skills: [project-start, project-clone, memory-sync, remember-session]
---

# Restore A Project From Long-Term Memory

Use for `/project_from_memory <memoryId> <프로젝트 이름>` in a Telegram DM topic.

Require Telegram, chat ID, and a non-empty topic/thread ID. Both the UUID memory ID and a user-chosen project name are required. This operation creates a new folder and local Git repository, restores the latest memory revision, registers the folder in AgentsToZ, and binds this topic. It does not reconstruct code that was never stored in long-term memory; state that clearly and recommend `/project_clone` when a GitHub repository exists.

Call `http://127.0.0.1:3001/api/project-memory/thread/create-project` with JSON fields `platform`, `chatId`, `threadId`, `mode: "memory"`, `memoryId`, `name`, and optional `rootPath`. Use Python `urllib.request` for safe JSON encoding and preserve non-2xx JSON bodies.

When `needsRoot: true`, show the exact roots and ask which one. Never invent, delete, or reuse a folder. On success report `folderPath`, Git readiness, restored memory ID, and Supabase result. If the local folder and binding were created but the pull failed, keep them and report the exact error so `/memory_sync` can be retried.
