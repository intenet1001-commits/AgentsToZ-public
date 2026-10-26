import assert from 'node:assert/strict';

/** Local-only reads added by the browser suggestions, Hermes picker and team status strip. Call only
 * after the fixture's origin guard; all other routes still reach its deny list.
 * These sessions belong to no team and use synthetic, ungated Hermes choices.
 */
export function workroomBackgroundResponse(path, method, body) {
  if (path === '/api/ports') {
    assert.equal(method, 'GET', 'Project suggestions permit a GET read only');
    assert.ok(body == null, 'Project suggestions read has no body');
    return [];
  }
  if (!['/api/agent-runtime/hermes-variants', '/api/agent-runtime/workroom-teams'].includes(path)) return null;
  assert.equal(method, 'POST', 'Workroom background fixtures permit POST reads only');
  assert.ok(body && typeof body === 'object' && !Array.isArray(body), 'Background read requires an object');
  if (path === '/api/agent-runtime/hermes-variants') {
    assert.deepEqual(body, {}, 'Hermes availability is a read with no launch or credential arguments');
    return { checked: false, sessions: [], items: [
      { variant: 'claude', provider: 'anthropic', model: 'fixture-claude', available: true },
      { variant: 'codex', provider: 'openai-codex', model: 'fixture-codex', available: true },
    ] };
  }
  assert.deepEqual(Object.keys(body).sort(), ['git', 'sessionId'], 'Team fixture accepts only a session status read');
  assert.equal(typeof body.sessionId, 'string');
  assert.match(body.sessionId, /^[A-Za-z0-9_-]{8,160}$/);
  assert.equal(typeof body.git, 'boolean');
  return { teams: [] };
}
