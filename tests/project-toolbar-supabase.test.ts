import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const design = readFileSync(new URL('../src/workspaceDesign.css', import.meta.url), 'utf8');
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
    expect(app).toContain('className="workspace-project-tools"');
    expect(design).toContain('display: flex; flex-wrap: wrap; align-items: center; gap: 8px');
    expect(design).toContain('width: min(400px, calc(var(--ui-viewport-width, 100vw) - 256px))');
  });
});
