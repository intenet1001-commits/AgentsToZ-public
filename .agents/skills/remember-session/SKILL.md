---
name: remember-session
description: Save durable learnings from the current project session to local long-term memory and optionally back them up to Supabase. Use when the user says 세션 기억하기, 세션 기억해줘, 작업 내용 기억해줘, session memory, 세션 종료, or 작업 마무리.
---

<!-- AgentsToZ memory-agent-version:19 -->
# 세션 기억하기

## Goal

Remember the session without closing the current terminal. The local memory write is
authoritative; the Supabase backup is a recoverable follow-up and must not undo it.

## Procedure

1. Resolve the current project root and its canonical memory root:

```bash
WORKING_ROOT="$(pwd -P)"
PROJECT_TOP="$(git -C "$WORKING_ROOT" rev-parse --show-toplevel 2>/dev/null || true)"
MEMORY_SUBPATH=''
if [ -n "$PROJECT_TOP" ]; then
  MAIN_TOP="$(git -C "$PROJECT_TOP" worktree list --porcelain 2>/dev/null | sed -n 's/^worktree //p' | head -n 1)"
  [ -n "$MAIN_TOP" ] || { echo "Canonical project worktree is unavailable" >&2; exit 1; }
  MEMORY_ROOT="$MAIN_TOP"
  [ -z "$MEMORY_SUBPATH" ] || MEMORY_ROOT="$MAIN_TOP/$MEMORY_SUBPATH"
else
  MEMORY_ROOT="$WORKING_ROOT"
fi
if [ ! -f "$MEMORY_ROOT/.agent-memory/config.json" ]; then
  echo "Canonical project memory is unavailable: $MEMORY_ROOT/.agent-memory/config.json" >&2
  exit 1
fi
```

Windows PowerShell:
```powershell
$WORKING_ROOT = (Get-Location).Path
$PROJECT_TOP = (git -C $WORKING_ROOT rev-parse --show-toplevel 2>$null)
$MEMORY_SUBPATH = ''
if ($PROJECT_TOP) {
  $FIRST_WORKTREE = (git -C $PROJECT_TOP worktree list --porcelain 2>$null | Select-String '^worktree ' | Select-Object -First 1)
  if (-not $FIRST_WORKTREE) { throw 'Canonical project worktree is unavailable' }
  $MEMORY_ROOT = $FIRST_WORKTREE.Line.Substring(9).Trim()
  if ($MEMORY_SUBPATH) { $MEMORY_ROOT = Join-Path $MEMORY_ROOT $MEMORY_SUBPATH }
} else {
  $MEMORY_ROOT = $WORKING_ROOT
}
if (-not (Test-Path -LiteralPath (Join-Path $MEMORY_ROOT '.agent-memory/config.json'))) {
  throw "Canonical project memory is unavailable: $MEMORY_ROOT/.agent-memory/config.json"
}
```

   The first Git porcelain worktree is the single memory authority. If its config is
   unavailable, stop without creating or updating a linked-worktree fallback.

2. Read `$MEMORY_ROOT/.agent-memory/config.json`, then read its project-relative
   `sourcePath` from `$MEMORY_ROOT`.

   If `.agent-memory/notes/manifest.json` exists, the memory is split: `sourcePath` is a
   generated index of entry titles and the bodies live in `.agent-memory/notes/`. Read the
   index, then open only the notes you are going to change. **Write to the notes, never to the
   index** — the index is regenerated from them and any hand edit to it is lost.
3. If `config.autoBackup` is not `false`, Pull before editing:

```bash
WORKING_ROOT="$(pwd -P)"
PROJECT_TOP="$(git -C "$WORKING_ROOT" rev-parse --show-toplevel 2>/dev/null || true)"
MEMORY_SUBPATH=''
if [ -n "$PROJECT_TOP" ]; then
  MAIN_TOP="$(git -C "$PROJECT_TOP" worktree list --porcelain 2>/dev/null | sed -n 's/^worktree //p' | head -n 1)"
  [ -n "$MAIN_TOP" ] || { echo "Canonical project worktree is unavailable" >&2; exit 1; }
  MEMORY_ROOT="$MAIN_TOP"
  [ -z "$MEMORY_SUBPATH" ] || MEMORY_ROOT="$MAIN_TOP/$MEMORY_SUBPATH"
else
  MEMORY_ROOT="$WORKING_ROOT"
fi
if [ ! -f "$MEMORY_ROOT/.agent-memory/config.json" ]; then
  echo "Canonical project memory is unavailable: $MEMORY_ROOT/.agent-memory/config.json" >&2
  exit 1
fi
agentstoz_api_ready() {
  AGENTSTOZ_HEALTH="$(curl --max-time 2 --fail -sS http://127.0.0.1:3001/api/health 2>/dev/null)" || return 1
  printf '%s' "$AGENTSTOZ_HEALTH" | grep -Fq '"service":"agentstoz-api"' || return 1
  printf '%s' "$AGENTSTOZ_HEALTH" | grep -Fq '"project-memory.recall"'
}
if ! agentstoz_api_ready; then
  AGENTSTOZ_APP=/Applications/AgentsToZ_byCS.app
  if [ "$(uname -s 2>/dev/null)" = Darwin ] && [ -d "$AGENTSTOZ_APP" ]; then
    /usr/bin/open -gj "$AGENTSTOZ_APP" >/dev/null 2>&1 || true
    AGENTSTOZ_STARTUP_REMAINING=20
    while [ "$AGENTSTOZ_STARTUP_REMAINING" -gt 0 ] && ! agentstoz_api_ready; do
      sleep 1
      AGENTSTOZ_STARTUP_REMAINING=$((AGENTSTOZ_STARTUP_REMAINING - 1))
    done
  fi
fi
if agentstoz_api_ready; then
  curl --fail-with-body -sS -X POST --get --data-urlencode "folderPath=$MEMORY_ROOT" \
    http://127.0.0.1:3001/api/project-memory/pull
else
  echo "AgentsToZ local API unavailable after the bounded app-start attempt; skipping remote Pull" >&2
fi
```

   On macOS, a missing local API now opens only the exact installed
   `/Applications/AgentsToZ_byCS.app` in the background and performs one bounded
   20-second startup readiness wait. This is not a sync retry: never loop on Pull, Push,
   HTTP 409, or another server occupying port 3001. On other platforms, or when the exact
   installed app is absent, continue with the authoritative local save and report backup
   as retry needed.

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
WORKING_ROOT="$(pwd -P)"
PROJECT_TOP="$(git -C "$WORKING_ROOT" rev-parse --show-toplevel 2>/dev/null || true)"
MEMORY_SUBPATH=''
if [ -n "$PROJECT_TOP" ]; then
  MAIN_TOP="$(git -C "$PROJECT_TOP" worktree list --porcelain 2>/dev/null | sed -n 's/^worktree //p' | head -n 1)"
  [ -n "$MAIN_TOP" ] || { echo "Canonical project worktree is unavailable" >&2; exit 1; }
  MEMORY_ROOT="$MAIN_TOP"
  [ -z "$MEMORY_SUBPATH" ] || MEMORY_ROOT="$MAIN_TOP/$MEMORY_SUBPATH"
else
  MEMORY_ROOT="$WORKING_ROOT"
fi
if [ ! -f "$MEMORY_ROOT/.agent-memory/config.json" ]; then
  echo "Canonical project memory is unavailable: $MEMORY_ROOT/.agent-memory/config.json" >&2
  exit 1
fi
curl --fail-with-body -sS -X POST --get --data-urlencode "folderPath=$MEMORY_ROOT" \
  --data-urlencode "narrative=해시 기반 동기화 판정으로 교체 — 타임스탬프는 Push가 항상 나중이라 pull을 잘못 권했음" \
  http://127.0.0.1:3001/api/project-memory/mark-remembered
```

8. If and only if `config.autoBackup` is not `false`, back up the local memory:

```bash
WORKING_ROOT="$(pwd -P)"
PROJECT_TOP="$(git -C "$WORKING_ROOT" rev-parse --show-toplevel 2>/dev/null || true)"
MEMORY_SUBPATH=''
if [ -n "$PROJECT_TOP" ]; then
  MAIN_TOP="$(git -C "$PROJECT_TOP" worktree list --porcelain 2>/dev/null | sed -n 's/^worktree //p' | head -n 1)"
  [ -n "$MAIN_TOP" ] || { echo "Canonical project worktree is unavailable" >&2; exit 1; }
  MEMORY_ROOT="$MAIN_TOP"
  [ -z "$MEMORY_SUBPATH" ] || MEMORY_ROOT="$MAIN_TOP/$MEMORY_SUBPATH"
else
  MEMORY_ROOT="$WORKING_ROOT"
fi
if [ ! -f "$MEMORY_ROOT/.agent-memory/config.json" ]; then
  echo "Canonical project memory is unavailable: $MEMORY_ROOT/.agent-memory/config.json" >&2
  exit 1
fi
curl --fail-with-body -sS -X POST --get --data-urlencode "folderPath=$MEMORY_ROOT" \
  http://127.0.0.1:3001/api/project-memory/push
```

If `config.autoBackup` is `false`, skip Push and report that Supabase backup was skipped by
project policy. On Windows PowerShell, run the same calls with `curl.exe`. Plain `curl` is an alias
for `Invoke-WebRequest` there, so these flags fail:

```powershell
$WORKING_ROOT = (Get-Location).Path
$PROJECT_TOP = (git -C $WORKING_ROOT rev-parse --show-toplevel 2>$null)
$MEMORY_SUBPATH = ''
if ($PROJECT_TOP) {
  $FIRST_WORKTREE = (git -C $PROJECT_TOP worktree list --porcelain 2>$null | Select-String '^worktree ' | Select-Object -First 1)
  if (-not $FIRST_WORKTREE) { throw 'Canonical project worktree is unavailable' }
  $MEMORY_ROOT = $FIRST_WORKTREE.Line.Substring(9).Trim()
  if ($MEMORY_SUBPATH) { $MEMORY_ROOT = Join-Path $MEMORY_ROOT $MEMORY_SUBPATH }
} else {
  $MEMORY_ROOT = $WORKING_ROOT
}
if (-not (Test-Path -LiteralPath (Join-Path $MEMORY_ROOT '.agent-memory/config.json'))) {
  throw "Canonical project memory is unavailable: $MEMORY_ROOT/.agent-memory/config.json"
}
curl.exe --fail-with-body -sS -X POST --get --data-urlencode "folderPath=$MEMORY_ROOT" --data-urlencode "narrative=<이번 세션에서 배운 것 한두 문장>" http://127.0.0.1:3001/api/project-memory/mark-remembered
curl.exe --fail-with-body -sS -X POST --get --data-urlencode "folderPath=$MEMORY_ROOT" http://127.0.0.1:3001/api/project-memory/push
```

9. Report these two results separately:
   - local memory: saved / failed;
   - Supabase backup: saved / retry needed.

If the AgentsToZ_byCS API remains unavailable after the exact bounded startup attempt, do
not retry in a loop. Keep the local memory and tell the user that the Push button can upload
it later. Report this as `local memory: saved` and `Supabase backup: retry needed`, not as
a failed remember-session operation.
