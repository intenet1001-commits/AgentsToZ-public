import {afterEach, expect, test} from 'bun:test';
import {mkdirSync, mkdtempSync, realpathSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {resolveOpsSurfaceProject} from '../src/controlProfileSurface';

const roots: string[] = [];
afterEach(() => {for (const root of roots.splice(0)) rmSync(root, {recursive:true, force:true});});
function fixture() {
  const root=realpathSync(mkdtempSync(join(tmpdir(),'ops-binding-')));roots.push(root);
  let binding={profileId:'profile',memoryId:'memory',projectId:'project',root,backend:'control-folder'};
  let rows: Array<{id:string;folderPath:string;worktreePath?:string;worktreeParentId?:string}>=[{id:'project',folderPath:root}];
  return {root, get binding(){return binding;},set binding(value){binding=value;},get rows(){return rows;},set rows(value){rows=value;},
    input:{readBinding:()=>({...binding}),resolveProject:async()=>({projectId:'project',projectName:'not-authority',canonicalPath:root,memoryId:'memory'}),registered:async()=>rows}};
}
test('a profile switch while resolving a launch fails closed', async()=>{
  const f=fixture();const original=f.input.resolveProject;
  f.input.resolveProject=async()=>{f.binding={...f.binding,profileId:'different-profile'};return original();};
  await expect(resolveOpsSurfaceProject(f.input)).rejects.toMatchObject({code:'CONTROL_PROFILE_SURFACE_MISMATCH'});
});
test('duplicate rows and linked-worktree launch hints cannot impersonate the bound OPS root', async()=>{
  const f=fixture();const child=join(f.root,'linked');mkdirSync(child);
  for(const rows of [[f.rows[0]!,f.rows[0]!],[{id:'project',folderPath:f.root,worktreePath:child}],[{id:'project',folderPath:f.root,worktreeParentId:'other-project'}]]){
    f.rows=rows;
    await expect(resolveOpsSurfaceProject(f.input)).rejects.toMatchObject({code:'CONTROL_PROFILE_SURFACE_MISMATCH'});
  }
});
test('OPS resolves the actual bound memory and emits only an OPS display label', async()=>{
  const f=fixture();
  expect(await resolveOpsSurfaceProject(f.input)).toMatchObject({projectId:'project',memoryId:'memory',projectName:'AgentsToZ OPS',canonicalPath:f.root});
});
