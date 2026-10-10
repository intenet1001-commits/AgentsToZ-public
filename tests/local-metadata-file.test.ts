import {afterEach,expect,test} from 'bun:test';
import {mkdtempSync,mkdirSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readLocalMetadataFile,withoutDatalessMaterialization} from '../src/localMetadataFile';
const directories:string[]=[];
const fixture=()=>{const dir=mkdtempSync(join(tmpdir(),'local-metadata-'));directories.push(dir);return dir;};
afterEach(()=>{for(const dir of directories.splice(0))rmSync(dir,{recursive:true,force:true});});
test('reads bounded local Git metadata and preserves Unicode',()=>{
 const file=join(fixture(),'HEAD');writeFileSync(file,'ref: refs/heads/한글\n');
 expect(readLocalMetadataFile(file)).toBe('ref: refs/heads/한글\n');
 expect(readLocalMetadataFile(file,4)).toBeNull();
 expect(readLocalMetadataFile(file,0)).toBeNull();
 expect(readLocalMetadataFile(file,1e9)).toBeNull();
});
test('missing, directory and symlink metadata never become file contents',()=>{
 const root=fixture(),file=join(root,'HEAD');writeFileSync(file,'ref: refs/heads/main\n');
 expect(readLocalMetadataFile(join(root,'missing'))).toBeNull();
 mkdirSync(join(root,'directory'));expect(readLocalMetadataFile(join(root,'directory'))).toBeNull();
 if(process.platform!=='win32'){symlinkSync(file,join(root,'link'));expect(readLocalMetadataFile(join(root,'link'))).toBeNull();}
});
test.skipIf(process.platform==='win32')('a FIFO cannot block the API thread during discovery',()=>{
 const fifo=join(fixture(),'HEAD');const result=Bun.spawnSync(['mkfifo',fifo]);expect(result.exitCode).toBe(0);
 expect(readLocalMetadataFile(fifo)).toBeNull();
},1000);
test.skipIf(process.platform!=='darwin')('native no-download policy is limited to the current scope and restored after failures',()=>{
 const {dlopen,FFIType}=require('bun:ffi') as typeof import('bun:ffi');
 const library=dlopen('/usr/lib/libSystem.B.dylib',{getiopolicy_np:{args:[FFIType.i32,FFIType.i32],returns:FFIType.i32}});
 try{
  const read=()=>library.symbols.getiopolicy_np(3,1),before=read();
  withoutDatalessMaterialization(()=>{expect(read()).toBe(1);withoutDatalessMaterialization(()=>expect(read()).toBe(1));expect(read()).toBe(1);});
  expect(read()).toBe(before);
  expect(()=>withoutDatalessMaterialization(()=>{throw Error('fixture failure')})).toThrow('fixture failure');
  expect(read()).toBe(before);
 }finally{library.close();}
});
