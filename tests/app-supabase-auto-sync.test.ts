import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');

describe('desktop automatic Supabase synchronization gate', () => {
  test('does not enable Push after a Pull query or workspace-root query fails', () => {
    expect(app).toContain('let supabaseAutoSyncReady = true;');
    expect(app).toContain('if (error) throw error;');
    expect(app).toContain('if (rootError) throw rootError;');
    expect(app).toContain('supabaseAutoSyncReady = false;');
    expect(app).toContain('autopushReady.current = supabaseAutoSyncReady;');
    expect(app).toContain('Supabase 자동 동기화를 중단했습니다:');
  });

  test('makes a later automatic Push failure visible and closes the gate', () => {
    const failure = app.slice(
      app.indexOf("console.warn('[App] Auto-push failed:'"),
      app.indexOf('}, 3000);', app.indexOf("console.warn('[App] Auto-push failed:'")),
    );
    expect(failure).toContain('autopushReady.current = false;');
    expect(failure).toContain('Supabase 자동 Push를 중단했습니다:');
    expect(failure).toContain('describeSupabaseError(e)');
  });
});
