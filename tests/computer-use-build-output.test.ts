import {expect,test} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,realpathSync,symlinkSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {assertComputerUseBuildOutput} from '../scripts/computerUseBuildOutput';
test.skipIf(process.platform==='win32')('Control builds only new owned artifacts and cannot overwrite an installed or existing app',()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'control-output-'))),pkg=join(root,'package'),temporary=join(root,'temporary'),outside=join(root,'installed');
 for(const folder of [pkg,temporary,outside])mkdirSync(folder,{mode:0o700});mkdirSync(join(pkg,'.build'),{mode:0o700});
 try{
  const build=join(pkg,'.build','AgentsToZ Control.app');expect(()=>assertComputerUseBuildOutput(build,pkg,[temporary])).not.toThrow();
  mkdirSync(build);writeFileSync(join(build,'keep'),'existing');expect(()=>assertComputerUseBuildOutput(build,pkg,[temporary])).toThrow('existing');expect(readFileSync(join(build,'keep'),'utf8')).toBe('existing');
  expect(()=>assertComputerUseBuildOutput(join(outside,'AgentsToZ Control.app'),pkg,[temporary])).toThrow('build directory');
  expect(()=>assertComputerUseBuildOutput(join(temporary,'Wrong.app'),pkg,[temporary])).toThrow();
  const link=join(temporary,'linked');symlinkSync(outside,link,'dir');expect(()=>assertComputerUseBuildOutput(join(link,'AgentsToZ Control.app'),pkg,[temporary])).toThrow();
  chmodSync(temporary,0o777);expect(()=>assertComputerUseBuildOutput(join(temporary,'AgentsToZ Control.app'),pkg,[temporary])).toThrow('private');
 }finally{rmSync(root,{recursive:true,force:true});}
});
