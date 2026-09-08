import { describe, expect, test } from 'bun:test';
import { resolvePortalOAuthRedirect } from '../src/portalOAuthRedirect';

describe('portal OAuth return path', () => {
  test('keeps the source portal entrypoint without query or fragment', () => {
    expect(resolvePortalOAuthRedirect('http://127.0.0.1:9000', '/portal.html', true))
      .toBe('http://127.0.0.1:9000/portal.html');
  });

  test('keeps the deployed portal callback on its canonical root', () => {
    expect(resolvePortalOAuthRedirect('https://portal.example', '/portal.html', false))
      .toBe('https://portal.example/');
  });
});
