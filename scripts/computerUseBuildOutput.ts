import {existsSync,lstatSync,realpathSync,statSync} from 'node:fs';
import {basename,dirname,isAbsolute,join,resolve,sep} from 'node:path';
import {tmpdir} from 'node:os';
/** Build artifacts only: never replace an existing app, install to an arbitrary directory or follow an output link. */
export function assertComputerUseBuildOutput(output:string,packageRoot:string,temporaryRoots=[tmpdir(),'/tmp']){
  if(!isAbsolute(output)||resolve(output)!==output||basename(output)!=='AgentsToZ Control.app'||existsSync(output))throw Error('Choose a new absolute build output; existing apps are never replaced.');
  const parent=dirname(output),actual=realpathSync(parent),root=join(realpathSync(packageRoot),'.build');
  const allowed=[root,...temporaryRoots.map(p=>realpathSync(p))];
  if(!allowed.some(base=>actual===base||actual.startsWith(base+sep)))throw Error('Control output must stay in the package build directory or an owned temporary directory.');
  if(lstatSync(parent).isSymbolicLink())throw Error('Control build output links are refused.');
  const metadata=statSync(parent);
  if((process.getuid&&metadata.uid!==process.getuid())||(metadata.mode&0o022)!==0)throw Error('Control build output parent must be owned and private.');
}
