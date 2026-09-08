import { test, expect } from 'bun:test'

const API = 'http://127.0.0.1:3001'

test('api-server health', async () => {
  const r = await fetch(`${API}/api/ports`)
  expect(r.status).toBe(200)
})

// git-commit-message calls Claude CLI (up to 30s). We abort early but check it's not ENOENT.
test('resolveClaudePath works (no ENOENT)', async () => {
  const controller = new AbortController()
  // Abort after 8s — just enough to catch instant ENOENT errors, but before Claude finishes
  const tid = setTimeout(() => controller.abort(), 8000)
  let data: any = {}
  let status = 0
  try {
    const body = JSON.stringify({ worktreePath: 'C:/Windows/System32/portmanagement' })
    const r = await fetch(`${API}/api/git-commit-message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: controller.signal,
    })
    status = r.status
    data = await r.json()
    clearTimeout(tid)
  } catch (e: any) {
    clearTimeout(tid)
    if (e.name === 'AbortError') {
      // Still waiting on Claude = no ENOENT crash = pass
      return
    }
    throw e
  }
  // If we get a fast response it must NOT be ENOENT
  expect(data.error ?? '').not.toContain('ENOENT')
  expect(data.error ?? '').not.toContain('uv_spawn')
  // Fast 503 is ok (CLAUDE_PATH not found reported cleanly), 200/400/500 are all acceptable
  expect([200, 400, 500, 503]).toContain(status)
}, 15000)

test('session-end no longer ENAMETOOLONG', async () => {
  const body = JSON.stringify({
    folderPath: 'C:/Windows/System32/portmanagement',
    projectName: 'portmanagement',
    agent: 'claude',
    autoBackup: false,
  })
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 10000)
  let data: any = {}
  try {
    const r = await fetch(`${API}/api/project-memory/session-end`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: controller.signal,
    })
    data = await r.json()
  } catch (e: any) {
    clearTimeout(timeoutId)
    if (e.name !== 'AbortError') throw e
    // AbortError = timeout = claude is running (good — not instant ENAMETOOLONG)
    return
  }
  clearTimeout(timeoutId)
  expect(data.error ?? '').not.toContain('ENAMETOOLONG')
  expect(data.error ?? '').not.toContain('uv_spawn')
}, 15000)

test('open-terminal-at-folder endpoint exists', async () => {
  const r = await fetch(`${API}/api/open-terminal-at-folder`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: 'C:/Windows/System32/portmanagement' }),
  })
  // Should not crash with 500/ENAMETOOLONG; 200 or 400 acceptable
  expect(r.status).not.toBe(500)
}, 10000)
