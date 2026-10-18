import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const script = readFileSync(new URL('../scripts/install-api-launch-agent.sh', import.meta.url), 'utf8');

describe('AgentsToZ API launch agent', () => {
  test('installs a login-persistent launchd service for the API only', () => {
    expect(script).toContain('com.agentstoz.api');
    expect(script).toContain('RunAtLoad');
    expect(script).toContain('KeepAlive');
    expect(script).toContain('api-server.ts');
    expect(script).toContain('WorkingDirectory');
    expect(script).toContain('launchctl bootstrap');
  });

  test('does not kill an unrelated listener occupying port 3001', () => {
    expect(script).toContain('AGENTSTOZ_API_PORT_OCCUPIED');
    expect(script).toContain('working directory');
  });
});
