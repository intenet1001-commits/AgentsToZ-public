import {describe,expect,test} from 'bun:test';
import {CommunityAdapterAuthorization} from '../src/communityAdapterAuthorization';
import type {WorkroomEffortMode} from '../src/workroomEffortMode';

const now=1_793_622_000_000;
const reply=(capability='computer-use.browser')=>({success:true,halted:false,authorized:true,capability,
 communityId:'11111111-1111-4111-8111-111111111111',profileId:'22222222-2222-4222-8222-222222222222',
 deviceId:'33333333-3333-4333-8333-333333333333',revision:2,expiresAt:now+90_000,desktopGrant:false});
describe('purpose-specific common authentication adapter',()=>{
 test('only the verified Main can issue a witness, copies and other purposes are refused',async()=>{
  let trusted=false,calls=0;
  const host=new CommunityAdapterAuthorization({get verifiedMain(){return trusted;},async request(value){calls++;expect(value).toEqual({operation:'community-adapter-authorize',capability:'computer-use.browser'});return reply();}},()=>now);
  await expect(host.authorize('computer-use.browser')).rejects.toThrow();expect(calls).toBe(0);
  trusted=true;const witness=await host.authorize('computer-use.browser');expect(host.isCurrent(witness,'computer-use.browser')).toBe(true);
  expect(host.isCurrent({...witness},'computer-use.browser')).toBe(false);expect(host.isCurrent(witness,'computer-use.agent-settings')).toBe(false);
  trusted=false;expect(host.isCurrent(witness,'computer-use.browser')).toBe(false);host.dispose();
 });
 test('malformed, expired, overlong and wrong-purpose replies cannot authorize an adapter',async()=>{
  for(const edit of [{success:false},{desktopGrant:true},{halted:true},{extra:true},{revision:true},{revision:0},
   {deviceId:'machine-name'},{expiresAt:now},{expiresAt:now+90_001},{capability:'computer-use.agent-settings'}]){
   const host=new CommunityAdapterAuthorization({verifiedMain:true,async request(){return {...reply(),...edit};}},()=>now);
   await expect(host.authorize('computer-use.browser')).rejects.toThrow();host.dispose();
  }
 });
 test('late Main identity changes and policy rollback invalidate the result',async()=>{
  let trusted=true,revision=2,device=reply().deviceId;
  const host=new CommunityAdapterAuthorization({get verifiedMain(){return trusted;},async request(){return {...reply(),revision,deviceId:device};}},()=>now);
  const before=await host.authorize('computer-use.browser');revision=3;const after=await host.authorize('computer-use.browser');
  expect(host.isCurrent(before,'computer-use.browser')).toBe(false);expect(host.isCurrent(after,'computer-use.browser')).toBe(true);
  revision=2;await expect(host.authorize('computer-use.browser')).rejects.toThrow();revision=3;device='44444444-4444-4444-8444-444444444444';await expect(host.authorize('computer-use.browser')).rejects.toThrow();
  const late=new CommunityAdapterAuthorization({get verifiedMain(){return trusted;},async request(){trusted=false;return reply();}},()=>now);
  await expect(late.authorize('computer-use.browser')).rejects.toThrow();host.dispose();late.dispose();
 });
 test('CLI common authentication preserves this host mode, manual OFF and desktop advice',async()=>{
  let mode:WorkroomEffortMode='off',writes=0,clock=now;
  const host=new CommunityAdapterAuthorization({verifiedMain:true,async request(value){return reply(String(value.capability));}},()=>clock);
  const setting={get:()=>mode==='auto',getMode:()=>mode,set:()=>{writes++;return true;}};
  const off=await host.workroomEffortPolicy(setting);expect(off.mode).toBe('off');expect(off.isAuthorized()).toBe(true);
  mode='auto';expect(off.isAuthorized()).toBe(false);const auto=await host.workroomEffortPolicy(setting);expect(auto.mode).toBe('auto');
  expect(writes).toBe(0);clock=now+90_000;expect(auto.isAuthorized()).toBe(false);host.dispose();
 });
 test('concurrent purpose reads serialize, duplicate reads coalesce and any native refusal revokes existing witnesses',async()=>{
  let inFlight=0,maximum=0,calls=0,enabled=true;
  const host=new CommunityAdapterAuthorization({verifiedMain:true,async request(value){
   calls++;inFlight++;maximum=Math.max(maximum,inFlight);await new Promise(r=>setTimeout(r,1));inFlight--;
   if(!enabled)throw Error('native local off');return reply(String(value.capability));
  }},()=>now);
  const [first,second,effort]=await Promise.all([host.authorize('computer-use.browser'),host.authorize('computer-use.browser'),host.authorize('computer-use.agent-settings')]);
  expect(first).toBe(second);expect(calls).toBe(2);expect(maximum).toBe(1);expect(host.isCurrent(effort,'computer-use.agent-settings')).toBe(true);
  enabled=false;await expect(host.authorize('computer-use.browser')).rejects.toThrow('native local off');
  expect(host.isCurrent(first,'computer-use.browser')).toBe(false);expect(host.isCurrent(effort,'computer-use.agent-settings')).toBe(false);host.dispose();
 });
});
