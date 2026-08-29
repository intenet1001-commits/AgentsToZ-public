---
name: remember-session
description: Save durable learnings from the current project session to local long-term memory and optionally back them up to Supabase. Use when the user says 세션 기억하기, 세션 기억해줘, 작업 내용 기억해줘, session memory, 세션 종료, or 작업 마무리.
---

<!-- AgentsToZ memory-agent-version:14 -->
# 세션 기억하기

## Goal

Remember the session without closing the current terminal. The local memory write is
authoritative; the Supabase backup is a recoverable follow-up and must not undo it.

## Procedure

1. Resolve the project root:

```bash
PROJECT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
```

Windows PowerShell:
```powershell
$PROJECT_ROOT = (git rev-parse --show-toplevel 2>$null); if (-not $PROJECT_ROOT) { $PROJECT_ROOT = (Get-Location).Path }
```

2. Read `$PROJECT_ROOT/.agent-memory/config.json`, then read its project-relative
   `sourcePath`. If either is missing, tell the user to enable project memory once
   from AgentsToZ_byCS instead of inventing a storage location.

   If `.agent-memory/notes/manifest.json` exists, the memory is split: `sourcePath` is a
   generated index of entry titles and the bodies live in `.agent-memory/notes/`. Read the
   index, then open only the notes you are going to change. **Write to the notes, never to the
   index** — the index is regenerated from them and any hand edit to it is lost.
3. If `config.autoBackup` is not `false`, Pull before editing:

```bash
curl --fail-with-body -sS -X POST --get --data-urlencode "folderPath=$PROJECT_ROOT" \
  http://127.0.0.1:3001/api/project-memory/pull
```

   On conflict/HTTP 409, do not edit, overwrite, force, or retry. Preserve the JSON body,
   report the conflict, and stop. If no remote backup exists, continue with local memory.
   If `config.autoBackup` is `false`, skip this network step by policy.
4. Review the current session plus recent `git status --short`, `git diff --stat`,
   `git diff`, and `git log -10`. Include linked worktrees when they contain changes.
5. Update the memory file with durable information only:
   - decisions and rationale;
   - stable constraints;
   - repeated issues with root cause and workaround;
   - validated project-specific workflows.
   - Every durable `###` entry has `<!-- memory-entry-id:<24 lowercase hex> -->`
     immediately after its heading. Never remove or regenerate an existing entry ID when
     renaming its title or moving it to another section. New unrelated entries need new IDs.
   - Keep each section at or under 12000 bytes (an undivided file at or under
     42000 bytes). Size is what makes "세션 기억하기" slow, and a single oversized
     section is what forces the split. When an addition would exceed that, merge or compress
     older entries in the same section instead of growing it. Merge a superseded decision into
     the entry that replaced it; never delete a durable decision outright.
6. Never store secrets, tokens, environment values, raw chat logs, or temporary status.
   Preserve existing decisions and put contradictions under Contested Entries.
7. After the local file is safely written, mark the current project/worktree activity as
   remembered. This is local metadata only and does not call an AI.

   Pass `narrative`: one or two sentences on **what was learned or decided** this session —
   not what files changed, which the journal already records from git. You are the only one
   who has this; it costs nothing because you already hold it, and it is the difference
   between an append-only history that can be compiled into knowledge later and a list of
   commit subjects. Write it in the user's language. Omit it only if nothing durable happened.

```bash
curl --fail-with-body -sS -X POST --get --data-urlencode "folderPath=$PROJECT_ROOT" \
  --data-urlencode "narrative=해시 기반 동기화 판정으로 교체 — 타임스탬프는 Push가 항상 나중이라 pull을 잘못 권했음" \
  http://127.0.0.1:3001/api/project-memory/mark-remembered
```

8. If and only if `config.autoBackup` is not `false`, back up the local memory:

```bash
curl --fail-with-body -sS -X POST --get --data-urlencode "folderPath=$PROJECT_ROOT" \
  http://127.0.0.1:3001/api/project-memory/push
```

If `config.autoBackup` is `false`, skip Push and report that Supabase backup was skipped by
project policy. On Windows PowerShell, run the same calls with `curl.exe`. Plain `curl` is an alias
for `Invoke-WebRequest` there, so these flags fail:

```powershell
$PROJECT_ROOT = (git rev-parse --show-toplevel 2>$null); if (-not $PROJECT_ROOT) { $PROJECT_ROOT = (Get-Location).Path }
curl.exe --fail-with-body -sS -X POST --get --data-urlencode "folderPath=$PROJECT_ROOT" --data-urlencode "narrative=<이번 세션에서 배운 것 한두 문장>" http://127.0.0.1:3001/api/project-memory/mark-remembered
curl.exe --fail-with-body -sS -X POST --get --data-urlencode "folderPath=$PROJECT_ROOT" http://127.0.0.1:3001/api/project-memory/push
```

9. Report these two results separately:
   - local memory: saved / failed;
   - Supabase backup: saved / retry needed.

If the AgentsToZ_byCS API is not running, do not retry in a loop. Keep the local memory
and tell the user that the Push button can upload it later.
