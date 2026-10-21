import {expect,test} from 'bun:test';
import {createMobileWorkspaceGateway} from '../src/mobileWorkspaceGateway';
import {normalizeMobileWorkspaceRequest,workspaceScope,type MobileWorkspaceScope} from '../src/mobileWorkspaceProtocol';
import {DEVICE_MEMORY_TARGET} from '../src/deviceOperatingMemoryProtocol';
import {createMetaMemoryRemoteRequester} from '../src/metaCommonMemoryRemoteClient';
import {MetaCommonMemoryRemoteHost} from '../src/metaCommonMemoryRemoteHost';
test('device memory has its own opt-in, preserves host identity and rejects cross-device forwarding',async()=>{
 let scopes:MobileWorkspaceScope[]=['meta-memory.manage','common-memory.manage','memory.save'],calls=0;
 const host=new MetaCommonMemoryRemoteHost(async(_owner,raw,active,kind)=>{expect(active()).toBe(true);expect(kind).toBe('device');calls++;expect(raw).toEqual({operation:'read'});return {memory:{name:'host-owned'}};});
 const gateway=createMobileWorkspaceGateway({terminal:async()=>({}),active:()=>true,resolve:async()=>[],consent:async()=>({targetIds:new Set(),workspaceScopes:scopes,isActive:()=>true,requestOwner:'phone'}),perform:async()=>{throw Error('must not execute arbitrary project action');},deviceMemory:(r,owner,active,canImport)=>{expect(canImport()).toBe(false);return host.perform(owner,r,active,'device');}});
 const request=createMetaMemoryRemoteRequester(async r=>await gateway(r,[],'phone') as any,'device-memory',{rpcV2:true});
 await expect(request({operation:'read'})).rejects.toThrow('기기 운영기억');expect(calls).toBe(0);scopes=['ops-memory.manage'];expect((await request({operation:'read'})).memory.name).toBe('host-owned');expect(calls).toBe(1);
 const r={operation:'workspace',requestId:crypto.randomUUID(),targetId:DEVICE_MEMORY_TARGET,workspace:{action:'device-memory',meta:{phase:'release',rpcId:crypto.randomUUID(),hash:'a'.repeat(64)}}};expect(workspaceScope('device-memory')).toBe('ops-memory.manage');expect(()=>normalizeMobileWorkspaceRequest({...r,targetId:'other_device'})).toThrow();
 await expect(gateway(r as any,[],'phone',()=>true,'other_device')).rejects.toThrow('직접 연결');host.dispose();
});
