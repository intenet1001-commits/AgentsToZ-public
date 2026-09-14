import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inspectProjectMemoryOutputSafety } from '../src/projectMemoryOutputGuard';

const root = join(import.meta.dir, '..');

describe('project-memory model output safety guard', () => {
  const previous = `# Project Core Memory

## Key Decisions

- Keep durable conclusions concise.
`;

  test('accepts a concise derived summary that shares only ordinary short terms', () => {
    const issue = inspectProjectMemoryOutputSafety({
      previousMemory: previous,
      proposedMemory: `${previous}- Remote controls now use an explicit capability handshake.\n`,
      sessionNarrative: '원격 기능 호환성 검증을 추가했다.',
      transcriptContext: '사용자가 원격 기능의 이름과 동작이 혼동되지 않도록 전체 흐름을 확인해 달라고 요청했다.',
    });
    expect(issue).toBeNull();
  });

  test('rejects a newly copied long exact transcript passage', () => {
    const copied = '이 문장은 대화 원문을 요약하지 않고 그대로 장기기억에 복사하는 잘못된 동작을 검증하기 위한 충분히 긴 고유 문장입니다. '
      .repeat(5);
    const issue = inspectProjectMemoryOutputSafety({
      previousMemory: previous,
      proposedMemory: `${previous}\n${copied}\n`,
      transcriptContext: `[사용자 2026-09-05T01:02:03Z]\n${copied}`,
    });
    expect(issue).toEqual({ kind: 'exact-transcript-overlap', overlapChars: 240 });
  });

  test('rejects long normalized overlap despite Markdown, case, and whitespace changes', () => {
    const words = Array.from({ length: 55 }, (_, index) => `UniqueTerm${index}`).join(' - ');
    const normalizedCopy = words.toLowerCase().replaceAll(' - ', '   ** ');
    const issue = inspectProjectMemoryOutputSafety({
      previousMemory: previous,
      proposedMemory: `${previous}\n${normalizedCopy}\n`,
      transcriptContext: `[에이전트]\n${words}`,
    });
    expect(issue).toEqual({ kind: 'normalized-transcript-overlap', overlapChars: 160 });
  });

  test('rejects normalized overlap when presentation punctuation is removed entirely', () => {
    const clauses = Array.from({ length: 45 }, (_, index) => `고유검증문장${index}`).join(' · ');
    const issue = inspectProjectMemoryOutputSafety({
      previousMemory: previous,
      proposedMemory: `${previous}\n${clauses.replaceAll(' · ', '')}\n`,
      transcriptContext: `[사용자]\n${clauses}`,
    });
    expect(issue).toEqual({ kind: 'normalized-transcript-overlap', overlapChars: 160 });
  });

  test('does not reject an overlap that already exists unchanged in the prior memory', () => {
    const durable = '이미 검증된 기존 결정은 대화에서 다시 언급되더라도 새 원문 복사로 간주하면 안 됩니다. '.repeat(7);
    const baseline = `${previous}\n${durable}\n`;
    const issue = inspectProjectMemoryOutputSafety({
      previousMemory: baseline,
      proposedMemory: `${baseline}\n- 새 결론은 짧은 요약입니다.\n`,
      transcriptContext: `[사용자]\n${durable}`,
    });
    expect(issue).toBeNull();
  });

  test('rejects a high-confidence secret introduced by the model', () => {
    const issue = inspectProjectMemoryOutputSafety({
      previousMemory: previous,
      proposedMemory: `${previous}\n- OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz012345\n`,
      transcriptContext: '',
    });
    expect(issue).toEqual({ kind: 'high-confidence-secret' });
  });

  test('rejects a secret fragmented by invisible Unicode controls or marks', () => {
    const secret = 'sk-proj-abcdefghijklmnopqrstuvwxyz012345';
    for (const invisible of ['\u200B', '\u034F', '\uFE00', '\u1160', '\u3164']) {
      const fragmented = secret.match(/.{1,8}/g)?.join(invisible) ?? secret;
      const issue = inspectProjectMemoryOutputSafety({
        previousMemory: previous,
        proposedMemory: `${previous}\n- credential: ${fragmented}\n`,
        transcriptContext: '',
      });
      expect(fragmented
        .replace(/\p{Default_Ignorable_Code_Point}/gu, '')
        .replace(/[\p{Cf}\p{Mn}\p{Me}]/gu, '')).toBe(secret);
      expect(issue).toEqual({ kind: 'high-confidence-secret' });
    }
  });

  test('rejects direct identifiers even when a copied excerpt is shorter than overlap windows', () => {
    const copied = '문의자는 minji@example.com 또는 010-1234-5678로 답변을 요청했습니다.';
    expect(inspectProjectMemoryOutputSafety({
      previousMemory: previous,
      proposedMemory: `${previous}\n- ${copied}\n`,
      transcriptContext: `[사용자]\n${copied}`,
    })).toEqual({ kind: 'direct-identifier' });
  });

  test('rejects a phone written with non-ASCII decimal digits', () => {
    const copied = '연락처 ٠١٠-١٢٣٤-٥٦٧٨로 답변을 요청했습니다.';
    expect(inspectProjectMemoryOutputSafety({
      previousMemory: previous,
      proposedMemory: `${previous}\n- ${copied}\n`,
      transcriptContext: `[사용자]\n${copied}`,
    })).toEqual({ kind: 'direct-identifier' });
  });

  test('rejects a Korean mobile number without separators', () => {
    const copied = '연락처 01012345678';
    expect(inspectProjectMemoryOutputSafety({
      previousMemory: previous,
      proposedMemory: `${previous}\n- ${copied}\n`,
      transcriptContext: `[사용자]\n${copied}`,
    })).toEqual({ kind: 'direct-identifier' });
  });

  test('rejects a Basic authorization credential even when it is short', () => {
    const credential = 'Authorization: Basic dXNlcjpwYXNzd29yZA==';
    expect(inspectProjectMemoryOutputSafety({
      previousMemory: previous,
      proposedMemory: `${previous}\n- ${credential}\n`,
      transcriptContext: `[사용자]\n${credential}`,
    })).toEqual({ kind: 'high-confidence-secret' });
  });

  test('rejects passphrases and recognizable API keys split with spaces', () => {
    for (const leaked of [
      'PASSWORD = correct horse battery staple',
      'credential: sk-proj-abcd efgh ijkl mnop qrst uvwx yz012345',
    ]) {
      expect(inspectProjectMemoryOutputSafety({
        previousMemory: previous,
        proposedMemory: `${previous}\n- ${leaked}\n`,
        transcriptContext: `[사용자]\n${leaked}`,
      })).toEqual({ kind: 'high-confidence-secret' });
    }
  });

  test('rejects normalized transcript overlap split by default-ignorable letters', () => {
    const copied = '이 문장은 기본 무시 문자를 넣어도 대화 원문 복사를 탐지해야 한다는 것을 검증합니다. '.repeat(8);
    const fragmented = [...copied].join('\u1160');
    expect(inspectProjectMemoryOutputSafety({
      previousMemory: previous,
      proposedMemory: `${previous}\n${fragmented}\n`,
      transcriptContext: `[사용자]\n${copied}`,
    })).toEqual({ kind: 'normalized-transcript-overlap', overlapChars: 160 });
  });

  test('rejects aggregate copied transcript chunks split below the continuous window', () => {
    const copied = ['가', '나', '다', '라', '마', '바'].map(letter => letter.repeat(100));
    expect(inspectProjectMemoryOutputSafety({
      previousMemory: previous,
      proposedMemory: `${previous}\n${copied.join('X')}\n`,
      transcriptContext: copied.join(''),
    })).toEqual({ kind: 'normalized-transcript-overlap', overlapChars: 240 });
  });

  test('secret scanning ignores unchanged baseline lines but checks SESSION narrative', () => {
    const legacy = `${previous}\n- OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz012345\n`;
    expect(inspectProjectMemoryOutputSafety({
      previousMemory: legacy,
      proposedMemory: `${legacy}\n- 안전한 새 요약\n`,
      transcriptContext: '',
    })).toBeNull();
    expect(inspectProjectMemoryOutputSafety({
      previousMemory: previous,
      proposedMemory: previous,
      sessionNarrative: 'GITHUB_TOKEN=github_pat_' + 'abcdefghijklmnopqrstuvwxyz012345',
      transcriptContext: '',
    })).toEqual({ kind: 'high-confidence-secret' });
  });

  test('rejects newly emitted role-framed raw transcript structure', () => {
    const transcript = [
      'user: 첫 질문',
      'assistant: 첫 답변',
      'user: 다음 질문',
      'assistant: 다음 답변',
    ].join('\n');
    expect(inspectProjectMemoryOutputSafety({
      previousMemory: previous,
      proposedMemory: `${previous}\n${transcript}\n`,
      transcriptContext: transcript,
    })).toEqual({ kind: 'raw-transcript-structure' });
  });

  test('rejects short Korean role logs even when emitted as Markdown bullets', () => {
    const transcript = [
      '- 사용자: 첫 질문',
      '- 에이전트: 첫 답변',
      '- 사용자: 다음 질문',
      '- 에이전트: 다음 답변',
    ].join('\n');
    expect(inspectProjectMemoryOutputSafety({
      previousMemory: previous,
      proposedMemory: `${previous}\n${transcript}\n`,
      transcriptContext: transcript,
    })).toEqual({ kind: 'raw-transcript-structure' });
  });

  test('rejects Korean role logs that put whitespace before the colon', () => {
    const transcript = [
      '- 사용자 : 첫 질문',
      '- 에이전트 : 첫 답변',
      '- 사용자 : 다음 질문',
      '- 에이전트 : 다음 답변',
    ].join('\n');
    expect(inspectProjectMemoryOutputSafety({
      previousMemory: previous,
      proposedMemory: `${previous}\n${transcript}\n`,
      transcriptContext: transcript,
    })).toEqual({ kind: 'raw-transcript-structure' });
  });

  test('rejects full-width and Markdown-emphasized role logs', () => {
    for (const transcript of [
      ['- 사용자： 첫 질문', '- 에이전트： 첫 답변', '- 사용자： 다음 질문', '- 에이전트： 다음 답변'].join('\n'),
      ['- **User:** first', '- **Assistant:** reply', '- **User:** next', '- **Assistant:** done'].join('\n'),
    ]) {
      expect(inspectProjectMemoryOutputSafety({
        previousMemory: previous,
        proposedMemory: `${previous}\n${transcript}\n`,
        transcriptContext: transcript,
      })).toEqual({ kind: 'raw-transcript-structure' });
    }
  });

  test('rejects internationalized real email addresses', () => {
    const copied = '담당자 사용자@예시.한국';
    expect(inspectProjectMemoryOutputSafety({
      previousMemory: previous,
      proposedMemory: `${previous}\n- ${copied}\n`,
      transcriptContext: `[사용자]\n${copied}`,
    })).toEqual({ kind: 'direct-identifier' });
  });

  test('accepts a routine Last Updated date and a single API schema role example', () => {
    const prior = `${previous}\n**Last Updated**: 2026-09-04\n`;
    const proposed = `${previous}\n**Last Updated**: 2026-09-05\n- API schema: {"messages":[{"role":"user"}]}\n`;
    expect(inspectProjectMemoryOutputSafety({
      previousMemory: prior,
      proposedMemory: proposed,
      transcriptContext: '',
    })).toBeNull();
  });

  test('accepts build IDs, protocol header names, and reserved documentation emails', () => {
    const proposed = `${previous}\n- Build 12345678 passed.\n- TOKEN_HEADER=X-AgentsToZ-Remote-Control-Capability\n- Example: user@example.com\n- Upgrade react@19.1.0 after compatibility tests.\n- IPv4 192.168.100.200을 바인딩한다.\n- 테스트 포트 범위 3000-9000 사용.\n`;
    expect(inspectProjectMemoryOutputSafety({
      previousMemory: previous,
      proposedMemory: proposed,
      transcriptContext: '',
    })).toBeNull();
  });

  test('does not let a secret through merely because its variable name contains HEADER', () => {
    expect(inspectProjectMemoryOutputSafety({
      previousMemory: previous,
      proposedMemory: `${previous}\n- AUTH_HEADER_TOKEN=abcdefghijklmnopqrstuvwxyz0123456789\n`,
      transcriptContext: '',
    })).toEqual({ kind: 'high-confidence-secret' });
  });

  test('server invokes the guard after candidate validation and before backup/write/journal', () => {
    const source = readFileSync(join(root, 'project-memory-server.ts'), 'utf8');
    const updateStart = source.indexOf('export function prepareProjectMemoryUpdate');
    const updateEnd = source.indexOf('\nfunction loadPortalConfig', updateStart);
    const body = source.slice(updateStart, updateEnd);
    const guard = body.indexOf('inspectProjectMemoryOutputSafety({');
    expect(guard).toBeGreaterThan(body.indexOf('const next = stabilizeProjectMemoryEntryIds'));
    expect(guard).toBeLessThan(body.indexOf('backupMemory(root, memoryPath)'));
    expect(guard).toBeLessThan(body.indexOf('writeMemoryDocument(root, memoryPath, next)'));
    expect(guard).toBeLessThan(body.indexOf('markProjectMemoryRemembered({ folderPath: root, narrative },'));
    expect(body).toContain('PROJECT_MEMORY_UNSAFE_AGENT_OUTPUT');
    const update = body.slice(body.indexOf('export async function updateProjectMemory'));
    expect(update.indexOf('validatePreparedProjectMemoryUpdate(prepared,raw)')).toBeLessThan(update.indexOf('backupMemory(root, memoryPath)'));
  });
});
