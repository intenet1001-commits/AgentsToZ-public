import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

test("project memory UI exposes Hermes and an editable mention alias", () => {
  const panel = readFileSync(join(import.meta.dir, "..", "src", "ProjectMemoryPanel.tsx"), "utf8");
  const directory = readFileSync(join(import.meta.dir, "..", "src", "PortalMemoryDirectory.tsx"), "utf8");
  const server = readFileSync(join(import.meta.dir, "..", "api-server.ts"), "utf8");
  expect(panel).not.toContain('<option value="hermes">Hermes</option>');
  expect(directory).toContain('mentionAlias');
  expect(directory).toContain('/api/project-memory/mentions/save');
  expect(directory).toContain(".from('portmgr_project_memory_mentions')");
  expect(directory).toContain("mentionAliases[entry.memoryId]");
  expect(directory).toContain('#{editingLabel.mentionAlias}');
  expect(server).toContain('const normalizedAlias = normalizeMentionAlias(body.alias);');
  expect(server).not.toContain('/[^\\x00-\\x7f]/.test(body.alias)');

  // Validate/reserve the mention first, so a rejected Korean alias cannot
  // leave only the display label committed. A later label failure is named as
  // a recoverable partial success and retrying is idempotent.
  const save = directory.slice(directory.indexOf('const saveMemoryLabel = async () =>'));
  expect(save.indexOf('/api/project-memory/mentions/save')).toBeLessThan(save.indexOf(".from('portmgr_project_memory_labels').upsert"));
  expect(save).toContain('let mentionSaved = false;');
  expect(save).toContain('Hermes mention alias는 저장됐지만 표시 별칭 저장에 실패했습니다.');
  expect(directory).toContain('className="min-h-11 px-4 py-2 text-xs text-zinc-400');
  expect(directory).toContain('className="min-h-11 px-4 py-2 text-xs text-[var(--text-on-accent)]');
});
