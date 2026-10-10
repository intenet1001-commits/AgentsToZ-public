import {describe,expect,test} from 'bun:test';
import {LOCAL_COMMUNITY_MESSAGE_LIMIT, LOCAL_COMMUNITY_TEXT_LIMIT, REMOTE_COMMUNITY_BUDGET_BYTES, REMOTE_COMMUNITY_DEVICE_LIMIT, REMOTE_COMMUNITY_FORWARD_BUSY_ERROR, REMOTE_COMMUNITY_MEMBER_LIMIT, REMOTE_COMMUNITY_MESSAGE_LIMIT, REMOTE_COMMUNITY_TEXT_LIMIT, createCommunityForwardGate, mergeRemoteCommunityMessages, normalizeRemoteCommunityState, normalizeRemoteCommunityText, remoteCommunityState} from '../src/remoteCommunity';
import {TERMINAL_QUEUE_BACKGROUND_LIMIT,TERMINAL_QUEUE_LIMIT,TERMINAL_QUEUE_VOICE_LIMIT,
  terminalQueueRejection} from '../src/remoteControlRelayController';

const members=[
  {endpointId:'e1',participantId:'p1',displayName:'아젠투지 1호 / 아젠투지(OPS)',kind:'ops'},
  {endpointId:'e2',participantId:'p2',displayName:'아젠투지2호 / 아젠투지(OPS)',kind:'ops'},
  {endpointId:'e3',participantId:'p3',displayName:'아젠투지3호-회사 / 아젠투지(OPS)',kind:'ops'},
];
const messages=[
  {seq:7,kind:'message',messageKind:'question',text:'빌드 상태 알려줘',senderParticipantId:'p1',createdAt:'2026-10-05T01:13:08Z'},
  {seq:8,kind:'joined',senderParticipantId:'p2'},
  {seq:9,kind:'message',messageKind:'answer',text:'완료했습니다',senderParticipantId:'p3',createdAt:'2026-10-05T01:49:13Z'},
];

test('the phone sees who is in the community and who said what',()=>{
  const state=remoteCommunityState({inside:true,roomId:'r1',unread:1,nextSeq:9,members,messages,
    selfEndpointId:'e1',selfParticipantId:'p1'});
  expect(state.inside).toBe(true);
  expect(state.members.map(m=>m.self)).toEqual([true,false,false]);
  expect(state.unread).toBe(1);
  // Join/leave events are not messages.
  expect(state.messages.map(m=>m.seq)).toEqual([7,9]);
  expect(state.messages[0]).toMatchObject({from:'아젠투지 1호 / 아젠투지(OPS)',self:true,kind:'question'});
  expect(state.messages[1]).toMatchObject({from:'아젠투지3호-회사 / 아젠투지(OPS)',self:false,text:'완료했습니다'});
});

test('no identifier ever reaches the phone except the room id',()=>{
  const state=remoteCommunityState({inside:true,roomId:'r1',members,messages,selfEndpointId:'e1',selfParticipantId:'p1'});
  const wire=JSON.stringify(state);
  for(const secret of ['e1','e2','e3','p1','p2','p3'])
    expect(wire.includes(`"${secret}"`)).toBe(false);
  expect(state.roomId).toBe('r1');
});

test('a long message is cut and says so, and the relay budget is respected',()=>{
  const long='가'.repeat(REMOTE_COMMUNITY_TEXT_LIMIT+200);
  const state=remoteCommunityState({inside:true,roomId:'r1',members,
    messages:[{seq:1,kind:'message',messageKind:'observation',text:long,senderParticipantId:'p2',createdAt:'x'}]});
  expect(state.messages[0]!.text.length).toBe(REMOTE_COMMUNITY_TEXT_LIMIT);
  expect(state.messages[0]!.truncated).toBe(true);
  // 16 members + 8 messages must still fit one relay envelope (11,000 bytes plaintext).
  const full=remoteCommunityState({inside:true,roomId:'r1',unread:8,nextSeq:99,
    members:Array.from({length:30},(_,i)=>({endpointId:`e${i}`,participantId:`p${i}`,displayName:`아젠투지${i}호 / 아젠투지(OPS)`,kind:'ops'})),
    messages:Array.from({length:20},(_,i)=>({seq:i,kind:'message',messageKind:'observation',text:long,senderParticipantId:'p1',createdAt:'2026-10-05T01:49:13Z'}))});
  expect(full.members).toHaveLength(REMOTE_COMMUNITY_MEMBER_LIMIT);
  expect(full.moreMembers).toBe(18);
  // ⚠️ Korean is 3 bytes a character: 16 members + 8 messages of 400 chars measured 12,053 bytes,
  // over the 8,500 workspace response cap. Reads come oldest-first, so the payload keeps the oldest and
  // defers the newer ones — the cursor stops at the last shown message so nothing is skipped (2026-10-06 review).
  expect(new TextEncoder().encode(JSON.stringify(full)).length).toBeLessThanOrEqual(REMOTE_COMMUNITY_BUDGET_BYTES);
  expect(full.messages.length).toBeGreaterThan(0);
  expect(full.messages[0]!.seq).toBe(0);
  expect(full.nextSeq).toBe(full.messages.at(-1)!.seq);
});

test('a Mac that has not entered the community says so instead of pretending',()=>{
  expect(remoteCommunityState({})).toMatchObject({inside:false,roomId:null,unread:0,members:[],messages:[]});
  expect(remoteCommunityState({inside:false,roomId:'r1',members})).toMatchObject({inside:false,roomId:'r1'});
});

test('what the phone types is checked before it reaches another device',()=>{
  expect(normalizeRemoteCommunityText('  2호 빌드 상태 알려줘  ')).toBe('2호 빌드 상태 알려줘');
  expect(normalizeRemoteCommunityText('첫 줄\r\n둘째 줄')).toBe('첫 줄\n둘째 줄');
  for(const bad of ['','   ',42,null,undefined,'제어\u0007문자','가'.repeat(1_000)])
    expect(()=>normalizeRemoteCommunityText(bad)).toThrow();
});

test('the phone validates the shaped payload it received, and keeps what it holds', () => {
  const shaped = remoteCommunityState({
    inside: true, roomId: '3c104d60-eae6-4823-a977-7aeed27c6532', unread: 2, nextSeq: 9,
    selfParticipantId: 'p-1', selfEndpointId: 'e-1',
    members: [{endpointId: 'e-1', participantId: 'p-1', displayName: '1호 총괄', kind: 'ops'},
      {endpointId: 'e-2', participantId: 'p-2', displayName: '3호 총괄', kind: 'ops'}],
    devices: [{ref: 'ab12ef3456789012', name: '3호 맥', kind: 'ops'}],
    messages: [{seq: 8, kind: 'message', messageKind: 'question', text: '배포 상태 알려줘',
      senderParticipantId: 'p-2', createdAt: '2026-10-05T01:02:03.000Z'}],
  });
  // 깎은 결과가 그대로 통과한다 — 두 함수가 같은 규격을 말해야 목록이 사라지지 않는다.
  expect(normalizeRemoteCommunityState(JSON.parse(JSON.stringify(shaped)))).toEqual(shaped);
  expect(shaped.devices).toEqual([{ref: 'ab12ef3456789012', name: '3호 맥', kind: 'ops'}]);
  // 모르는 키·잘못된 참조·한계를 넘는 목록은 거절한다.
  expect(() => normalizeRemoteCommunityState({...shaped, extra: 1})).toThrow();
  expect(() => normalizeRemoteCommunityState({...shaped, devices: [{ref: 'ZZ', name: '3호', kind: 'ops'}]})).toThrow();
  expect(() => normalizeRemoteCommunityState({...shaped, members: [{name: '3호', kind: 'ops'}]})).toThrow();
  expect(() => normalizeRemoteCommunityState({...shaped, roomId: 'not-a-room'})).toThrow();
  expect(() => normalizeRemoteCommunityState(null)).toThrow();
});

test('a device that left is not shown, and hidden members are counted out loud', () => {
  const state = remoteCommunityState({
    inside: true, roomId: null, unread: 0, nextSeq: 1, selfEndpointId: 'e-1',
    members: Array.from({length: REMOTE_COMMUNITY_MEMBER_LIMIT + 4}, (_, index) =>
      ({endpointId: 'e-' + index, displayName: '대상 ' + index, kind: 'ops'})),
    devices: Array.from({length: 11}, (_, index) =>
      ({ref: String(index).padStart(16, '0'), name: '기기 ' + index, kind: 'ops'})),
  });
  expect(state.members.length).toBe(REMOTE_COMMUNITY_MEMBER_LIMIT);
  expect(state.moreMembers).toBe(4);
  expect(state.devices.length).toBe(REMOTE_COMMUNITY_DEVICE_LIMIT);
  // 이름 없는 기기 줄은 버린다(이름 없이는 어느 기기인지 말할 수 없다).
  expect(remoteCommunityState({devices: [{ref: '0'.repeat(16), name: '   '}]}).devices).toEqual([]);
});

test('the phone keeps the messages it holds when a poll brings nothing new', () => {
  const message = (seq: number, text: string) =>
    ({seq, from: '3호', self: false, kind: 'question', text, at: '2026-10-05T01:00:00.000Z'});
  const held = [message(4, '첫 번째'), message(5, '두 번째')];
  // 따라잡은 뒤의 폴링은 빈 배열을 준다 — 가진 것이 남아야 한다(여기서 비면 「사라졌다」가 된다).
  expect(mergeRemoteCommunityMessages(held, [])).toEqual(held);
  // 새 것은 뒤에 붙고, 같은 seq는 새 것이 이긴다.
  expect(mergeRemoteCommunityMessages(held, [message(5, '고쳐진 두 번째'), message(6, '세 번째')]).map(m => m.text))
    .toEqual(['첫 번째', '고쳐진 두 번째', '세 번째']);
  // 최근 몇 건만 남긴다 — 릴레이 한 통에 들어가야 한다.
  const many = Array.from({length: 12}, (_, index) => message(index, '말 ' + index));
  expect(mergeRemoteCommunityMessages(many, [message(99, '마지막')]).length).toBe(REMOTE_COMMUNITY_MESSAGE_LIMIT);
  expect(mergeRemoteCommunityMessages(many, [message(99, '마지막')]).at(-1)!.text).toBe('마지막');
});

test('a device that does not answer cannot fill the phone relay queue', async () => {
  const gate = createCommunityForwardGate(2);
  const releases: Array<() => void> = [];
  const stuck = () => new Promise<string>(resolve => {releases.push(() => resolve('late'));});
  const first = gate.run(stuck), second = gate.run(stuck);
  expect(gate.inFlight).toBe(2);
  // 세 번째는 **쌓이지 않고** 바로 거절한다 — 쌓이면 릴레이 대기열이 차서 원인이 가려진다.
  await expect(gate.run(async () => 'third')).rejects.toThrow(REMOTE_COMMUNITY_FORWARD_BUSY_ERROR);
  releases[0]!();
  await first;
  // 자리가 비면 다시 보낼 수 있다(배경 조회는 다음 주기에 다시 온다).
  expect(await gate.run(async () => 'ok')).toBe('ok');
  releases[1]!();
  await second;
  expect(gate.inFlight).toBe(0);
  // 실패한 요청도 자리를 돌려준다.
  await expect(gate.run(async () => {throw new Error('그 Mac이 답하지 않습니다');})).rejects.toThrow('답하지 않습니다');
  expect(gate.inFlight).toBe(0);
});

test('a long relay queue never blocks what the person just tapped', () => {
  // 조회(read·list·*.status)와 음성은 자기 상한에서 먼저 거절되고, 사람이 누른 요청은 자리가 남는다.
  const full = {total: 24, background: TERMINAL_QUEUE_BACKGROUND_LIMIT, voice: 0};
  expect(terminalQueueRejection(full, {background: true, voice: false})).toContain('대기 중인 원격 입력이 많습니다');
  expect(terminalQueueRejection(full, {background: false, voice: false})).toBeNull();
  const voiceFull = {total: 20, background: 2, voice: TERMINAL_QUEUE_VOICE_LIMIT};
  expect(terminalQueueRejection(voiceFull, {background: false, voice: true})).toContain('음성 8');
  expect(terminalQueueRejection(voiceFull, {background: false, voice: false})).toBeNull();
  // 전체가 찬 뒤에는 사람이 누른 것도 거절한다 — 그때는 무엇이 채웠는지 문구가 말한다.
  const jammed = {total: TERMINAL_QUEUE_LIMIT, background: 16, voice: 8};
  expect(terminalQueueRejection(jammed, {background: false, voice: false}))
    .toBe('대기 중인 원격 입력이 많습니다 (조회 16 · 음성 8 · 전체 32). 잠시 후 다시 시도하세요.');
});

test('the community screen hides what belongs to other panes', async () => {
  // ⚠️ 이 pane에는 숨김 규칙이 한 줄도 없어서 프로젝트 목록·OPS 카드·빈 터미널 상자가 함께 깔렸다
  // (2026-10-05 감사). pane 값이 늘 때마다 손으로 맞춰야 하는 구조라 테스트로 고정한다.
  const css = await Bun.file(new URL('../src/remote-control-portal.css', import.meta.url)).text();
  for (const hidden of ['.remote-project-create', '.remote-project-filter', '.remote-projects',
    '.remote-workroom-content', '.remote-ops-control'])
    expect(css).toContain(`.remote-shell[data-remote-pane="community"] ${hidden}`);
});

describe('맥 경로는 휴대폰 릴레이 예산을 쓰지 않는다 (2026-10-06)', () => {
  const row = (seq: number, text: string) => ({
    seq, kind: 'message', messageKind: 'question', text,
    senderParticipantId: 'p-other', createdAt: '2026-10-06T00:00:00Z',
  });
  const members = [{endpointId: 'e-other', participantId: 'p-other', displayName: '아젠투지2호', kind: 'ops'}];
  const host = (count: number, text: string) => ({
    inside: true, roomId: '22222222-2222-4222-8222-222222222222', unread: 0,
    nextSeq: count + 1, members, devices: [],
    messages: Array.from({length: count}, (_, index) => row(index + 1, text)),
    selfParticipantId: 'p-self', selfEndpointId: 'e-self',
  });

  test('휴대폰 기본값은 그대로 5건·240자다', () => {
    const phone = remoteCommunityState(host(9, 'x'.repeat(400)));
    expect(phone.messages).toHaveLength(REMOTE_COMMUNITY_MESSAGE_LIMIT);
    expect(phone.messages[0]!.text.length).toBeLessThanOrEqual(REMOTE_COMMUNITY_TEXT_LIMIT);
    expect(phone.messages[0]!.truncated).toBe(true);
    // 읽기는 오래된 것부터 온다: 앞의 5건(1~5)을 싣고 커서는 5에서 멈춰 6~9가 다음 읽기에 온다.
    expect(phone.messages.map(m => m.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(phone.nextSeq).toBe(5);
  });

  test('맥 한도를 주면 더 싣고 덜 자른다', () => {
    const mac = remoteCommunityState(host(9, 'x'.repeat(400)), {messages: LOCAL_COMMUNITY_MESSAGE_LIMIT, text: LOCAL_COMMUNITY_TEXT_LIMIT});
    expect(mac.messages).toHaveLength(9);
    expect(mac.messages[0]!.text).toHaveLength(400);
    expect(mac.messages[0]!.truncated).toBeUndefined();
    expect(mac.nextSeq).toBe(10);
  });

  test('검사기도 같은 한도로 읽어야 한다 — 기본값으로 읽으면 통째로 거절된다', () => {
    const mac = remoteCommunityState(host(9, 'x'.repeat(400)), {messages: LOCAL_COMMUNITY_MESSAGE_LIMIT, text: LOCAL_COMMUNITY_TEXT_LIMIT});
    expect(() => normalizeRemoteCommunityState(mac)).toThrow();
    const checked = normalizeRemoteCommunityState(mac, {messages: LOCAL_COMMUNITY_MESSAGE_LIMIT, text: LOCAL_COMMUNITY_TEXT_LIMIT});
    expect(checked.messages).toHaveLength(9);
  });

  test('와이어 모양은 그대로다 — 새 키를 만들지 않는다(옛 휴대폰이 통째로 거절한다)', () => {
    const mac = remoteCommunityState(host(9, 'x'), {messages: LOCAL_COMMUNITY_MESSAGE_LIMIT, text: LOCAL_COMMUNITY_TEXT_LIMIT});
    expect(Object.keys(mac).sort()).toEqual(Object.keys(remoteCommunityState(host(2, 'x'))).sort());
    expect(Object.keys(mac.messages[0]!).sort()).toEqual(['at', 'from', 'kind', 'self', 'seq', 'text']);
  });
});


test('message times are shown in the viewer’s time zone, not UTC', () => {
  const previous = process.env.TZ;
  process.env.TZ = 'Asia/Seoul';
  try {
    const {communityMessageTime} = require('../src/remoteCommunity');
    expect(communityMessageTime('2026-10-07T10:04:00.000Z')).toBe('10-07 19:04');
    expect(communityMessageTime('not a date')).toBe('');
  } finally { process.env.TZ = previous; }
});
