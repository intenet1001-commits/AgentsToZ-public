import {expect,test} from 'bun:test';
import {communityRegistrationEntryState} from '../src/CommunityDeviceRegistration';
import type {ViewerHelperStatus} from '../src/useViewerHelper';

const ready=(patch:Partial<ViewerHelperStatus>={}):ViewerHelperStatus=>({supported:true,installed:true,bundled:true,running:false,updatePending:false,otherInstanceRunning:false,instanceStatusUnknown:false,...patch});
test('registration entry separates browser, checking and explicit native non-support',()=>{
  expect(communityRegistrationEntryState(false,null)).toBe('browser');
  expect(communityRegistrationEntryState(true,null)).toBe('checking');
  expect(communityRegistrationEntryState(true,ready({supported:false}))).toBe('unsupported');
  expect(communityRegistrationEntryState(true,ready({installed:false,bundled:false}))).toBe('missing');
});
test('a failed, unobserved, malformed or other-path helper never offers opening',()=>{
  expect(communityRegistrationEntryState(true,null,true)).toBe('unknown');
  expect(communityRegistrationEntryState(true,ready(),true)).toBe('unknown');
  expect(communityRegistrationEntryState(true,ready({instanceStatusUnknown:true,otherInstanceRunning:true}))).toBe('unknown');
  expect(communityRegistrationEntryState(true,ready({otherInstanceRunning:true}))).toBe('other-instance');
  for(const key of Object.keys(ready())){
    const malformed={...ready()} as Record<string,unknown>;delete malformed[key];
    expect(communityRegistrationEntryState(true,malformed as unknown as ViewerHelperStatus)).toBe('unknown');
  }
});
test('a running old helper waits for the person; a stopped pending helper can use the native guarded update/open path',()=>{
  expect(communityRegistrationEntryState(true,ready({running:true,updatePending:true}))).toBe('update-waiting');
  expect(communityRegistrationEntryState(true,ready({updatePending:true}))).toBe('available');
  expect(communityRegistrationEntryState(true,ready({installed:false,bundled:true}))).toBe('available');
  expect(communityRegistrationEntryState(true,ready({running:true}))).toBe('available');
});
