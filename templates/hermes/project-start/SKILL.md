---
name: project-start
version: 1.0.0
author: AgentsToZ_byCS
license: MIT
description: "Use when /project_start creates a real project folder under a registered workspace root, initializes its memory, and binds this Telegram DM topic."
metadata:
  hermes:
    tags: [project-memory, supabase, telegram, session]
    related_skills: [memory-start, memory-link, remember-session, memory-sync, memory-status]
---

# Create A New Project Folder For This Topic

Use only for `/project_start [프로젝트 이름]` in a Telegram DM topic.

This does what the app's **새 프로젝트** does, from Telegram: it creates an **actual project folder** under one of the host's registered workspace roots, makes it a git repository with an initial commit, installs the repository workflow, installs project memory inside it, registers it in AgentsToZ, binds the current topic, and writes the first Supabase revision.

Do not confuse it with the two neighbours:

- `/memory_start` makes a memory-only folder in the app data directory. There is no place to put code. Use it when the topic is a conversation to remember, not a project to build.
- `/memory_link <memoryId>` binds this topic to a project memory that already exists.

## Contract

- Read the current route from `HERMES_SESSION_PLATFORM`, `HERMES_SESSION_CHAT_ID`, and `HERMES_SESSION_THREAD_ID`.
- Require Telegram and a non-empty topic/thread ID. Never create in the root/"모두/General" lobby.
- A project name is **required** — it becomes the folder name. If the user gave no argument, ask for one. Do not derive it from conversation prose and do not fall back to a generated name; a folder the user did not name is a folder they will not find.
- Never pick the location yourself. The server decides it from the host's registered workspace roots, and asks you to relay the choice back when there is more than one. Your job is to pass `rootPath` through exactly as the user picked it, never to invent one.

Call `http://127.0.0.1:3001/api/project-memory/thread/create-project` with JSON fields `platform`, `chatId`, `threadId`, `name`, and — only once the user has chosen one — `rootPath`. A safe Python `urllib.request` call is preferred over shell interpolation. Preserve the JSON body on non-2xx responses.

## The answers that are not failures

**`409` with `needsRoot: true`** — the host has several workspace roots and the server will not guess. Show the returned `roots` list (path, and `name` when present), ask which one, then call again with `rootPath` set to the exact path from that list. Do not invent a path and do not retry without one.

**`rootWasDefaulted: true` in a success response** — this host had no workspace root registered, so the server used a default location under the home directory. This is not an error, but the user did not choose that path. Always state the full `folderPath` prominently in this case, or they will not know where their project went. Mention that registering a workspace root on this host will let them choose next time.

**`409` with `PROJECT_START_FOLDER_EXISTS`** — report the path and ask for a different name. Never delete or reuse the existing folder; it may hold the user's work.

## Reporting

Report local creation and Supabase backup independently. Claim completion only when `ok: true`, `localCreated: true`, and `supabaseSaved: true`. Include the created `folderPath` so the user knows where it landed.

Report the `git` block too, and do not smooth it over. `git.initialized` and `git.hasCommit` both true means the repository is ready. If either is false, the folder and its memory are still fine and were **not** rolled back — say plainly that the git repository was not completed, quote `git.error`, and tell the user they can finish it from the app's 「Git 저장소 만들기」. A project without a repository still works as a folder, but the app's worktree, commit-activity, and cleanup-review features all assume one.

If local creation succeeded but Supabase failed, keep the binding and advise `/memory_sync` after fixing the reported cause — the project and its memory are already on disk and must not be recreated.

Explain that `/remember_session` curates this topic's conversation into the new project's memory; `/memory_sync` only reconciles what is already saved.
