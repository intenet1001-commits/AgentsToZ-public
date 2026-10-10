import {expect,test} from 'bun:test';
import {agentDialogueCommunityMemberLabel,agentDialogueCommunityView} from '../src/agentDialogueCommunity';

const me='e-me',members=[{endpointId:'e-me',displayName:'1호 총괄'},{endpointId:'e-two',displayName:'2호 총괄'}];

test('before the status arrives nothing is claimed and the button cannot be pressed',()=>{
  const view=agentDialogueCommunityView(null,me);
  expect(view.state).toBe('unknown');
  expect(view.action).toBeNull();
});

test('no community yet reads as empty, and entering creates it',()=>{
  const view=agentDialogueCommunityView({roomId:null,inside:false,members:[]},me);
  expect(view).toMatchObject({state:'empty',action:'join',actionLabel:'커뮤니티 입장',others:0});
});

test('inside counts the others, not myself, and offers leaving',()=>{
  const view=agentDialogueCommunityView({roomId:'r1',inside:true,members},me);
  expect(view).toMatchObject({state:'inside',others:1,action:'leave',actionLabel:'커뮤니티 나가기'});
  expect(view.headline).toContain('1개');
  const alone=agentDialogueCommunityView({roomId:'r1',inside:true,members:[members[0]!]},me);
  expect(alone.others).toBe(0);
  expect(alone.detail).toContain('아직 혼자');
});

test('outside an existing community says who is already in and that history stays hidden',()=>{
  const view=agentDialogueCommunityView({roomId:'r1',inside:false,members:[members[1]!]},me);
  expect(view).toMatchObject({state:'outside',others:1,action:'join'});
  expect(view.detail).toContain('입장 전에 지나간 대화는 보이지 않습니다');
});

test('a waiting message is said out loud, with what to do about it',()=>{
  const view=agentDialogueCommunityView({roomId:'r1',inside:true,members,unread:2},me);
  expect(view.unread).toBe(2);
  expect(view.headline).toContain('읽지 않음 2개');
  expect(view.waiting).toContain('AI에게');
  // Nothing waiting says nothing — an empty notice reads as a broken badge.
  expect(agentDialogueCommunityView({roomId:'r1',inside:true,members,unread:0},me).waiting).toBeNull();
  // A count that cannot be trusted is not shown as a number.
  for(const bad of [null,undefined,-1,Number.NaN,'3' as unknown as number])
    expect(agentDialogueCommunityView({roomId:'r1',inside:true,members,unread:bad as any},me).unread).toBe(0);
  // Outside the community there is nothing addressed to this endpoint yet.
  expect(agentDialogueCommunityView({roomId:'r1',inside:false,members,unread:5},me).unread).toBe(0);
});

test('malformed members are dropped and this device is marked in the list',()=>{
  const view=agentDialogueCommunityView({roomId:'r1',inside:true,
    members:[...members,...([null,{displayName:'no id'}] as any[])]},me);
  expect(view.members).toHaveLength(2);
  expect(agentDialogueCommunityMemberLabel(members[0]!,me)).toBe('1호 총괄 · 이 기기');
  expect(agentDialogueCommunityMemberLabel(members[1]!,me)).toBe('2호 총괄');
});
