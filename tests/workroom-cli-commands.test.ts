import {describe, expect, test} from 'bun:test';
import {cliInfoFromScreen, slashCommandCandidates, slashCommandQuery, WORKROOM_MODEL_COMMANDS} from '../src/workroomCliCommands';

describe('Workroom model/effort from the CLI screen (VOC 2026-09-24, formats checked on live CLIs)', () => {
  test('Claude Code banner and footer', () => {
    expect(cliInfoFromScreen('claude', [
      '▝▜██████▀  Opus 5.5 (1M context) · Claude Max',
      '  테스트해보자[main]                          ◐ medium · /effort',
    ])).toEqual({model: 'Opus 5.5 (1M context)', effort: 'medium'});
    expect(cliInfoFromScreen('claude', ['  ⎿  Set model to Sonnet 5', '  ◑ high · /effort'])).toEqual({model: 'Sonnet 5', effort: 'high'});
  });
  test('Codex header', () => {
    expect(cliInfoFromScreen('codex', ['│ model:       GPT-6-Astra xhigh   /model to change │']))
      .toEqual({model: 'GPT-6-Astra', effort: 'xhigh'});
  });
  test('a mid-session change wins over the start banner (live formats checked 2026-09-25)', () => {
    expect(cliInfoFromScreen('codex', [
      '│ model:       GPT-5.6-Sol low   /model to change │',
      '• Model changed to gpt-6-sol high',
    ])).toEqual({model: 'gpt-6-sol', effort: 'high'});
    expect(cliInfoFromScreen('claude', [
      '▝▜██████▀  Opus 5.5 (1M context) · Claude Max',
      '  ⎿  Set model to Sonnet 4.6 for this session only with high effort',
      '  테스트해보자[main]                          ● high · /effort',
    ])).toEqual({model: 'Sonnet 4.6', effort: 'high'});
    expect(cliInfoFromScreen('claude', ['  ⎿  Set model to Opus 5 with max effort'])).toEqual({model: 'Opus 5', effort: 'max'});
  });
  test('nothing is guessed when the screen does not say', () => {
    expect(cliInfoFromScreen('claude', ['I think Opus is great', 'medium effort'])).toEqual({});
    expect(cliInfoFromScreen('hermes', ['model: x high'])).toEqual({});
  });
  test('model/effort buttons open each CLI’s own picker', () => {
    expect(WORKROOM_MODEL_COMMANDS.claude.map(c => c.command)).toEqual(['/model', '/effort']);
    expect(WORKROOM_MODEL_COMMANDS.codex.map(c => c.command)).toEqual(['/model']);
    expect(WORKROOM_MODEL_COMMANDS.hermes).toEqual([]);
  });
});

describe('slash commands in the Workroom composer', () => {
  test('opens only for a leading /token before the cursor', () => {
    expect(slashCommandQuery('/mo')).toBe('mo');
    expect(slashCommandQuery('$remember')).toBe('remember');
    expect(slashCommandQuery('  /')).toBe('');
    expect(slashCommandQuery('/model now')).toBeNull();
    expect(slashCommandQuery('fix /path')).toBeNull();
    expect(slashCommandQuery('/usr/bin')).toBeNull();
  });
  test('filters the active CLI’s commands', () => {
    expect(slashCommandCandidates('claude', '/eff').map(c => c.command)).toEqual(['/effort']);
    expect(slashCommandCandidates('codex', '/mo').map(c => c.command)).toEqual(['/model']);
    expect(slashCommandCandidates('codex', '$rem').map(c => c.command)).toEqual(['$remember-session']);
    expect(slashCommandCandidates('claude', '/rem').map(c => c.command)).toEqual(['/remember-session']);
    expect(slashCommandCandidates('codex', '/rem')).toEqual([]);
    expect(slashCommandCandidates('codex', 'hello')).toEqual([]);
  });
});

import {readSlashFavorites, toggleSlashFavorite, isValidSlashCommand, DEFAULT_SLASH_FAVORITES} from '../src/workroomCliCommands';
describe('slash command favorites (per CLI, per device)', () => {
  const memory = () => { const m = new Map<string, string>(); return {getItem:(k:string)=>m.get(k)??null, setItem:(k:string,v:string)=>{m.set(k,v);}}; };
  test('defaults per CLI, toggling adds and removes, stored per device', () => {
    const s = memory();
    expect(readSlashFavorites(s, 'claude')).toEqual(DEFAULT_SLASH_FAVORITES.claude);
    toggleSlashFavorite(s, 'claude', '/cs-ceo:goal');
    expect(readSlashFavorites(s, 'claude')).toContain('/cs-ceo:goal');
    expect(readSlashFavorites(s, 'codex')).toEqual(DEFAULT_SLASH_FAVORITES.codex);
    toggleSlashFavorite(s, 'claude', '/cs-ceo:goal');
    expect(readSlashFavorites(s, 'claude')).not.toContain('/cs-ceo:goal');
  });
  test('only a single slash command is accepted and broken storage falls back', () => {
    for (const ok of ['/model', '/cs-ceo:goal', '/omh-status']) expect(isValidSlashCommand(ok)).toBe(true);
    for (const bad of ['model', '/model now', '/a\r', '/'+'x'.repeat(60), '/../x', '']) expect(isValidSlashCommand(bad)).toBe(false);
    const s = memory(); s.setItem('portmanager-workroom-slash-favorites', '{broken');
    expect(readSlashFavorites(s, 'codex')).toEqual(DEFAULT_SLASH_FAVORITES.codex);
    s.setItem('portmanager-workroom-slash-favorites', JSON.stringify({codex:['/ok','rm -rf','/fine\r']}));
    expect(readSlashFavorites(s, 'codex')).toEqual(['/ok']);
  });
});
