---
name: hermes-open
version: 1.0.0
author: AgentsToZ_byCS
license: MIT
description: "Use when /hermes_open opens the bound registered project folder in Hermes Desktop."
metadata:
  hermes:
    tags: [project-memory, telegram, desktop, hermes]
    related_skills: [memory-link, memory-status, remember-session]
---

# Open The Bound Project In Hermes Desktop

Use only when the user invokes `/hermes_open <memoryId>` from a Telegram topic.

This command opens the local Hermes Desktop on the same Mac where the AgentsToZ API and Hermes gateway are running. It does not open a folder on Telegram's host, the gateway's current working directory, or an arbitrary path supplied in chat.

## Contract

- Require `HERMES_SESSION_PLATFORM=telegram`, a non-empty `HERMES_SESSION_CHAT_ID`, and a non-empty `HERMES_SESSION_THREAD_ID`. Refuse root/General lobby messages.
- Require exactly one project selector argument. The selector must be a registered project `memoryId` (the resolver also accepts its exact registered project ID/name/path for compatibility, but prefer the stable memory ID).
- Never accept a folder path from the Telegram message and never scan the filesystem.
- First call `POST http://127.0.0.1:3001/api/project-memory/thread/status` with JSON `platform`, `chatId`, and `threadId`.
- Require the topic to be bound. If it is unbound, tell the user to run `/memory_link <memoryId>` first.
- Call `POST http://127.0.0.1:3001/api/project-memory/resolve-project` with JSON `{ "project": "<argument>" }` using a safe Python `urllib.request` call, not shell interpolation.
- Require the resolved `memoryId` to equal the topic binding's `memoryId`; if they differ, stop and do not open either project.
- Call `POST http://127.0.0.1:3001/api/open-code-app` exactly once with JSON `{ "agent": "hermes", "folderPath": "<resolved canonicalPath>" }`.
- Preserve and report structured JSON bodies on all non-2xx responses, including `code`, `error`, and `candidates`. Do not replace them with a generic curl error.

## Report

Only claim success when the final response has `success: true` and the resolved project identity matches the topic binding. Report the project name and that Hermes Desktop was verified on the canonical folder. Explain that the Telegram topic and Desktop window share the project files and `.agent-memory`, but remain separate conversation sessions; use `/remember_session` in this Telegram topic to curate its conversation into project memory.
