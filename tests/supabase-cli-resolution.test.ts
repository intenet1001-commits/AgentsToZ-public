import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import {
  supabaseCliCandidates,
  supabaseCliLookupCommands,
} from '../project-memory-server';

describe('Supabase CLI resolution', () => {
  test('includes the official Linux installer destination', () => {
    const home = '/tmp/agentstoz-supabase-home';
    expect(supabaseCliCandidates('linux', {}, home)).toContain(
      join(home, '.supabase', 'bin', 'supabase'),
    );
  });

  test('uses platform shells without requiring zsh on Linux', () => {
    expect(supabaseCliLookupCommands('linux')).toEqual([
      ['/bin/bash', '-lc', 'command -v supabase'],
      ['/bin/sh', '-lc', 'command -v supabase'],
    ]);
    expect(supabaseCliLookupCommands('darwin')).toEqual([
      ['/bin/zsh', '-lc', 'command -v supabase'],
      ['/bin/bash', '-lc', 'command -v supabase'],
    ]);
    expect(supabaseCliLookupCommands('win32')).toEqual([
      ['where', 'supabase'],
    ]);
  });
});
