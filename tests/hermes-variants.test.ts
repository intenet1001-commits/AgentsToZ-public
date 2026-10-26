import {expect, test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {aiTerminalLaunchArgs} from '../src/aiTerminalLaunchArgs';
import {TEAM_MODEL_CHOICES} from '../src/workroomTeamInstruction';
import {
  HERMES_VARIANTS, HERMES_VARIANT_PROVIDER, WORKROOM_LAUNCH_CHOICES,
  hermesVariantItems, hermesVariantModel, hermesVariantOf, launchChoiceId, launchChoiceLabel, launchChoiceTarget,
  parseHermesVariant, workroomLaunchChoices,
} from '../src/hermesVariants';
import {normalizeHermesVariantView, splitHermesVariantStart} from '../src/hermesVariants';
import {normalizeAiTerminalRequest} from '../src/aiTerminalProtocol';
import {HermesProviderCredentials, hermesAuthProviders} from '../src/hermesProviderCredentials';
import {workroomSessionLabels} from '../src/workroomSessionLabel';

test('each Hermes variant launches the team builder\'s own first preset for that provider — one list, one place', () => {
  expect([...HERMES_VARIANTS]).toEqual(['claude', 'codex']);
  for (const variant of HERMES_VARIANTS) {
    const provider = HERMES_VARIANT_PROVIDER[variant];
    const preset = TEAM_MODEL_CHOICES.hermes.find(choice => choice.provider === provider)!;
    expect(preset).toBeDefined();
    expect(hermesVariantModel(variant)).toEqual({model: preset.model, provider});
  }
  // The real argv each variant produces: Hermes takes the model and the provider.
  expect(aiTerminalLaunchArgs('hermes', 's', undefined, false, null, null, false, null, hermesVariantModel('claude')))
    .toEqual(['chat', '-m', 'claude-opus-5-5', '--provider', 'anthropic']);
  expect(aiTerminalLaunchArgs('hermes', 's', 'hi', false, null, null, false, null, hermesVariantModel('codex')))
    .toEqual(['chat', '-m', 'gpt-6.1-sol', '--provider', 'openai-codex', '-q', 'hi']);
  // Plain Hermes is unchanged: no model, no provider.
  expect(aiTerminalLaunchArgs('hermes', 's')).toEqual(['chat']);
});

test('a launch list puts the two variants next to Hermes, and every id resolves back to one launch', () => {
  expect([...WORKROOM_LAUNCH_CHOICES]).toEqual(['codex', 'claude', 'hermes', 'hermes:claude', 'hermes:codex', 'agy']);
  expect(workroomLaunchChoices(['hermes'])).toEqual(['hermes', 'hermes:claude', 'hermes:codex']);
  expect(workroomLaunchChoices(['codex', 'agy'])).toEqual(['codex', 'agy']);
  expect(launchChoiceTarget('hermes')).toEqual({agent: 'hermes'});
  expect(launchChoiceTarget('hermes:codex')).toEqual({agent: 'hermes', variant: 'codex'});
  expect(launchChoiceTarget('claude')).toEqual({agent: 'claude'});
  expect(launchChoiceId('hermes', 'claude')).toBe('hermes:claude');
  expect(launchChoiceId('hermes')).toBe('hermes');
  expect(launchChoiceLabel('hermes:claude')).toBe('Hermes · Claude');
  expect(launchChoiceLabel('hermes:codex')).toBe('Hermes · Codex');
  expect(launchChoiceLabel('hermes')).toBe('Hermes');
  expect(launchChoiceLabel('codex')).toBe('Codex CLI');
  // Junk never becomes a launch.
  for (const value of ['hermes:gpt', 'hermes:', 'HERMES:CLAUDE', 'claude:codex', '', null, 7]) expect(parseHermesVariant(value)).toBeNull();
  expect(parseHermesVariant('claude')).toBe('claude');
});

test('the phone keeps one Hermes item: the Workroom picker only grows variants on this Mac', () => {
  // The host-only start option cannot ride a wire request, so a relay/LAN surface must not offer it at all.
  const panel = readFileSync(new URL('../src/AiTerminalPanel.tsx', import.meta.url), 'utf8');
  expect(panel).toContain('(remote?[...AI_TERMINAL_AGENTS]:[...WORKROOM_LAUNCH_CHOICES])');
  expect(panel).toContain('useHermesVariants(remote?null:sessions.length,!remote)');
  expect(panel).toContain("const launchVariant=!remote&&agent==='hermes'?hermesVariant:null;");
});

test('a session is read back as its variant from the model it was launched with', () => {
  expect(hermesVariantOf({model: 'claude-opus-5-5', provider: 'anthropic'})).toBe('claude');
  expect(hermesVariantOf({model: 'gpt-6.1-sol', provider: 'openai-codex'})).toBe('codex');
  expect(hermesVariantOf({model: 'gpt-6.1-sol'})).toBeNull();
  // Another model on the same provider (a team member's own choice) is not this item.
  expect(hermesVariantOf({model: 'claude-opus-5', provider: 'anthropic'})).toBeNull();
  expect(hermesVariantOf({provider: 'anthropic'})).toBeNull();
  expect(hermesVariantOf(null)).toBeNull();
  expect(hermesVariantOf(undefined)).toBeNull();
});

test('session labels name the variant, so two Hermes tabs are told apart', () => {
  const sessions = [
    {id: 'a', targetId: 't1', agent: 'hermes' as const, createdAt: '2026-10-25T01:00:00.000Z'},
    {id: 'b', targetId: 't1', agent: 'hermes' as const, createdAt: '2026-10-25T02:00:00.000Z'},
    {id: 'c', targetId: 't1', agent: 'codex' as const, createdAt: '2026-10-25T03:00:00.000Z'},
  ];
  const variantOf = (id: string) => id === 'a' ? 'claude' as const : id === 'b' ? 'codex' as const : null;
  const labels = workroomSessionLabels(sessions, () => '쇼핑몰', variantOf);
  expect(labels.get('a')).toBe('쇼핑몰 · hermes · claude');
  expect(labels.get('b')).toBe('쇼핑몰 · hermes · codex');
  expect(labels.get('c')).toBe('쇼핑몰 · codex');
  // Without a resolver nothing changes for anybody.
  expect(workroomSessionLabels(sessions, () => '쇼핑몰').get('a')).toBe('쇼핑몰 · hermes #1');
});

test('provider credentials are read by name only: header lines, never a credential row', () => {
  const stdout = [
    'anthropic (2 credentials):',
    '  #1  «redacted:sk-…»  oauth   id=ed8362 priority=0 hermes_pkce ←',
    '  #2  claude_code          oauth   id=69606e priority=1 claude_code',
    '',
    'copilot (1 credentials):',
    '  #1  gh auth token        api_key id=c4d1e7 priority=0 gh_cli ←',
    '',
    'openai-codex (1 credentials):',
    '  #1  ChatGPT/Codex        oauth   id=7a5471 priority=0 device_code ←',
  ].join('\n');
  const providers = hermesAuthProviders(stdout);
  expect(providers).toEqual(['anthropic', 'copilot', 'openai-codex']);
  // Nothing from a credential row can become a provider name.
  for (const name of providers) expect(name).not.toContain('sk-ant');
  expect(hermesAuthProviders('no credentials configured')).toEqual([]);
  expect(hermesAuthProviders('⚠ a banner line\nanthropic (1 credentials):')).toEqual(['anthropic']);
  // A row that looks like a header but is indented, and a name that is not a provider id, are both ignored.
  expect(hermesAuthProviders('  anthropic (1 credentials):\nnot a provider line\n/etc/passwd (2 credentials):')).toEqual([]);
});

test('the credential list is asked for at most once a window, and a failure is not a denial of everything', async () => {
  let runs = 0, fail = false, now = 1_000;
  const credentials = new HermesProviderCredentials(async () => { runs++; if (fail) throw new Error('hermes CLI 없음'); return 'anthropic (1 credentials):'; }, 30_000, () => now);
  expect([...(await credentials.providers())!]).toEqual(['anthropic']);
  expect([...(await credentials.providers())!]).toEqual(['anthropic']);
  expect(runs).toBe(1);
  now += 30_001;
  fail = true;
  // A CLI that cannot be asked answers 「unknown」, not 「no credentials」: the caller then offers the item without a gate.
  expect(await credentials.providers()).toBeNull();
  expect(runs).toBe(2);
});

test('an item is offered, or disabled with the provider that is missing — never with a secret', () => {
  const items = hermesVariantItems(new Set(['anthropic', 'copilot']));
  expect(items).toEqual([
    {variant: 'claude', choice: 'hermes:claude', label: 'Hermes · Claude', provider: 'anthropic', model: 'claude-opus-5-5', available: true},
    {variant: 'codex', choice: 'hermes:codex', label: 'Hermes · Codex', provider: 'openai-codex', model: 'gpt-6.1-sol', available: false},
  ]);
  // Unknown (the CLI could not be asked): both are offered rather than hidden on a guess.
  expect(hermesVariantItems(null).every(item => item.available)).toBe(true);
});

test('the start option is this Mac\'s only: it is split off before the shared DTO, and the DTO still refuses it', () => {
  const start = {operation: 'start', requestId: '3f2a9c1e-6b47-4d58-9a0e-7c15d2b8e410', targetId: 'shop-project', agent: 'hermes', cols: 100, rows: 28};
  expect(splitHermesVariantStart({...start, hermesVariant: 'codex'})).toEqual({request: start, variant: 'codex'});
  // Nothing to split: the request is passed through untouched (same object), so every other path is unchanged.
  const plain = {...start};
  expect(splitHermesVariantStart(plain)).toEqual({request: plain, variant: null});
  expect(splitHermesVariantStart(undefined)).toEqual({request: undefined, variant: null});
  // A value that is not one of the two, another AI, another operation, or a restart: refused, never launched.
  expect(() => splitHermesVariantStart({...start, hermesVariant: 'gpt-6.1-sol'})).toThrow(/다시 선택/);
  expect(() => splitHermesVariantStart({...start, hermesVariant: null})).toThrow(/다시 선택/);
  expect(() => splitHermesVariantStart({...start, agent: 'codex', hermesVariant: 'codex'})).toThrow(/Hermes 워크룸을 새로 시작/);
  expect(() => splitHermesVariantStart({operation: 'write', sessionId: 's', data: 'x', hermesVariant: 'codex'})).toThrow(/Hermes 워크룸을 새로 시작/);
  expect(() => splitHermesVariantStart({...start, resumeFrom: 'session-abc-1', hermesVariant: 'claude'})).toThrow(/다시 시작/);
  // The shared request DTO never learns the key: a remote request carrying it is rejected whole (phone normalizer).
  expect(() => normalizeAiTerminalRequest({...start, hermesVariant: 'codex'})).toThrow();
  expect(normalizeAiTerminalRequest(start)).toMatchObject({operation: 'start', agent: 'hermes'});
  expect(Object.keys(normalizeAiTerminalRequest(start))).not.toContain('hermesVariant');
});

test('a view from the host is normalized, and a broken one still offers both items', () => {
  const view = normalizeHermesVariantView({checked: true, items: [{variant: 'codex', provider: 'openai-codex', model: 'gpt-6.1-sol', available: false}],
    sessions: [{sessionId: 'a', variant: 'claude'}, {sessionId: '', variant: 'codex'}, {sessionId: 'b', variant: 'nope'}]});
  expect(view.checked).toBe(true);
  expect(view.items).toEqual([{variant: 'codex', choice: 'hermes:codex', label: 'Hermes · Codex', provider: 'openai-codex', model: 'gpt-6.1-sol', available: false}]);
  expect(view.sessions).toEqual([{sessionId: 'a', variant: 'claude'}]);
  const broken = normalizeHermesVariantView({items: 'nope', sessions: 7});
  expect(broken.items.map(item => item.variant)).toEqual(['claude', 'codex']);
  expect(broken.items.every(item => item.available)).toBe(true);
  expect(broken).toMatchObject({sessions: [], checked: false});
});
