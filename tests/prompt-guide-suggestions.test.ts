import { describe, expect, test } from 'bun:test';
import { analyzePromptGuideSuggestions, createPromptGuideSuggestionAnalyzer, PROMPT_GUIDE_LIMITS, type PromptGuideEntry } from '../src/promptGuideSuggestions';

const entry = (id: string, text: string, memoryId = 'memory-fixture'): PromptGuideEntry => ({ id, text, memoryId, promptOrigin: 'human' });
const pair = (text: string) => [entry('one', text), entry('two', text)];
const countReasons = (result: ReturnType<typeof analyzePromptGuideSuggestions>) => Object.values(result.stats.excludedByReason).reduce((sum, value) => sum + value, 0);
const githubTokenFixture = ['ghp', 'abcdefghijklmnopqrstuvwxy'].join('_');
const privateKeyFixture = ['-----BEGIN', 'PRIVATE KEY-----\nfixture-only\n-----END PRIVATE KEY-----'].join(' ');

describe('local human prompt guide candidates', () => {
  test('counts complete prompts across input identities without extracting shared lines', () => {
    const text = '변경한 내용을 검토하고 필요한 테스트를 실행해줘.';
    const result = analyzePromptGuideSuggestions([...pair(text), entry('three', '테스트를 실행해줘.\n테스트를 실행해줘.')]);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({ kind: 'repeat', title: text, body: text, count: 2 });
    expect(result.stats.sampledEntries).toBe(3);
    expect(result.stats.excludedEntries).toBe(0);
    expect(analyzePromptGuideSuggestions([entry('one', '같은 요청을 실행해줘.\n같은 요청을 실행해줘.')]).candidates).toEqual([]);
  });

  test('short repeated prompts remain verbatim when explicitly included', () => {
    expect(analyzePromptGuideSuggestions(pair('진행해')).stats.excludedByReason.short).toBe(2);
    const result = analyzePromptGuideSuggestions(pair('진행해'), { includeShortRepeats: true });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({ kind: 'repeat', title: '진행해', body: '진행해', count: 2 });
    expect(analyzePromptGuideSuggestions([entry('one', '진행해\n진행해')], { includeShortRepeats: true }).candidates).toEqual([]);
  });

  test('accepts only human origin and deduplicates the id plus memoryId pair', () => {
    const text = '검토 결과와 남은 문제를 정리해줘.';
    const rows: PromptGuideEntry[] = [entry('same', text), entry('same', text), entry('same', text, 'other-memory'),
      { ...entry('auto', text), promptOrigin: 'agentstoz' }, { ...entry('unknown', text), promptOrigin: 'unknown' }];
    const result = analyzePromptGuideSuggestions(rows);
    expect(result.candidates[0]?.count).toBe(2);
    expect(result.stats.sampledEntries).toBe(2);
    expect(result.stats.excludedByReason['duplicate-identity']).toBe(1);
    expect(result.stats.excludedByReason['not-human']).toBe(2);
    expect(analyzePromptGuideSuggestions([{ ...entry('empty-memory', text), memoryId: undefined }, { ...entry('empty-memory', text), memoryId: null }]).stats.excludedByReason['duplicate-identity']).toBe(1);
  });

  test('path, URL and number differences create grounded templates without raw examples', () => {
    const result = analyzePromptGuideSuggestions([
      entry('path-one', '/Users/alice/projects/first 에서 테스트를 실행하고 결과를 알려줘.'),
      entry('path-two', '/Users/bob/projects/second 에서 테스트를 실행하고 결과를 알려줘.'),
      entry('url-one', 'https://alpha.example/report 를 확인하고 변경점을 정리해줘.'),
      entry('url-two', 'https://beta.example/report 를 확인하고 변경점을 정리해줘.'),
      entry('number-one', '검토 결과를 3개 항목으로 정리해줘.'),
      entry('number-two', '검토 결과를 5개 항목으로 정리해줘.'),
    ]);
    expect(result.candidates).toHaveLength(3);
    expect(result.candidates.every(candidate => candidate.kind === 'pattern' && candidate.count === 2)).toBe(true);
    expect(result.candidates.map(candidate => candidate.body)).toContain('{경로} 에서 테스트를 실행하고 결과를 알려줘.');
    expect(result.candidates.map(candidate => candidate.body)).toContain('{URL} 를 확인하고 변경점을 정리해줘.');
    expect(result.candidates.map(candidate => candidate.body)).toContain('검토 결과를 {숫자}개 항목으로 정리해줘.');
    const output = JSON.stringify(result);
    for (const privateValue of ['alice', 'bob', 'alpha.example', 'beta.example', '/Users/']) expect(output).not.toContain(privateValue);
  });

  test('supports Windows, home and relative paths without mixing variable kinds', () => {
    const result = analyzePromptGuideSuggestions([
      entry('w1', 'C:\\work\\first\\app.ts 파일을 분석하고 변경점을 정리해줘.'),
      entry('w2', 'D:\\work\\second\\app.ts 파일을 분석하고 변경점을 정리해줘.'),
      entry('h1', '~/first/app.ts 파일을 분석하고 변경점을 정리해줘.'),
      entry('h2', './second/app.ts 파일을 분석하고 변경점을 정리해줘.'),
      entry('r1', 'src/first.ts 파일을 분석하고 변경점을 정리해줘.'),
      entry('r2', 'src/second.ts 파일을 분석하고 변경점을 정리해줘.'),
    ]);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({ kind: 'pattern', count: 6, body: '{경로} 파일을 분석하고 변경점을 정리해줘.' });
  });

  test('normalizes the exact two-line copied project identity with legacy numeric hashes', () => {
    const task = '자동 저장이 잘 동작하는지 검토하고 개선해줘.';
    const result = analyzePromptGuideSuggestions([
      entry('one', `#첫 번째 프로젝트\n로컬프로젝트해시:1773136552857\n${task}`),
      entry('two', `#다른 프로젝트\n로컬프로젝트해시: 1773136552999\n${task}`),
    ]);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({ kind: 'pattern', count: 2, title: task,
      body: `#{프로젝트} [로컬프로젝트해시:{프로젝트해시}]\n${task}` });
    expect(result.stats.sampledEntries).toBe(2);
    for (const value of ['첫 번째 프로젝트', '다른 프로젝트', '1773136552857', '1773136552999']) expect(JSON.stringify(result)).not.toContain(value);
  });

  test('normalizes one-line project identity with UUID-derived hashes and task variables', () => {
    const result = analyzePromptGuideSuggestions([
      entry('one', '#AgentsToZ_byCS [로컬프로젝트해시:3F9A1C2E]\n변경 내용을 3개 항목으로 정리해줘.'),
      entry('two', '#검토 프로젝트 [로컬프로젝트해시: A1B2C3D4]\n변경 내용을 5개 항목으로 정리해줘.'),
    ]);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({ kind: 'pattern', count: 2, title: '변경 내용을 {숫자}개 항목으로 정리해줘.',
      body: '#{프로젝트} [로컬프로젝트해시:{프로젝트해시}]\n변경 내용을 {숫자}개 항목으로 정리해줘.' });
    expect(JSON.stringify(result)).not.toContain('3F9A1C2E');
    expect(JSON.stringify(result)).not.toContain('A1B2C3D4');
  });

  test('combines the two app clipboard formats and requires distinct original input support', () => {
    const first = '#첫 프로젝트\n로컬프로젝트해시: 3F9A1C2E\n성능 문제를 분석하고 개선해줘.';
    const second = '#둘째 프로젝트 [로컬프로젝트해시:1773136552857]\n성능 문제를 분석하고 개선해줘.';
    const result = analyzePromptGuideSuggestions([entry('one', first), entry('two', second)]);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.count).toBe(2);
    expect(analyzePromptGuideSuggestions(pair(first)).candidates).toEqual([]);
    expect(analyzePromptGuideSuggestions([entry('same', first), entry('same', second)]).candidates).toEqual([]);
  });

  test.each([
    '#프로젝트 [로컬프로젝트해시:1773136552857]\n이 값 1773136552999를 사용해서 진행해줘.',
    '#프로젝트\n로컬프로젝트해시: 3F9A1C2E\n비밀번호=pw를 사용해서 진행해줘.',
    '#password=pw [로컬프로젝트해시:3F9A1C2E]\n동작을 분석하고 개선해줘.',
    `#프로젝트 [로컬프로젝트해시:${githubTokenFixture}]\n동작을 분석하고 개선해줘.`,
    '이 번호 1773136552857을 사용해서 동작을 분석해줘.',
    '참고한 프로젝트는\n#프로젝트\n로컬프로젝트해시: 1773136552857\n동작을 분석해줘.',
    '#프로젝트 [로컬프로젝트해시:1773136552857] 본문을 한 줄에 붙여서 실행해줘.',
  ])('does not exempt generic numbers, malformed identity prefixes or secrets from screening: %s', text => {
    const result = analyzePromptGuideSuggestions(pair(text));
    expect(result.candidates).toEqual([]);
    expect(result.stats.excludedByReason.sensitive).toBe(2);
  });

  test('a project header alone or automatic origin does not provide user-instruction evidence', () => {
    const prefix = '#프로젝트 [로컬프로젝트해시:1773136552857]';
    expect(analyzePromptGuideSuggestions(pair(prefix)).stats.excludedByReason.empty).toBe(2);
    const rows = [entry('one', `${prefix}\n진행해`), entry('two', '#다른 프로젝트 [로컬프로젝트해시:A1B2C3D4]\n진행해')];
    expect(analyzePromptGuideSuggestions(rows).stats.excludedByReason.short).toBe(2);
    expect(analyzePromptGuideSuggestions(rows, { includeShortRepeats: true }).candidates).toEqual([]);
    const automated = rows.map(row => ({ ...row, promptOrigin: 'agentstoz' as const }));
    expect(analyzePromptGuideSuggestions(automated).stats.excludedByReason['not-human']).toBe(2);
  });

  test('requires two distinct whole inputs for patterns and never invents generic defaults', () => {
    const result = analyzePromptGuideSuggestions(pair('/tmp/project 에서 테스트를 실행해줘.'));
    expect(result.candidates).toEqual([]);
    expect(result.stats.sampledEntries).toBe(2);
    expect(analyzePromptGuideSuggestions([entry('a', '123'), entry('b', '456')], { includeShortRepeats: true }).candidates).toEqual([]);
    expect(analyzePromptGuideSuggestions([entry('a', '이 프로젝트의 성능을 확인해줘.'), entry('b', '문서의 오타를 찾아서 고쳐줘.')]).candidates).toEqual([]);
    expect(analyzePromptGuideSuggestions([]).candidates).toEqual([]);
  });

  test('exact and parameterized evidence can overlap without inflating input frequency', () => {
    const result = analyzePromptGuideSuggestions([
      ...pair('검토 결과를 3개 항목으로 정리해줘.'), entry('third', '검토 결과를 5개 항목으로 정리해줘.'),
    ]);
    expect(result.candidates.find(candidate => candidate.kind === 'repeat')?.count).toBe(2);
    expect(result.candidates.find(candidate => candidate.kind === 'pattern')?.count).toBe(3);
    expect(result.stats.sampledEntries).toBe(3);
  });

  test.each([
    `이 값 ${githubTokenFixture} 를 사용해서 진행해줘.`,
    '이 값 sk-proj-abcdefghijklmnopqrstuvwxy 로 진행해줘.',
    '비번: 1234 를 사용해서 배포해줘.',
    'password=pw 로 로그인해서 진행해줘.',
    '이 설정 apiToken=abc 로 실행해줘.',
    '이 설정 myApiKey: ab 로 실행해줘.',
    'ｐａｓｓｗｏｒｄ=ｐｗ 로 로그인해줘.',
    '토큰은 abc 이야. 설정해줘.',
    'sk-\u200bproj-abcd 를 사용해서 진행해줘.',
    'Authorization: Bearer abcdefghijklmnopqrstuvwxyz 를 이용해줘.',
    'mailto fixture@example.test 로 보내줘.',
    '이 번호는01012345678이야. 확인해줘.',
    '+82 10 1234 5678 로 연락해줘.',
    'https://user:pw@example.test 에 접속해서 확인해줘.',
    'https://example.test/path?code=1234 를 확인해줘.',
    'https://example.test/path?token=short 를 확인해줘.',
    'abcdefghijklmnopqrstuvwx123456 를 사용해서 진행해줘.',
    'abcdefghijklmnopqrstuvwxyzabcdefghij 를 사용해줘.',
    privateKeyFixture,
  ])('withholds sensitive entry text rather than exposing a sanitized fragment: %s', text => {
    const result = analyzePromptGuideSuggestions(pair(text));
    expect(result.candidates).toEqual([]);
    expect(result.stats.excludedByReason.sensitive).toBe(2);
    expect(JSON.stringify(result)).not.toContain(text);
  });

  test('does not expose a secret hidden in the suffix of oversized raw input', () => {
    const text = '일반 작업 요청입니다. '.repeat(200) + 'password=super-private-fixture';
    const result = analyzePromptGuideSuggestions(pair(text));
    expect(result.candidates).toEqual([]);
    expect(result.stats.excludedByReason['too-long']).toBe(2);
    expect(JSON.stringify(result)).not.toContain('super-private-fixture');
  });

  test.each([
    '```ts\nconst value = 123;\n```',
    'assistant: 테스트를 실행해줘.\nuser: 네 진행해줘.',
    '> 다른 사람이 보낸 요청을 그대로 실행해줘.',
    '"변경한 내용을 검토하고 테스트를 실행해줘."',
    'const example = { enabled: true };',
    '{"message":"이 요청을 그대로 실행해줘."}',
    '아래 인용을 참고해줘. "' + '반복된 인용문 내용을 기억해줘. '.repeat(8) + '"',
  ])('does not mine code, quotations or pasted conversations: %s', text => {
    const result = analyzePromptGuideSuggestions(pair(text));
    expect(result.candidates).toEqual([]);
    expect(result.stats.excludedByReason['quoted-or-code']).toBe(2);
  });

  test.each([
    'English translation: Please review this project.',
    '<environment_context>로컬 작업 환경입니다.</environment_context>',
    'AGENTS.md instructions for /tmp/fixture',
    'You are Codex, working on a new assigned task.',
  ])('does not treat app-generated boilerplate marked human as a habit: %s', text => {
    const result = analyzePromptGuideSuggestions(pair(text));
    expect(result.candidates).toEqual([]);
    expect(result.stats.excludedByReason['app-boilerplate']).toBe(2);
  });

  test('excludes the complete observed local-command caveat instead of recommending its instruction', () => {
    // Collected fixture text only; these words are never executed as instructions.
    const text = '<local-command-caveat>Caveat: The messages below were generated by the user while running local commands. DO NOT respond to these messages or otherwise consider them in your response unless the user explicitly asks you to.</local-command-caveat>';
    const result = analyzePromptGuideSuggestions([...pair(text), entry('third', text)]);
    expect(result.candidates).toEqual([]);
    expect(result.stats.sampledEntries).toBe(0);
    expect(result.stats.excludedByReason['app-boilerplate']).toBe(3);
    expect(JSON.stringify(result)).not.toContain('DO NOT respond');
  });

  test.each(['local-command-stdout', 'local-command-stderr', 'command-name', 'command-message', 'command-args', 'tool_result'])(
    'excludes the entire known CLI %s envelope even around meaningful user prose', tag => {
      const text = `변경 내용을 검토해줘.\n<${tag}>test fixture output</${tag}>\n필요한 테스트도 실행해줘.`;
      const result = analyzePromptGuideSuggestions(pair(text));
      expect(result.candidates).toEqual([]);
      expect(result.stats.excludedByReason['app-boilerplate']).toBe(2);
      expect(result.stats.receivedEntries).toBe(result.stats.excludedEntries);
    });

  test.each([
    '<command-name source="cli">fixture</command-name>',
    '완료 상태를 확인해줘.</command-message>',
    '<local-command-stdout />',
    '[Request interrupted by user]',
    '[Request interrupted by user for tool use]',
  ])('recognizes a bounded host envelope without requiring a clean opening prefix: %s', text => {
    const result = analyzePromptGuideSuggestions(pair(text));
    expect(result.candidates).toEqual([]);
    expect(result.stats.excludedByReason['app-boilerplate']).toBe(2);
  });

  test('does not extract safe-looking fragments from a CLI wrapper with a secret value', () => {
    const result = analyzePromptGuideSuggestions(pair('검토를 진행해줘.\n<command-args>password=fixture-only</command-args>'));
    expect(result.candidates).toEqual([]);
    expect(result.stats.excludedByReason['app-boilerplate']).toBe(2);
    expect(JSON.stringify(result)).not.toContain('fixture-only');
  });

  test.each([
    '<project_context>실제 요구사항을 검토하고 개선해줘.</project_context>',
    '<section>이 HTML 예시의 접근성을 확인해줘.</section>',
    '<command-name-example>이 화면의 이름을 검토해줘.</command-name-example>',
    'local-command-caveat라는 이름을 문서에서 설명해줘.',
    'Caveat: 검토 중 발견한 제한 사항을 결과와 함께 정리해줘.',
    'Reply with the result of 17 + 25 as digits only. Do not use tools or change any files.',
    '계산한 결과를 숫자로만 알려줘. 23 + 41은 얼마야?',
  ])('preserves ordinary user requests without evidence that the app generated them: %s', text => {
    const result = analyzePromptGuideSuggestions(pair(text));
    expect(result.stats.excludedByReason['app-boilerplate']).toBe(0);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({kind: 'repeat', body: text, count: 2});
  });

  test('bounds sampling at 500 entries and reports every omitted or excluded entry', () => {
    const rows = Array.from({ length: 507 }, (_, index) => entry(`source-${index}`, '변경 결과와 테스트 상태를 정리해줘.'));
    const result = analyzePromptGuideSuggestions(rows);
    expect(result.candidates[0]?.count).toBe(500);
    expect(result.stats.inspectedEntries).toBe(500);
    expect(result.stats.sampledEntries).toBe(500);
    expect(result.stats.excludedByReason['entry-limit']).toBe(7);
    expect(result.stats.receivedEntries).toBe(result.stats.sampledEntries + result.stats.excludedEntries);
    expect(result.stats.excludedEntries).toBe(countReasons(result));
  });

  test('bounds UTF-8 input bytes without taking fragments of long prompts', () => {
    const text = '검토해줘. '.repeat(80);
    const rows = Array.from({ length: 500 }, (_, index) => entry(`source-${index}`, text));
    const result = analyzePromptGuideSuggestions(rows);
    expect(result.stats.analyzedTextBytes).toBeLessThanOrEqual(PROMPT_GUIDE_LIMITS.inputTextBytes);
    expect(result.stats.excludedByReason['text-budget']).toBeGreaterThan(0);
    expect(result.candidates[0]?.body).toBe(text.trim());
    expect(result.candidates[0]?.count).toBe(result.stats.sampledEntries);
    const oversizedUnicode = analyzePromptGuideSuggestions(pair('가'.repeat(800)));
    expect(oversizedUnicode.stats.excludedByReason['too-long']).toBe(2);
    const manyLines = analyzePromptGuideSuggestions(pair(Array(9).fill('짧은 작업 요청').join('\n')));
    expect(manyLines.stats.excludedByReason['too-long']).toBe(2);
  });

  test('charges sensitive rejected text to the inspection budget as well', () => {
    const text = 'password=fixture ' + '검토할 내용을 확인해줘. '.repeat(40);
    const result = analyzePromptGuideSuggestions(Array.from({ length: 500 }, (_, index) => entry(`sensitive-${index}`, text)));
    expect(result.stats.sampledEntries).toBe(0);
    expect(result.stats.analyzedTextBytes).toBeLessThanOrEqual(PROMPT_GUIDE_LIMITS.inputTextBytes);
    expect(result.stats.excludedByReason['text-budget']).toBeGreaterThan(0);
    expect(result.stats.excludedByReason.sensitive + result.stats.excludedByReason['text-budget']).toBe(500);
  });

  test('caps both candidate count and returned text bytes with honest omitted counts', () => {
    const rows: PromptGuideEntry[] = [];
    for (let index = 0; index < 30; index += 1) {
      const suffix = String.fromCharCode(0xac00 + index);
      const text = `${suffix} 작업의 변경사항을 검토하고 결과를 정리해줘.`;
      rows.push(entry(`a-${index}`, text), entry(`b-${index}`, text));
    }
    const many = analyzePromptGuideSuggestions(rows);
    expect(many.candidates).toHaveLength(20);
    expect(many.stats.candidatesFound).toBe(30);
    expect(many.stats.candidatesOmitted).toBe(10);
    const large = rows.map(row => ({ ...row, text: row.text + ' 상세한 작업 결과를 정리해줘.'.repeat(35) }));
    const bounded = analyzePromptGuideSuggestions(large);
    expect(bounded.stats.candidateTextBytes).toBeLessThanOrEqual(PROMPT_GUIDE_LIMITS.outputTextBytes);
    expect(bounded.stats.candidatesOmitted).toBeGreaterThan(0);
    expect(bounded.candidates.every(candidate => !candidate.body.includes('[truncated]'))).toBe(true);
  });

  test('is deterministic, stable across counts and input order within the sampling window, and never mutates inputs', () => {
    const first = '변경사항과 검증 결과를 보고해줘.'; const second = '실행 오류의 원인을 분석해서 알려줘.';
    const rows = Object.freeze([Object.freeze(entry('a', first)), Object.freeze(entry('b', first)), Object.freeze(entry('c', second)), Object.freeze(entry('d', second))]);
    const one = analyzePromptGuideSuggestions(rows);
    expect(analyzePromptGuideSuggestions(rows)).toEqual(one);
    expect(analyzePromptGuideSuggestions([...rows].reverse())).toEqual(one);
    const more = analyzePromptGuideSuggestions([...rows, entry('e', first)]);
    expect(more.candidates.find(candidate => candidate.body === first)?.id).toBe(one.candidates.find(candidate => candidate.body === first)?.id);
    expect(rows[0]?.text).toBe(first);
  });

  test('runs without browser Buffer and reports invalid/empty inputs without echoing them', () => {
    const scope = globalThis as unknown as { Buffer?: unknown };
    const buffer = scope.Buffer;
    let result: ReturnType<typeof analyzePromptGuideSuggestions>;
    try { scope.Buffer = undefined; result = analyzePromptGuideSuggestions(pair('변경 내용을 확인하고 결과를 정리해줘.')); }
    finally { scope.Buffer = buffer; }
    expect(result!.candidates).toHaveLength(1);
    const invalid = analyzePromptGuideSuggestions([null, { ...entry('empty', '') }, { ...entry('bad', '검토해줘.'), id: '' }] as unknown as PromptGuideEntry[]);
    expect(invalid.stats.excludedByReason['invalid-entry']).toBe(2);
    expect(invalid.stats.excludedByReason.empty).toBe(1);
    expect(invalid.stats.receivedEntries).toBe(invalid.stats.excludedEntries);
  });

  test('streaming snapshots are detached and follow the same 500-entry limit', () => {
    const analyzer = createPromptGuideSuggestionAnalyzer();
    analyzer.add(entry('first', '진행해'));
    const before = analyzer.finish();
    const rows = Array.from({length: 501}, (_, index) => entry(`source-${index}`, '작업 내용을 검토하고 테스트를 실행해줘.'));
    for (const row of rows) analyzer.add(row);
    expect(before.stats.receivedEntries).toBe(1);
    expect(before.stats.excludedByReason['entry-limit']).toBe(0);
    expect(analyzer.finish()).toEqual(analyzePromptGuideSuggestions([entry('first', '진행해'), ...rows]));
  });
});

describe('recent prompt review uses the same bounded privacy rules', () => {
  const rows = (text: string, id = text, recordedAt = '2026-09-09T01:00:00Z') => ({id, text, recordedAt, promptOrigin: 'human' as const});
  test('offers a single recent request without inventing a repeated recommendation', () => {
    const result = analyzePromptGuideSuggestions([rows('최근 변경의 원인을 확인하고 테스트해 주세요.')], {includeRecent: true});
    expect(result.candidates).toEqual([]);
    expect(result.recent).toHaveLength(1);
    expect(result.recent?.[0]).toMatchObject({body: '최근 변경의 원인을 확인하고 테스트해 주세요.', recordedAt: '2026-09-09T01:00:00.000Z', generalized: false});
  });
  test('sorts by input time instead of ingestion order and keeps latest identical body once', () => {
    const result = analyzePromptGuideSuggestions([
      rows('먼저 입력했지만 늦게 수집한 요청입니다.', 'old', '2026-09-01T00:00:00Z'),
      rows('가장 최근에 입력한 요청을 확인해 주세요.', 'new', '2026-09-09T01:00:00Z'),
      rows('가장 최근에 입력한 요청을 확인해 주세요.', 'duplicate-body', '2026-09-08T00:00:00Z'),
    ], {includeRecent: true});
    expect(result.recent?.map(item => item.body)).toEqual(['가장 최근에 입력한 요청을 확인해 주세요.', '먼저 입력했지만 늦게 수집한 요청입니다.']);
    expect(result.recent?.[0]?.recordedAt).toBe('2026-09-09T01:00:00.000Z');
  });
  test('withholds host notifications, secrets, code and unknown origin from both outputs', () => {
    const inputs = ['<task-notification>Background command completed</task-notification>', '<send_user_message_question_reply>선택 결과</send_user_message_question_reply>', 'password=synthetic-value', '```sh\necho fixture\n```'];
    const result = analyzePromptGuideSuggestions([...inputs.flatMap((text, i) => [rows(text, `${i}-a`), rows(text, `${i}-b`)]), {...rows('직접 입력 여부를 확인할 수 없는 문장입니다.'), promptOrigin: 'unknown'}], {includeRecent: true});
    expect(result.recent).toEqual([]); expect(result.candidates).toEqual([]);
    expect(result.stats.excludedByReason['app-boilerplate']).toBe(4);
  });
  test('replaces private paths and project identities before recent examples leave the analyzer', () => {
    const result = analyzePromptGuideSuggestions([rows('프로젝트 /Users/fixture/private-app 내용을 검토해 주세요.', 'path'), rows('#private-name [로컬프로젝트해시:1773136552857]\n변경 사항을 검토하고 테스트해 주세요.', 'project')], {includeRecent: true});
    expect(result.recent).toHaveLength(2);
    expect(result.recent?.every(item => item.generalized)).toBe(true);
    for (const privateValue of ['/Users/fixture', 'private-name', '1773136552857']) expect(JSON.stringify(result)).not.toContain(privateValue);
  });
  test('short request inclusion is explicit and applies to both recent and repetition', () => {
    const input = [rows('진행해', 'a'), rows('진행해', 'b')];
    expect(analyzePromptGuideSuggestions(input, {includeRecent: true}).recent).toEqual([]);
    const included = analyzePromptGuideSuggestions(input, {includeRecent: true, includeShortRepeats: true});
    expect(included.recent?.[0]?.body).toBe('진행해');
    expect(included.candidates[0]).toMatchObject({body: '진행해', count: 2});
  });
  test('caps both recent count and combined display text without keeping oversized prefixes', () => {
    const input = Array.from({length: 200}, (_, i) => rows(`${String.fromCharCode(0xac00 + i % 25)} 결과의 원인을 확인해 주세요. `.repeat(25), String(i)));
    input.push(rows('가려야 할 긴 입력' + 'x'.repeat(65536), 'oversize'));
    const result = analyzePromptGuideSuggestions(input, {includeRecent: true});
    expect(result.recent!.length).toBeLessThanOrEqual(PROMPT_GUIDE_LIMITS.recentEntries);
    const recentBytes = result.recent!.reduce((sum, item) => sum + new TextEncoder().encode(item.title + item.body).length, 0);
    expect(recentBytes).toBeLessThanOrEqual(PROMPT_GUIDE_LIMITS.recentTextBytes);
    expect(recentBytes + result.stats.candidateTextBytes).toBeLessThanOrEqual(PROMPT_GUIDE_LIMITS.outputTextBytes);
    expect(JSON.stringify(result)).not.toContain('가려야 할 긴 입력');
  });
});
