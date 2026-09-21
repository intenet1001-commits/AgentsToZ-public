---
name: project-clone
version: 1.0.0
author: AgentsToZ_byCS
license: MIT
description: "Use when /project_clone clones a GitHub repository on this AWS/Linux host, initializes project memory, and binds the current Telegram topic."
metadata:
  hermes:
    tags: [project-memory, github, telegram, aws]
    related_skills: [project-start, project-from-memory, memory-sync, remember-session]
---

# Clone A GitHub Project For This Topic

Use for `/project_clone <GitHub URL> [프로젝트 이름]` in a Telegram DM topic.

Require `HERMES_SESSION_PLATFORM=telegram`, a chat ID, and a non-empty topic/thread ID. Never run in the root lobby. The GitHub URL is required. The optional name changes the destination folder name; when omitted, the server derives it from the repository name. Never run `git clone` yourself and never delete or reuse an existing target folder.

Call `http://127.0.0.1:3001/api/project-memory/thread/create-project` with JSON fields `platform`, `chatId`, `threadId`, `mode: "clone"`, `repositoryUrl`, optional `name`, and optional `rootPath`. Use Python `urllib.request` so arguments are JSON-encoded safely and preserve non-2xx JSON bodies.

When the server returns `409` with `needsRoot: true`, show the returned roots, ask the user to choose one, and retry with that exact `rootPath`. On success, report `folderPath`, Git readiness, the memory ID from `binding`, and Supabase backup independently. If local creation succeeded but backup failed, keep the project and advise `/memory_sync`; do not clone again.

The resulting folder is registered in AgentsToZ, has repository workflow and long-term memory installed, and is bound to this topic. `/remember_session` saves the topic conversation into it.
