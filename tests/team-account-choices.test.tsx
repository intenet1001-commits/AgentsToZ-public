import {describe, expect, test} from 'bun:test';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {readFileSync} from 'node:fs';
import {readTeamAccountChoices, useTeamAccountChoices, type TeamAccountLister} from '../src/teamAccountChoices';
import {WorkroomTeamBuilder} from '../src/WorkroomTeamBuilder';
import {hermesVariantItems} from '../src/hermesVariants';
import {HOST_CLI_ACCOUNT_ID, type CliAccountAgent} from '../src/cliAccountProtocol';
import {workroomTeamCopy} from '../src/i18n';

// 팀 작전's account lists (src/teamAccountChoices.ts): read with `list` only, and a list that cannot be read is left out — the
// builder then says 「목록 확인 불가」 instead of showing an empty list or quietly starting on another account.
const ACCOUNT = 'acct_12345678-1234-4123-8123-123456789abc';
const summary = (agent: CliAccountAgent, id: string, label: string) => ({id, agent, label, authState: 'signed-in', checkedAt: null, loginState: 'idle'});
const selection = (agent: CliAccountAgent, ...extra: ReturnType<typeof summary>[]) =>
  ({agent, items: [summary(agent, HOST_CLI_ACCOUNT_ID, '현재 CLI 계정'), ...extra], selectedAccountId: extra[0]?.id ?? HOST_CLI_ACCOUNT_ID});
const copy = workroomTeamCopy('ko');
const VARIANTS = hermesVariantItems(new Set(['anthropic', 'openai-codex']));
const count = (markup: string, text: string) => markup.split(text).length - 1;

describe('reading the lists', () => {
  test('each account-taking AI is read once; only ids and names are kept, not the project binding', async () => {
    const asked: string[] = [];
    const result = await readTeamAccountChoices(async agent => {
      asked.push(agent);
      return agent === 'codex' ? selection('codex', summary('codex', ACCOUNT, '회사 계정')) : selection('claude');
    });
    expect(asked.sort()).toEqual(['claude', 'codex']);
    expect(result).toEqual({
      codex: [{id: HOST_CLI_ACCOUNT_ID, label: '현재 CLI 계정'}, {id: ACCOUNT, label: '회사 계정'}],
      claude: [{id: HOST_CLI_ACCOUNT_ID, label: '현재 CLI 계정'}],
    });
    // The codex selection picked ACCOUNT for the leader's project; a new member does not inherit it.
    expect(JSON.stringify(result)).not.toMatch(/selectedAccountId|authState|loginState/);
  });

  const unreadable: [string, () => Promise<unknown>][] = [
    ['a failed read', () => Promise.reject(new Error('network'))],
    ['a host without account selection', () => Promise.reject(new Error('이 호스트는 계정 선택을 지원하지 않습니다. 호스트 앱을 업데이트하세요.'))],
    ['a response without accounts', () => Promise.resolve(undefined)],
    ['an empty list', () => Promise.resolve({agent: 'claude', items: [], selectedAccountId: HOST_CLI_ACCOUNT_ID})],
    ['an unknown field', () => Promise.resolve({...selection('claude'), token: 'x'})],
    ['another AI\'s list', () => Promise.resolve(selection('codex'))],
    ['another AI\'s account inside the list', () => Promise.resolve(selection('claude', summary('codex', ACCOUNT, '회사 계정')))],
    ['a malformed account id', () => Promise.resolve(selection('claude', summary('claude', 'acct_nope', '깨진 계정')))],
  ];
  for (const [name, answer] of unreadable) test(`${name} leaves that AI out, never an empty list`, async () => {
    const lister: TeamAccountLister = agent => agent === 'claude' ? answer() : Promise.resolve(selection('codex'));
    const result = await readTeamAccountChoices(lister);
    expect(Object.hasOwn(result, 'claude')).toBe(false);
    expect(result.codex).toEqual([{id: HOST_CLI_ACCOUNT_ID, label: '현재 CLI 계정'}]);
  });

  test('the hook reads only while open and with a lister; until the first answer it is loading', () => {
    const Probe = (props: {list?: TeamAccountLister; active: boolean}) => <output>{JSON.stringify(useTeamAccountChoices(props.list, 'target-1', props.active))}</output>;
    const list: TeamAccountLister = async agent => selection(agent);
    expect(renderToStaticMarkup(<Probe list={list} active/>)).toContain('{&quot;loading&quot;:true}');
    expect(renderToStaticMarkup(<Probe list={list} active={false}/>)).toContain('{&quot;loading&quot;:false}');
    // A phone, another Mac or a USE thread has no lister: nothing is read and every list stays unavailable.
    expect(renderToStaticMarkup(<Probe active/>)).toContain('{&quot;loading&quot;:false}');
  });
});

describe('the builder rows', () => {
  // Leader Hermes: the default members are Codex and Claude in the Workroom, both of which take an account.
  const render = (props: Partial<React.ComponentProps<typeof WorkroomTeamBuilder>>) =>
    renderToStaticMarkup(<WorkroomTeamBuilder leader="hermes" initialGoal="" hermesVariants={VARIANTS} onCompose={() => {}} onClose={() => {}} {...props}/>);
  const accountSelects = (markup: string) => [...markup.matchAll(/<select[^>]*aria-label="팀원 \d · 계정"[^>]*>(.*?)<\/select>/g)];

  test('while the lists are read, each account row says so and offers only this Mac\'s default', () => {
    const markup = render({accountsLoading: true});
    expect(count(markup, 'data-state="loading"')).toBe(2);
    expect(count(markup, copy.accountsLoading)).toBe(2);
    const selects = accountSelects(markup);
    expect(selects).toHaveLength(2);
    for (const [whole, options] of selects) {
      expect(whole).toContain('disabled=""');
      expect(options).toBe(`<option value="" selected="">${copy.accountHostDefault}</option>`);
    }
  });

  test('an unavailable list is said in the row, with the honest default — not shown as 「no accounts」', () => {
    const markup = render({});
    expect(count(markup, 'data-state="unavailable"')).toBe(2);
    expect(count(markup, copy.accountsUnreadable)).toBe(2);
    for (const [whole] of accountSelects(markup)) expect(whole).toContain('disabled=""');
  });

  test('a listed AI offers its accounts; the AI whose list is missing still says it is unavailable', () => {
    const markup = render({accounts: {codex: [{id: HOST_CLI_ACCOUNT_ID, label: '현재 CLI 계정'}, {id: ACCOUNT, label: '회사 계정'}]}});
    const [codex, claude] = accountSelects(markup);
    expect(codex![0]).not.toContain('disabled=""');
    // '' already is this Mac's own login, so the host's entry is not listed twice.
    expect(codex![1]).toBe(`<option value="" selected="">${copy.accountHostDefault}</option><option value="${ACCOUNT}">회사 계정</option>`);
    expect(claude![0]).toContain('disabled=""');
    expect(count(markup, 'data-state="unavailable"')).toBe(1);
    expect(markup).not.toContain('data-state="loading"');
  });
});

test('the wiring reads the list and never selects an account', () => {
  const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
  expect(read('src/teamAccountChoices.ts')).not.toMatch(/'select'/);
  for (const file of ['src/AiTerminalPanel.tsx', 'src/WorkroomDeviceSwitch.tsx', 'src/CommunityWorkspace.tsx']) {
    const lines = read(file).split('\n').filter(line => /teamAccounts|useTeamAccountChoices\(/.test(line));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line).not.toMatch(/accountAction:'select'/);
  }
  expect(read('src/AiTerminalPanel.tsx')).toMatch(/useTeamAccountChoices\([^\n]*accountAction:'list'/);
  expect(read('src/WorkroomDeviceSwitch.tsx')).toMatch(/teamAccounts:[^\n]*accountAction:'list'/);
});
