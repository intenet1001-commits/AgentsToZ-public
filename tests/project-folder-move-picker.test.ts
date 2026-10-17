import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const app = readFileSync(join(import.meta.dir, '..', 'src', 'App.tsx'), 'utf8');

// Moving a project asked the user to type the full destination path by hand, with the
// field pre-filled with the current path. That is the one place a typo silently sends a
// folder somewhere unintended, and the app already owns a folder picker everywhere else
// a path is chosen (workspace roots, project folder). The move dialog should use it too.
describe('project folder move destination', () => {
  const dialog = app.slice(
    app.indexOf('folder-rename-prompt-name'),
    app.indexOf('folder-rename-prompt-name') + 4000,
  );

  test('the move dialog offers a folder picker', () => {
    expect(app).toContain('data-testid="folder-rename-prompt-browse"');
  });

  test('the picker is only offered for a move, not a rename', () => {
    // A rename keeps the parent directory, so browsing for one would be misleading.
    expect(dialog).toContain("folderChangeMode === 'move'");
  });

  test('the picker reuses the existing Tauri/web folder-selection paths', () => {
    const browse = app.slice(
      app.indexOf('const browseForFolderMoveDestination'),
      app.indexOf('const browseForFolderMoveDestination') + 900,
    );
    expect(browse).toContain("directory: true");
    expect(browse).toContain("'/api/pick-folder'");
  });

  test('a chosen parent keeps the folder name instead of overwriting the target', () => {
    // The field wants the FULL destination path including the folder name. Picking a
    // parent directory must append the current leaf, or the move would try to become
    // the selected folder itself and could collide with an unrelated project.
    const browse = app.slice(
      app.indexOf('const browseForFolderMoveDestination'),
      app.indexOf('const browseForFolderMoveDestination') + 900,
    );
    expect(browse).toContain('folderLeafName');
  });
});
