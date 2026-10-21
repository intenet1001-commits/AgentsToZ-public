import {describe, expect, test} from 'bun:test';
import {
  applyCommunityMention,
  communityMentionDevice,
  communityMentionState,
  communityReferencesFor,
  communityReferenceToken,
  type CommunityMentionDeviceProjects,
} from '../src/workroomCommunityMention';
import {workroomDeliveryInstruction, type WorkroomMentionProject} from '../src/workroomProjectMention';

const project = (targetId: string, label: string): WorkroomMentionProject => ({targetId, label});
const LOCAL = [project('local-a', '포트관리기'), project('local-b', 'ShadowLoop')];
const DEVICES: CommunityMentionDeviceProjects[] = [
  {deviceId: 'ep-2', label: '아젠투지2호', projects: [project('two-ops', '총괄(아젠투지2호)'), project('two-blog', '블로그')]},
  {deviceId: 'ep-3', label: '아젠투지3호'},
];
const targets = {local: LOCAL, devices: DEVICES};

describe('the device name before @ or #', () => {
  test('names a community device by its full name, by its tail, and across a space', () => {
    expect(communityMentionDevice('아젠투지2호 ', DEVICES)?.device.deviceId).toBe('ep-2');
    expect(communityMentionDevice('2호 ', DEVICES)?.device.deviceId).toBe('ep-2');
    expect(communityMentionDevice('아젠투지 2호 ', DEVICES)?.device.deviceId).toBe('ep-2');
    expect(communityMentionDevice('이 작업은 아젠투지3호 ', DEVICES)?.device.deviceId).toBe('ep-3');
  });

  test('matches a piece of a compound name — the real 「아젠투지3호-회사」 answers to 3호', () => {
    const live: CommunityMentionDeviceProjects[] = [{deviceId: 'ep-2', label: '아젠투지2호'}, {deviceId: 'ep-3', label: '아젠투지3호-회사'}];
    expect(communityMentionDevice('3호 ', live)?.device.deviceId).toBe('ep-3');
    expect(communityMentionDevice('아젠투지3호 ', live)?.device.deviceId).toBe('ep-3');
    expect(communityMentionDevice('회사 ', live)?.device.deviceId).toBe('ep-3');
    expect(communityMentionDevice('아젠투지3호-회사 ', live)?.device.deviceId).toBe('ep-3');
    expect(communityMentionDevice('2호 ', live)?.device.deviceId).toBe('ep-2');
  });

  test('starts at the device name, so selecting replaces the whole token', () => {
    const before = '먼저 아젠투지2호 ';
    expect(communityMentionDevice(before, DEVICES)?.start).toBe(before.indexOf('아젠투지2호'));
  });

  test('never guesses: ambiguous or unknown names match no device', () => {
    const twins: CommunityMentionDeviceProjects[] = [{deviceId: 'a', label: '아젠투지2호'}, {deviceId: 'b', label: '백업2호'}];
    expect(communityMentionDevice('2호 ', twins)).toBeNull();
    expect(communityMentionDevice('4호 ', DEVICES)).toBeNull();
    expect(communityMentionDevice('', DEVICES)).toBeNull();
    // A single character is too little to name a device.
    expect(communityMentionDevice('호 ', DEVICES)).toBeNull();
  });
});

describe('the mention candidates', () => {
  test('stay local when no device is named', () => {
    const state = communityMentionState('@포트', 4, targets)!;
    expect(state.device).toBeNull();
    expect(state.candidates.map(p => p.label)).toEqual(['포트관리기']);
  });

  test('come from the named device, and the token starts at its name', () => {
    const value = '아젠투지2호 @블로';
    const state = communityMentionState(value, value.length, targets)!;
    expect(state.device?.deviceId).toBe('ep-2');
    expect(state.candidates.map(p => p.label)).toEqual(['블로그']);
    expect(state.start).toBe(0);
    expect(state.loading).toBe(false);
  });

  test('report that a device list has not arrived yet instead of showing none', () => {
    const value = '3호 @';
    const state = communityMentionState(value, value.length, targets)!;
    expect(state.device?.deviceId).toBe('ep-3');
    expect(state.loading).toBe(true);
    expect(state.candidates).toEqual([]);
  });

  test('carry the device list error through', () => {
    const failing = [{deviceId: 'ep-3', label: '아젠투지3호', error: '응답이 없습니다.'}];
    const value = '3호 @';
    const state = communityMentionState(value, value.length, {local: LOCAL, devices: failing})!;
    expect(state.loading).toBe(false);
    expect(state.error).toBe('응답이 없습니다.');
  });
});

describe('selecting a candidate', () => {
  test('@ removes the device name with the token and leaves the rest of the draft', () => {
    const value = '아젠투지2호 @블로 배포 좀 봐 줘';
    const cursor = '아젠투지2호 @블로'.length;
    const state = communityMentionState(value, cursor, targets)!;
    const applied = applyCommunityMention(state, value, cursor, project('two-blog', '블로그'));
    expect(applied.value).toBe('배포 좀 봐 줘');
    expect(applied.cursor).toBe(0);
    expect(applied.token).toBe('');
  });

  test('# keeps a readable token that names the device', () => {
    const value = '아젠투지2호 #블로';
    const state = communityMentionState(value, value.length, targets)!;
    const applied = applyCommunityMention(state, value, value.length, project('two-blog', '블로그'));
    expect(applied.value).toBe('#아젠투지2호/블로그 ');
    expect(applied.token).toBe('#아젠투지2호/블로그');
    expect(communityReferenceToken('아젠투지2호', '블로그')).toBe('#아젠투지2호/블로그');
    expect(communityReferenceToken(null, '블로그')).toBe('#블로그');
  });

  test('a local # token is unchanged, so old drafts keep working', () => {
    const value = '#Shadow';
    const state = communityMentionState(value, value.length, targets)!;
    expect(applyCommunityMention(state, value, value.length, project('local-b', 'ShadowLoop')).value).toBe('#ShadowLoop ');
  });
});

describe('which # references travel as folders', () => {
  const chips = [
    {deviceId: '', targetId: 'local-b', label: 'ShadowLoop', token: '#ShadowLoop'},
    {deviceId: 'ep-2', targetId: 'two-blog', label: '블로그', token: '#아젠투지2호/블로그'},
  ];
  const text = '#ShadowLoop 과 #아젠투지2호/블로그 를 참고해';

  test('only the receiving device’s own references do; the others are reported as dropped', () => {
    expect(communityReferencesFor(chips, text, 'ep-2')).toEqual({references: ['two-blog'], dropped: [chips[0]!]});
    expect(communityReferencesFor(chips, text, '')).toEqual({references: ['local-b'], dropped: [chips[1]!]});
  });

  test('a reference whose token was deleted from the text is dropped entirely', () => {
    expect(communityReferencesFor(chips, '#ShadowLoop 만 참고해', '')).toEqual({references: ['local-b'], dropped: []});
  });
});

test('the handoff names the sending device so the receiver knows which Mac to report to', () => {
  const instruction = workroomDeliveryInstruction({
    task: '배포 로그 확인해 줘', sourceLabel: 'AgentsToZ-OPS', sourceAgentLabel: 'Claude',
    sourceDeviceLabel: '아젠투지1호', targetLabel: '아젠투지2호 · 블로그',
  });
  expect(instruction.split('\n').slice(0, 5)).toEqual([
    'AgentsToZ 프로젝트 전달', '보낸 프로젝트: AgentsToZ-OPS', '보낸 AI: Claude', '보낸 기기: 아젠투지1호', '받는 프로젝트: 아젠투지2호 · 블로그',
  ]);
  // Without a device the handoff is byte-identical to before.
  expect(workroomDeliveryInstruction({task: 'x', sourceLabel: 'A', sourceAgentLabel: 'Claude', targetLabel: 'B'}))
    .toBe(['AgentsToZ 프로젝트 전달', '보낸 프로젝트: A', '보낸 AI: Claude', '받는 프로젝트: B', '', 'x'].join('\n'));
});
