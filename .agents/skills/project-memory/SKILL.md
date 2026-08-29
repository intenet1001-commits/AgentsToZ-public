---
name: project-memory
description: Recall project-local long-term memory for Codex. Use before substantial project work or when asked about past decisions, constraints, recurring issues, and validated workflows.
---

<!-- AgentsToZ memory-agent-version:14 -->
# Project Memory

## Recall

1. Read `.agent-memory/config.json`.
2. Read the project-relative file in `sourcePath`. Once a project's memory grows past a
   threshold this file becomes an **index**: a preamble plus every entry title, grouped by
   section, each group naming one file under `.agent-memory/notes/`.
3. If the index applies, open **only the notes whose titles match the current task** — not the
   whole folder. That is the point of the split; reading every note puts the cost back.
   A project small enough to still be a single file has no index and needs no second read.
4. Surface only decisions, recurring issues, constraints, and patterns relevant to the current task.

Never edit the index by hand — it is regenerated from the notes on every save. Edit the note.

## Pull first when the project is shared across machines

This memory syncs through Supabase, so the same project may have been updated on another
PC. Before substantial work, pull the latest revision. The local file is overwritten only
when the remote is newer; an unchanged remote answers `alreadySynced`.

macOS / Linux / Git Bash:

```bash
PROJECT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
curl --fail-with-body -sS -X POST --get --data-urlencode "folderPath=$PROJECT_ROOT" http://127.0.0.1:3001/api/project-memory/pull
```

Windows PowerShell — call `curl.exe`, not `curl`. In PowerShell `curl` is an alias for
`Invoke-WebRequest` and these flags fail:

```powershell
$PROJECT_ROOT = (git rev-parse --show-toplevel 2>$null); if (-not $PROJECT_ROOT) { $PROJECT_ROOT = (Get-Location).Path }
curl.exe --fail-with-body -sS -X POST --get --data-urlencode "folderPath=$PROJECT_ROOT" http://127.0.0.1:3001/api/project-memory/pull
```

If the AgentsToZ_byCS API is not running, skip the pull and say so — never guess the
memory contents or retry in a loop.
