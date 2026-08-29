import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HERMES_SKILLS_DIR_REL,
  hermesExternalDirRegistered,
  hermesMemoryMenuPluginEnabled,
  HERMES_POST_INSTALL_HINT,
  hermesPendingWork,
  hermesTelegramMenuCommandCap,
  parseHermesProjectMemorySkillVersion,
  stampHermesSkill,
  withHermesExternalDir,
} from '../src/hermesProjectMemoryAdapter';
import { CURRENT_PROJECT_MEMORY_VERSION } from '../src/projectMemoryVersion';

const HOME = '/Users/tester/.hermes';
const TEMPLATE_DIR = fileURLToPath(new URL('../templates/hermes', import.meta.url));

describe('Hermes skills installed from the repository templates', () => {
  // 설치기가 스킬 본문의 사본을 들면 템플릿이 개선돼도 설치된 쪽은 옛 문구를 쓴다.
  // 정본은 templates/hermes 하나뿐이어야 한다.
  test('every template ships a SKILL.md the installer can copy', () => {
    const names = readdirSync(TEMPLATE_DIR, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && existsSync(join(TEMPLATE_DIR, entry.name, 'SKILL.md')))
      .map(entry => entry.name);
    expect(names.length).toBeGreaterThan(0);
    expect(names).toContain('remember-session');
    expect(names).not.toContain('remember');
    expect(names).toContain('memory-link');
    for (const name of names) {
      expect(readFileSync(join(TEMPLATE_DIR, name, 'SKILL.md'), 'utf8').startsWith('---\n')).toBe(true);
    }
  });

  // Hermes 는 frontmatter 의 `name` 으로 슬래시 명령을 만든다. 마커를 머리말 위에 얹으면
  // 그 파싱이 깨져 명령이 통째로 사라진다.
  test('stamps the version without breaking the frontmatter', () => {
    const template = readFileSync(join(TEMPLATE_DIR, 'remember-session', 'SKILL.md'), 'utf8');
    const stamped = stampHermesSkill(template);
    expect(stamped.startsWith('---\n')).toBe(true);
    expect(stamped).toContain('name: remember-session');
    expect(stamped).toContain(`<!-- AgentsToZ memory-agent-version:${CURRENT_PROJECT_MEMORY_VERSION} -->`);
    expect(parseHermesProjectMemorySkillVersion(stamped)).toBe(CURRENT_PROJECT_MEMORY_VERSION);
    // 본문은 템플릿 그대로여야 한다 — 마커 줄만 늘어난다.
    expect(stamped.replace(/<!-- AgentsToZ memory-agent-version:\d+ -->\n\n?/, '')).toBe(template);
  });

  test('re-stamping an installed skill does not stack markers', () => {
    const template = readFileSync(join(TEMPLATE_DIR, 'remember-session', 'SKILL.md'), 'utf8');
    const once = stampHermesSkill(template);
    expect(stampHermesSkill(once)).toBe(once);
    expect(stampHermesSkill(once, 3)).toContain('memory-agent-version:3');
  });

  test('treats a missing or foreign file as not installed', () => {
    expect(parseHermesProjectMemorySkillVersion(null)).toBe(0);
    expect(parseHermesProjectMemorySkillVersion('# someone else\n')).toBe(0);
  });
});

describe('skills.external_dirs registration', () => {
  // A skill file Hermes never scans is the same as no command at all, so the
  // config edit is half the install — not an optional extra.
  test('detects our directory in the forms Hermes accepts', () => {
    expect(hermesExternalDirRegistered(`skills:\n  external_dirs:\n    - ${HERMES_SKILLS_DIR_REL}\n`, HOME)).toBe(true);
    expect(hermesExternalDirRegistered(`skills:\n  external_dirs:\n    - ${HOME}/${HERMES_SKILLS_DIR_REL}\n`, HOME)).toBe(true);
    expect(hermesExternalDirRegistered(`skills:\n  external_dirs: [${HERMES_SKILLS_DIR_REL}]\n`, HOME)).toBe(true);
    expect(hermesExternalDirRegistered('skills:\n  creation_nudge_interval: 15\n', HOME)).toBe(false);
    expect(hermesExternalDirRegistered('agent:\n  max_turns: 500\n', HOME)).toBe(false);
  });

  test('never counts an unrelated external dir as ours', () => {
    expect(hermesExternalDirRegistered('skills:\n  external_dirs:\n    - ~/other-skills\n', HOME)).toBe(false);
  });

  // config.yaml is hand-maintained; a YAML round-trip would drop the user's
  // comments and key order, so the edit inserts lines and touches nothing else.
  test('adds the entry to an existing skills block without disturbing it', () => {
    const before = 'gateway:\n  enabled: true\nskills:\n  # 사용자 주석\n  creation_nudge_interval: 15\nagent:\n  max_turns: 500\n';
    const after = withHermesExternalDir(before, HOME);
    expect(after).toContain('  # 사용자 주석');
    expect(after).toContain('  creation_nudge_interval: 15');
    expect(after).toContain(`  external_dirs:\n    - ${HERMES_SKILLS_DIR_REL}`);
    expect(after).toContain('agent:\n  max_turns: 500');
    expect(hermesExternalDirRegistered(after, HOME)).toBe(true);
    // The inserted lines must stay inside `skills:`, above the next top-level key.
    expect(after.indexOf('external_dirs')).toBeLessThan(after.indexOf('agent:'));
  });

  test('is idempotent — a second install changes nothing', () => {
    const once = withHermesExternalDir('skills:\n  creation_nudge_interval: 15\n', HOME);
    expect(withHermesExternalDir(once, HOME)).toBe(once);
  });

  test('appends to an existing list instead of replacing it', () => {
    const after = withHermesExternalDir('skills:\n  external_dirs:\n    - ~/team-skills\n', HOME);
    expect(after).toContain('- ~/team-skills');
    expect(after).toContain(`- ${HERMES_SKILLS_DIR_REL}`);
    expect(hermesExternalDirRegistered(after, HOME)).toBe(true);
  });

  test('handles the empty, inline-list, and scalar spellings', () => {
    for (const before of [
      'skills:\n  external_dirs:\n',
      'skills:\n  external_dirs: []\n',
      'skills:\n  external_dirs: [~/team-skills]\n',
      'skills:\n  external_dirs: ~/team-skills\n',
    ]) {
      const after = withHermesExternalDir(before, HOME);
      expect(hermesExternalDirRegistered(after, HOME)).toBe(true);
    }
    // Promoting a scalar to a list must keep the value that was already there.
    expect(withHermesExternalDir('skills:\n  external_dirs: ~/team-skills\n', HOME)).toContain('- ~/team-skills');
    expect(withHermesExternalDir('skills:\n  external_dirs: [~/team-skills]\n', HOME)).toContain('~/team-skills, ');
  });

  test('creates the skills block when the config has none', () => {
    const after = withHermesExternalDir('agent:\n  max_turns: 500\n', HOME);
    expect(after).toContain('agent:\n  max_turns: 500');
    expect(hermesExternalDirRegistered(after, HOME)).toBe(true);
    expect(withHermesExternalDir('', HOME)).toContain(`    - ${HERMES_SKILLS_DIR_REL}`);
  });

  test('keeps a trailing blank line from swallowing the inserted entry', () => {
    const after = withHermesExternalDir('skills:\n  creation_nudge_interval: 15\n\nagent:\n  max_turns: 500\n', HOME);
    expect(hermesExternalDirRegistered(after, HOME)).toBe(true);
    expect(after).toContain('agent:\n  max_turns: 500');
  });
});

describe('Telegram memory menu plugin registration', () => {
  test('detects the plugin in block, inline, and scalar enabled forms', () => {
    expect(hermesMemoryMenuPluginEnabled('plugins:\n  enabled:\n    - orca-status\n    - agentstoz-memory-menu\n')).toBe(true);
    expect(hermesMemoryMenuPluginEnabled('plugins:\n  enabled: [orca-status, agentstoz-memory-menu]\n')).toBe(true);
    expect(hermesMemoryMenuPluginEnabled('plugins:\n  enabled: agentstoz-memory-menu\n')).toBe(true);
  });

  test('does not confuse another plugin or a disabled entry with enabled', () => {
    expect(hermesMemoryMenuPluginEnabled('plugins:\n  enabled:\n    - orca-status\n')).toBe(false);
    expect(hermesMemoryMenuPluginEnabled('plugins:\n  disabled:\n    - agentstoz-memory-menu\n')).toBe(false);
    expect(hermesMemoryMenuPluginEnabled('agent:\n  max_turns: 500\n')).toBe(false);
  });

  test('reads and bounds the configured Telegram command cap', () => {
    expect(hermesTelegramMenuCommandCap('platforms:\n  telegram:\n    extra:\n      command_menu:\n        max_commands: 100\n')).toBe(100);
    expect(hermesTelegramMenuCommandCap('platforms:\n  telegram:\n    extra:\n      command_menu:\n        max_commands: "60"\n')).toBe(60);
    expect(hermesTelegramMenuCommandCap('platforms:\n  telegram:\n')).toBe(60);
    expect(hermesTelegramMenuCommandCap('platforms:\n  telegram:\n    extra:\n      command_menu:\n        max_commands: 500\n')).toBe(100);
  });
});

describe('install button names the remaining work, not the installed count', () => {
  const complete = {
    hermesPresent: true,
    available: ['a', 'b', 'c'],
    installed: ['a', 'b', 'c'],
    externalDirRegistered: true,
    menuPluginInstalled: true,
    menuPluginEnabled: true,
    menuCommandCap: 100,
    legacyAliasPresent: false,
    installedVersion: CURRENT_PROJECT_MEMORY_VERSION,
    currentVersion: CURRENT_PROJECT_MEMORY_VERSION,
    updateAvailable: false,
  };

  test('a fully installed device shows no button at all', () => {
    expect(hermesPendingWork(complete)).toBeNull();
  });

  test('a device without Hermes is not an install target', () => {
    expect(hermesPendingWork({ ...complete, hermesPresent: false, updateAvailable: true })).toBeNull();
  });

  // 실측으로 나온 상태: 7/7 설치·전부 최신·등록됨인데 버튼이 떠 있었다. 유일하게 남은
  // 일은 레거시 별칭 삭제였는데, 라벨은 "(7/7)"이라 완료로 읽혔다.
  test('a leftover legacy alias is named instead of shown as a count', () => {
    const label = hermesPendingWork({ ...complete, legacyAliasPresent: true, updateAvailable: true });
    expect(label).toBe('레거시 /remember 정리');
  });

  test('each distinct pending state gets its own label', () => {
    expect(hermesPendingWork({ ...complete, installed: ['a'], updateAvailable: true })).toBe('명령 2개 설치');
    expect(hermesPendingWork({ ...complete, installedVersion: 9, currentVersion: 10, updateAvailable: true }))
      .toBe('v9 → v10 업데이트');
    expect(hermesPendingWork({ ...complete, externalDirRegistered: false, updateAvailable: true }))
      .toBe('config.yaml 등록');
    expect(hermesPendingWork({ ...complete, menuPluginInstalled: false, updateAvailable: true }))
      .toBe('Telegram 메뉴 plugin 설치');
    expect(hermesPendingWork({ ...complete, menuPluginEnabled: false, updateAvailable: true }))
      .toBe('Telegram 메뉴 plugin 활성화');
    expect(hermesPendingWork({ ...complete, menuCommandCap: 60, updateAvailable: true }))
      .toBe('Telegram 메뉴 100개 설정');
  });

  // 이미 떠 있던 구버전 sidecar는 legacyAliasPresent를 응답에 담지 않는다. 남은 일을
  // 특정하지 못한다고 해서 갱신 필요 자체를 없던 일로 만들면 안 된다.
  test('an older sidecar that omits the legacy flag still surfaces the button', () => {
    const { legacyAliasPresent, ...withoutFlag } = complete;
    expect(hermesPendingWork({ ...withoutFlag, updateAvailable: true })).toBe('명령 갱신');
  });
});

// 메뉴 plugin의 `__init__.py` 는 스킬과 달리 **버전 마커가 스탬프되지 않고 그대로 복사**된다
// (`installHermesMemoryMenuPlugin`). 그래서 상수만 올리고 이 파일을 잊으면
// `menuPluginInstalled` 가 조용히 false 가 되어 Telegram 메뉴에서 명령이 사라진다.
// 실제로 v12 로 올릴 때 이 상태가 났다.
describe('Telegram menu plugin template', () => {
  const pluginModulePath = join(
    import.meta.dir, '..', 'templates', 'hermes-plugin', 'agentstoz-memory-menu', '__init__.py',
  );

  test('carries the current memory version marker', () => {
    const module = readFileSync(pluginModulePath, 'utf8');
    expect(module).toContain(`AgentsToZ memory-agent-version:${CURRENT_PROJECT_MEMORY_VERSION}`);
  });

  // plugin 에 이름이 없으면 그 명령은 100개 cap 밖으로 밀려 메뉴에서 사라진다.
  test('registers every installed skill so none falls outside the menu cap', () => {
    const module = readFileSync(pluginModulePath, 'utf8');
    const skillsDir = join(import.meta.dir, '..', 'templates', 'hermes');
    const skills = readdirSync(skillsDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && existsSync(join(skillsDir, entry.name, 'SKILL.md')))
      .map(entry => entry.name)
      // 호환 별칭은 메뉴에 띄우지 않는다 — 선호 명령 하나만 보여준다.
      .filter(name => name !== 'memory-stop');
    for (const skill of skills) expect(module).toContain(`"${skill}"`);
  });

  test('registers Telegram wire names while preserving skill fallthrough', () => {
    const module = readFileSync(pluginModulePath, 'utf8');
    expect(module).toContain('wire_name = name.replace("-", "_")');
    expect(module).toContain('ctx.register_command(wire_name, handler=None');
  });
});

// 명령을 깐 직후에 남는 한 걸음(`/reload_skills`)을 알리지 않으면, 사용자는 설치가
// 성공했는데도 Telegram 이 명령을 모르는 상태에 갇힌다 — 실제로 그렇게 몇 시간을 썼다.
// 세 표면이 같은 문구를 써야 한쪽만 고쳐지는 일이 없다.
describe('post-install guidance', () => {
  const read = (rel: string) => readFileSync(join(import.meta.dir, '..', rel), 'utf8');

  test('names the no-downtime path and never tells the user to restart Hermes', () => {
    expect(HERMES_POST_INSTALL_HINT).toContain('/reload_skills');
    // 예전 문구가 "Hermes를 다시 시작하면 나타납니다" 였고, 그것이 사용자를 셸 재시작
    // (Hermes가 차단) 또는 봇을 끊는 /restart 로 보냈다.
    expect(HERMES_POST_INSTALL_HINT).not.toContain('다시 시작');
  });

  // 자동완성이 늦는 것은 Telegram 클라이언트 캐시라 우리가 못 고친다. 그 사실을 적지
  // 않으면 잘 깔린 설치가 고장으로 읽힌다.
  test('says the command still runs when the autocomplete list is stale', () => {
    expect(HERMES_POST_INSTALL_HINT).toContain('직접 입력');
  });

  test('every surface that reports an install uses the one shared string', () => {
    for (const rel of [
      'src/ProjectMemoryPanel.tsx',
      'src/components/BulkUpgradeButton.tsx',
      'api-server.ts',
    ]) {
      expect(read(rel)).toContain('HERMES_POST_INSTALL_HINT');
    }
  });
});
