import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  canOpenRegisteredPort,
  projectExecutionKind,
  runningStateAfterReload,
  shouldAutoDetectProjectStart,
} from '../src/projectExecution';

const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const rustSource = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');

describe('project execution model', () => {
  test('always auto-detects inside a worktree even when a legacy main launcher remains', () => {
    const target = {
      folderPath: '/repo/worktrees/feature',
      worktreePath: '/repo/worktrees/feature',
      commandPath: '/repo/main/실행.command',
      terminalCommand: 'bun run main-only',
      port: 19000,
    };

    expect(shouldAutoDetectProjectStart(target)).toBe(true);
    expect(projectExecutionKind(target)).toBe('worktree-auto');
  });

  test('distinguishes explicit launchers from folder auto-detection', () => {
    expect(projectExecutionKind({ folderPath: '/repo', terminalCommand: 'bun run dev' }))
      .toBe('terminal-command');
    expect(projectExecutionKind({ folderPath: '/repo', commandPath: '/repo/run.command' }))
      .toBe('command-file');
    expect(projectExecutionKind({ folderPath: '/repo', port: 9000 }))
      .toBe('folder-auto');
  });

  test('keeps a registered localhost address openable even before the listener is observed', () => {
    expect(canOpenRegisteredPort({ port: 9000 })).toBe(true);
    expect(canOpenRegisteredPort({})).toBe(false);
  });

  test('does not revive an unverifiable portless process from persisted state', () => {
    expect(runningStateAfterReload({ isRunning: true })).toBe(false);
    expect(runningStateAfterReload({ port: 9000, isRunning: true })).toBe(true);
    expect(runningStateAfterReload({ port: 9000, isRunning: false })).toBe(false);
  });

  test('uses the same localhost gate on cards as the sidebar and detail views', () => {
    expect(appSource).toContain('data-testid="card-open-localhost"');
    expect(appSource).toContain('disabled={!canOpenLocalhost}');
    expect(appSource).toContain("if (canOpenLocalhost) void openBrowserWithDiagnostics");
  });

  test('exposes separate process and localhost controls in project and worktree views', () => {
    expect(appSource).toContain('data-testid="sidebar-run-stop"');
    expect(appSource).toContain('data-testid="sidebar-open-localhost"');
    expect(appSource).toContain('data-testid="worktree-auto-run-stop"');
    expect(appSource).toContain('data-testid="worktree-open-localhost"');
    expect(appSource).toContain("shouldAutoDetectProjectStart(item)");
  });

  test('keeps Windows desktop raw-command execution available and injects the port', () => {
    expect(rustSource).not.toContain('.command 파일 실행은 Windows에서 지원되지 않습니다');
    expect(rustSource).toContain('let plan = windows_command_plan(args.command_path, args.is_file_path, args.folder_path)');
    expect(rustSource).toContain('let supervisor = windows_supervisor_plan(');
    expect(rustSource).toContain('&plan.program,');
    expect(rustSource).toContain('&plan.args,');
    expect(rustSource).toContain('"Start-Process -FilePath $env:AGENTSTOZ_COMMAND_FILE -Wait -NoNewWindow".to_string()');
    expect(rustSource).toContain('cmd.env("AGENTSTOZ_WORK_DIR", work_dir)');
    expect(rustSource).toContain('apply_spawn_port_env(&mut cmd, args.port)');
    expect(rustSource).toContain('command.env(key, value)');
    expect(rustSource).toContain('include_str!("../../tests/fixtures/spawn-port-env-golden.json")');
  });
});
