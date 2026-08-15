import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  canOpenRegisteredPort,
  projectExecutionKind,
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

  test('only enables localhost access for a registered listening port', () => {
    expect(canOpenRegisteredPort({ port: 9000 }, false)).toBe(false);
    expect(canOpenRegisteredPort({ port: 9000 }, true)).toBe(true);
    expect(canOpenRegisteredPort({}, true)).toBe(false);
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
