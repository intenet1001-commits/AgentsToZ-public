import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { findRemoteVocDevProject, selectRemoteVocTransportProject } from '../src/remoteVocTargeting';

const project = (
  controlId: string,
  name: string,
  role: 'ops' | 'dev' | 'managed' | 'unknown' = 'unknown',
  kind: 'main' | 'worktree' = 'main',
) => ({ controlId, name, role, kind });

describe('휴대폰 VOC 대상 분리', () => {
  test('DEV가 없어도 검증된 메인 프로젝트를 VOC 저장용 전송 대상으로 쓴다', () => {
    const projects = [
      project('worktree-1', 'feature', 'managed', 'worktree'),
      project('main-1', '이현이지하철'),
    ];

    expect(findRemoteVocDevProject(projects)).toBeNull();
    expect(selectRemoteVocTransportProject(projects)?.controlId).toBe('main-1');
  });

  test('DEV가 있으면 저장과 워크룸 모두 같은 DEV를 우선한다', () => {
    const projects = [
      project('main-1', '다른 프로젝트'),
      project('dev-1', 'AgentsToZ_byCS', 'dev'),
    ];

    expect(findRemoteVocDevProject(projects)?.controlId).toBe('dev-1');
    expect(selectRemoteVocTransportProject(projects)?.controlId).toBe('dev-1');
  });

  test('레거시 DEV 이름을 지원하고, 메인이 없을 때만 워크트리를 전송에 쓴다', () => {
    const legacy = [project('legacy-dev', 'AgentsToZ_byCS')];
    expect(findRemoteVocDevProject(legacy)?.controlId).toBe('legacy-dev');

    const onlyWorktree = [project('worktree-1', 'feature', 'managed', 'worktree')];
    expect(selectRemoteVocTransportProject(onlyWorktree)?.controlId).toBe('worktree-1');
    expect(selectRemoteVocTransportProject([])).toBeNull();
  });

  test('포털은 VOC를 먼저 저장하고 DEV 워크룸은 그 뒤에 시도한다', () => {
    const source = readFileSync(new URL('../src/remote-control-portal-main.tsx', import.meta.url), 'utf8');
    const submit = source.slice(source.indexOf('const submitVoc='), source.indexOf('const openVocComposer='));
    const sendAt = submit.indexOf('const receipt=await sendRemoteVoc');
    const devAfterSaveAt = submit.indexOf('const dev=await findDevProject()', sendAt);

    expect(sendAt).toBeGreaterThan(-1);
    expect(devAfterSaveAt).toBeGreaterThan(sendAt);
    expect(submit).toContain('VOC를 Mac에 저장했습니다');
    expect(submit).toContain('「쌓인 VOC」에서 중복 없이 다시 처리할 수 있습니다.');
    expect(submit).not.toContain('목록을 새로고침한 뒤 다시 보내 주세요.');
    // A VOC held on the phone is not a failure: the composer closes, the capture stays, nothing invites a resend.
    expect(submit).toContain('if(errorToken(reason)===VOC_HELD_ON_PHONE)return null');
    expect(submit).toContain("return 'held' as const");
    expect(source).toContain("if (id && outcome !== 'held') await");
  });

  test('쌓인 VOC 조회도 DEV가 아니라 안전한 전송 프로젝트를 사용한다', () => {
    const source = readFileSync(new URL('../src/remote-control-portal-main.tsx', import.meta.url), 'utf8');
    const loadInbox = source.slice(source.indexOf('const loadVocInbox='), source.indexOf('const openVocHub='));
    expect(loadInbox).toContain('const transport=await findVocTransportProject()');
    expect(loadInbox).toContain('targetId:transport.controlId');
    expect(loadInbox).not.toContain('const dev=await findDevProject()');
  });
});
