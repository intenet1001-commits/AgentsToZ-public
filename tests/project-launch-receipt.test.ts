import {describe, expect, test} from 'bun:test';
import {lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {FileProjectLaunchReceiptStore, ProjectCreationCoordinator, projectCreationFingerprint, projectLaunchDirectoryIdentity, type ProjectCreationReceipt} from '../src/projectLaunchReceipt';

const day = 24 * 60 * 60_000;
function fixture(limit = 4096) {
  const dir = mkdtempSync(join(tmpdir(), 'project-launch-receipt-'));
  const root = join(dir, 'root'); mkdirSync(root);
  let now = Date.parse('2026-09-10T00:00:00Z');
  const store = new FileProjectLaunchReceiptStore(dir, () => now, limit);
  const input = {controllerId:'lan:controller-1',requestId:'create-1',workspaceRootId:'root-1',rootIdentityHash:projectLaunchDirectoryIdentity(root),fingerprint:projectCreationFingerprint('root-1',projectLaunchDirectoryIdentity(root),'hello'),expiresAt:new Date(now+30*day).toISOString()};
  const registrations = new Map<string,string>(); let calls = 0;
  const deps = {
    async create(receipt:ProjectCreationReceipt, directory:(id:string)=>Promise<void>, registered:(id:string)=>Promise<void>) {
      calls++; const path=join(root,receipt.projectId);mkdirSync(path);
      const identity=projectLaunchDirectoryIdentity(path);await directory(identity);registrations.set(receipt.projectId,path);await registered(identity);
    },
    async verifyRegistered(receipt:ProjectCreationReceipt) { const path=registrations.get(receipt.projectId);return !!path && projectLaunchDirectoryIdentity(path)===receipt.projectIdentityHash; },
  };
  return {dir,root,store,input,deps,registrations,calls:()=>calls,advance:(milliseconds:number)=>{now+=milliseconds;},cleanup:()=>rmSync(dir,{recursive:true,force:true})};
}

describe('durable exact project creation receipts',()=>{
  test('coalesces clicks, retains exact UUID and reuses it after coordinator restart',async()=>{
    const f=fixture();try{
      const coordinator=new ProjectCreationCoordinator(f.store);
      const [a,b]=await Promise.all([coordinator.create(f.input,f.deps),coordinator.create(f.input,f.deps)]);
      expect(a).toEqual(b);expect(f.calls()).toBe(1);
      const restarted=new ProjectCreationCoordinator(new FileProjectLaunchReceiptStore(f.dir, f.store.now));
      expect(await restarted.create(f.input,f.deps)).toEqual(a);expect(f.calls()).toBe(1);
      const serialized=readFileSync(join(f.dir,'remote-control/project-launch-receipts.json'),'utf8');
      expect(serialized).not.toContain(f.root);expect(serialized).not.toContain('hello');
      expect(lstatSync(join(f.dir,'remote-control/project-launch-receipts.json')).mode&0o077).toBe(0);
    }finally{f.cleanup();}
  });
  test('keeps interrupted mkdir outcome fenced and refuses name-based adoption',async()=>{
    const f=fixture();try{
      const coordinator=new ProjectCreationCoordinator(f.store);let calls=0;
      const interrupted={...f.deps,create:async()=>{calls++;throw Error('response lost before directory evidence');}};
      await expect(coordinator.create(f.input,interrupted)).rejects.toThrow('response lost');
      await expect(new ProjectCreationCoordinator(f.store).create(f.input,interrupted)).rejects.toMatchObject({code:'PROJECT_CREATE_RECOVERY_REQUIRED'});
      expect(calls).toBe(1);
    }finally{f.cleanup();}
  });
  test('recovers registered project after a later failure without duplicate setup',async()=>{
    const f=fixture();try{
      const afterRegistration={...f.deps,create:async(...args:Parameters<typeof f.deps.create>)=>{await f.deps.create(...args);throw Error('receipt response lost');}};
      await expect(new ProjectCreationCoordinator(f.store).create(f.input,afterRegistration)).rejects.toThrow('response lost');
      const recovered=await new ProjectCreationCoordinator(f.store).create(f.input,f.deps);
      expect(f.registrations.has(recovered.internalId)).toBe(true);expect(f.calls()).toBe(1);
    }finally{f.cleanup();}
  });
  test('rejects changed fingerprint, root inode and replaced project directories',async()=>{
    const f=fixture();try{
      const c=new ProjectCreationCoordinator(f.store);const result=await c.create(f.input,f.deps);
      await expect(c.create({...f.input,fingerprint:'a'.repeat(64)},f.deps)).rejects.toMatchObject({code:'ACTION_ID_REUSED'});
      await expect(c.create({...f.input,rootIdentityHash:'b'.repeat(64)},f.deps)).rejects.toMatchObject({code:'ACTION_ID_REUSED'});
      const path=f.registrations.get(result.internalId)!;renameSync(path,path+'-old');mkdirSync(path);
      await expect(c.create(f.input,f.deps)).rejects.toMatchObject({code:'PROJECT_CREATE_RECOVERY_REQUIRED'});expect(f.calls()).toBe(1);
    }finally{f.cleanup();}
  });
  test('created-root grant evidence binds controller/root/project and expires at the approved 30-day boundary',async()=>{
    const f=fixture();try{
      const result=await new ProjectCreationCoordinator(f.store).create(f.input,f.deps);
      const query={controllerId:f.input.controllerId,projectId:result.internalId,workspaceRootId:f.input.workspaceRootId,rootIdentityHash:f.input.rootIdentityHash};
      expect(await f.store.findCreatedProject(query)).toMatchObject({state:'registered'});
      expect(await f.store.findCreatedProject({...query,controllerId:'lan:other'})).toBeNull();
      expect(await f.store.findCreatedProject({...query,rootIdentityHash:'c'.repeat(64)})).toBeNull();
      expect(await f.store.findCreatedProject({...query,projectId:'another'})).toBeNull();
      f.advance(30*day-1);expect(await f.store.findCreatedProject(query)).not.toBeNull();
      f.advance(1);expect(await f.store.findCreatedProject(query)).toBeNull();
    }finally{f.cleanup();}
  });
  test('capacity never evicts unresolved receipts; corrupt storage never performs create',async()=>{
    const f=fixture(1);try{
      await f.store.reserve(f.input);f.advance(31*day);
      await expect(f.store.reserve({...f.input,requestId:'create-2',expiresAt:new Date(f.store.now()+day).toISOString()})).rejects.toMatchObject({code:'PROJECT_RECEIPT_CAPACITY'});
      writeFileSync(join(f.dir,'remote-control/project-launch-receipts.json'),'bad json');
      await expect(new ProjectCreationCoordinator(f.store).create(f.input,f.deps)).rejects.toMatchObject({code:'PROJECT_RECEIPT_UNAVAILABLE'});expect(f.calls()).toBe(0);
    }finally{f.cleanup();}
  });
});
