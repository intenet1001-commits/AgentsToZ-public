import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');

describe('project toolbar Supabase controls', () => {
  test('project Push and Pull remain wired to their handlers with explicit labels', () => {
    expect(app).toContain('data-testid="ports-supabase-push"');
    expect(app).toContain('onClick={handlePushToSupabase}');
    expect(app).toContain('>Supabase Push</span>');
    expect(app).toContain('data-testid="ports-supabase-pull"');
    expect(app).toContain('onClick={handleRestoreFromSupabase}');
    expect(app).toContain('>Supabase Pull</span>');
  });

  test('desktop toolbar action group wraps instead of pushing controls off-screen', () => {
    expect(app).toContain('data-testid="top-toolbar-project-actions"');
    expect(app).toContain("isMobile ? 'flex items-center gap-2' : 'flex min-w-0 flex-wrap items-center gap-2'");
    // .ui-toolbar-scroll > * has flex-shrink: 0; an inline override is required for
    // this child to become viewport-width and let its own flex-wrap take effect.
    expect(app).toContain("style={isMobile ? undefined : { flexShrink: 1, maxWidth: '100%' }}");
  });
});
