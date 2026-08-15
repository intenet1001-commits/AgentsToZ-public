import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const apiSource = readFileSync(new URL('../api-server.ts', import.meta.url), 'utf8');
const tauriSource = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');

describe('Orca Floating agent tab reuse', () => {
  test('passes the explicit new-window intent through the Claude and Agent View paths', () => {
    expect(appSource).toContain('newWindow,');
    expect(appSource).toContain("return openClaudeBg(item, context.worktreePath, isNew);");
    expect(appSource).toContain("return openOrcaAgent('claude', item, context.worktreePath, isNew);");
    expect(appSource).toContain("return callOrca('agents', item, context.worktreePath, newWindow);");
  });

  test('uses a verified persisted handle before title matching and fails closed when Orca is unavailable', () => {
    expect(apiSource).toContain('findExistingOrcaFloatingTerminal');
    expect(apiSource).toContain("'terminal', 'list'");
    expect(apiSource).toContain("'terminal', 'show'");
    expect(apiSource).toContain('verifyRememberedOrcaFloatingTerminal');
    expect(apiSource).toContain('orca-floating-terminals.json');
    expect(apiSource).toContain('새 탭을 만들지 않았습니다');
    expect(apiSource).toContain('isOrcaManagedFloatingTerminal(record.title, agent, folderPath)');
    expect(apiSource).toContain('if (floating && newWindow !== true)');
    expect(apiSource).toContain('reused: true');
    expect(apiSource).toContain('reused: false');
    expect(tauriSource).toContain('fn find_existing_orca_floating_terminal');
    expect(tauriSource).toContain('validate_remembered_orca_floating_terminal');
    expect(tauriSource).toContain('orca-floating-terminals.json');
    expect(tauriSource).toContain('&["terminal", "show", "--terminal", handle]');
    expect(tauriSource).toContain('if use_floating && !force_new_window');
    expect(tauriSource).toContain('기존 {} 탭을 재사용했습니다');
  });
});
