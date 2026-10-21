import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { pickCommandLauncher } from '../src/startCommandDetection';

const rustSource = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');

describe('root platform launcher detection', () => {
  test('picks the launcher of a project whose runnable parts live in subfolders', () => {
    // ShadowLoop, verbatim: no manifest at the root, one launcher beside it.
    const files = ['.gitignore', 'AGENTS.md', 'DESIGN.md', 'README.md', 'backend', 'frontend', 'supabase', '실행.command'];
    expect(pickCommandLauncher(files, 'unix')).toEqual({ fileName: '실행.command', reason: 'single' });
  });

  test('ignores the helper this app installs', () => {
    expect(pickCommandLauncher(['포트에추가.command'], 'unix')).toMatchObject({ fileName: null, reason: 'none' });
    expect(pickCommandLauncher(['실행.command', '포트에추가.command'], 'unix'))
      .toEqual({ fileName: '실행.command', reason: 'single' });
  });

  test('breaks a tie only on a name that reads as a start command', () => {
    expect(pickCommandLauncher(['실행.command', 'backup.command'], 'unix'))
      .toEqual({ fileName: '실행.command', reason: 'conventional' });
    expect(pickCommandLauncher(['start-dev.command', 'notes.command'], 'unix'))
      .toMatchObject({ reason: 'conventional' });
  });

  test('refuses to guess when several could be the start command', () => {
    // Starting the wrong one is worse than saying nothing was found.
    expect(pickCommandLauncher(['start.command', 'run.command'], 'unix'))
      .toEqual({ fileName: null, reason: 'ambiguous' });
    expect(pickCommandLauncher(['a.command', 'b.command'], 'unix'))
      .toEqual({ fileName: null, reason: 'ambiguous' });
  });

  test('says nothing when there is no launcher at all', () => {
    expect(pickCommandLauncher(['package.json', 'src'], 'unix')).toEqual({ fileName: null, reason: 'none' });
    expect(pickCommandLauncher([], 'unix')).toEqual({ fileName: null, reason: 'none' });
  });

  test('uses Windows-native launchers and never auto-selects an unusable .command file', () => {
    expect(pickCommandLauncher(['실행.cmd', '실행.command'], 'win32'))
      .toEqual({ fileName: '실행.cmd', reason: 'single' });
    expect(pickCommandLauncher(['start.ps1', 'notes.txt'], 'win32'))
      .toEqual({ fileName: 'start.ps1', reason: 'single' });
  });

  test('the Tauri command applies the same fallback', () => {
    // The packaged app detects through Rust, so a fix in only one of them would
    // work in the browser and fail in the app.
    expect(rustSource).toContain('fn pick_command_launcher(dir: &std::path::Path)');
    expect(rustSource).toContain('if let Some(name) = pick_command_launcher(path)');
    // Manifests must still win: the fallback sits after the Cargo.toml branch.
    expect(rustSource.indexOf('fn pick_command_launcher'))
      .toBeGreaterThan(rustSource.indexOf('"cargo run".to_string()'));
  });
});
