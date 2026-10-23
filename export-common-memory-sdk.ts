import {existsSync,mkdirSync,readFileSync,writeFileSync,renameSync,lstatSync} from 'node:fs';
import {resolve,join,isAbsolute,dirname,relative} from 'node:path';
import {createHash} from 'node:crypto';
const root=import.meta.dir,argument=process.argv[2],updating=process.argv.includes('--update');
if(!argument||!isAbsolute(argument))throw new Error('Usage: bun export-common-memory-sdk.ts /absolute/destination [--update]');
const destination=resolve(argument);if(destination===root||!relative(root,destination).startsWith('..'))throw new Error('Export outside the app source tree.');
const packageContent=readFileSync(join(root,'packages/common-memory-sdk/package.json'),'utf8'),sdkVersion=JSON.parse(packageContent).version;
if(typeof sdkVersion!=='string'||!/^\d+\.\d+\.\d+$/.test(sdkVersion))throw new Error('SDK package version is invalid.');
const contents=new Map<string,string>([
 ['src/commonMemory.ts',readFileSync(join(root,'src/commonMemory.ts'),'utf8')],
 ['src/commonMemoryCrypto.ts',readFileSync(join(root,'src/commonMemoryCrypto.ts'),'utf8')],
 ['src/commonMemoryProjects.ts',readFileSync(join(root,'src/commonMemoryProjects.ts'),'utf8')],
 ['src/gitCloneRequest.ts',readFileSync(join(root,'src/gitCloneRequest.ts'),'utf8')],
 ['src/githubUrls.ts',readFileSync(join(root,'src/githubUrls.ts'),'utf8')],
 ['src/commonMemoryClient.ts',readFileSync(join(root,'src/commonMemoryClient.ts'),'utf8')],
 ['src/commonMemoryPortableTypes.ts',readFileSync(join(root,'src/commonMemoryPortableTypes.ts'),'utf8')],
 ['src/metaCommonMemoryContract.ts',readFileSync(join(root,'src/metaCommonMemoryContract.ts'),'utf8')],
 ['src/index.ts',`export const COMMON_MEMORY_SDK_VERSION=${JSON.stringify(sdkVersion)};\nexport * from './commonMemory';\nexport * from './commonMemoryClient';\nexport * from './commonMemoryProjects';\n`],
 ['package.json',packageContent],
 ['bun.lock',readFileSync(join(root,'packages/common-memory-sdk/bun.lock'),'utf8')],
 ['README.md',readFileSync(join(root,'packages/common-memory-sdk/README.md'),'utf8')],
 ['tests/portable.test.ts',`import {expect,test} from 'bun:test';\nimport {createCommonMemoryClient,createCommonMemory} from '../src/index';\ntest('portable SDK uses injected transport and goal-specific identity',async()=>{const calls:any[]=[];const client=createCommonMemoryClient(async(op,input)=>{calls.push([op,input]);return {ok:true};});await client.recommend('iPhone app');expect(calls).toEqual([['recommend',{projectGoal:'iPhone app'}]]);const group=createCommonMemory({name:'app',goal:{objective:'iPhone app'},sourceMemoryIds:['11111111-1111-4111-8111-111111111111']});expect(group.goalVersion).toBe(1);expect(group.publication).toBeNull();});\n`],
]);
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
const manifestPath=join(destination,'source-manifest.json');let previous:any=null;
const checkParents=(path:string)=>{let current=dirname(path);while(current!==dirname(current)){if(existsSync(current)&&lstatSync(current).isSymbolicLink())throw new Error('SDK export cannot traverse symbolic links.');current=dirname(current);}};
checkParents(join(destination,'src/commonMemory.ts'));
for(const [file] of contents)checkParents(join(destination,file));
if(existsSync(destination)){
 if(lstatSync(destination).isSymbolicLink()||!updating||!existsSync(manifestPath)||lstatSync(manifestPath).isSymbolicLink())throw new Error('Existing destination requires a valid --update export manifest.');
 previous=JSON.parse(readFileSync(manifestPath,'utf8'));
 if(previous.schemaVersion!==1||previous.producer!=='AgentsToZ_byCS/common-memory-sdk')throw new Error('Different export authority.');
 for(const [file] of contents){const path=join(destination,file);if(existsSync(path)&&(lstatSync(path).isSymbolicLink()||hash(readFileSync(path,'utf8'))!==previous.files[file]))throw new Error(`Locally edited SDK file preserved: ${file}`);if(!existsSync(path)&&previous.files[file])throw new Error(`Locally removed SDK file preserved: ${file}`);}
}
for(const [file,text] of contents){const path=join(destination,file);mkdirSync(dirname(path),{recursive:true});const tmp=`${path}.${crypto.randomUUID()}.tmp`;writeFileSync(tmp,text);renameSync(tmp,path);}
const commit=Bun.spawnSync(['git','rev-parse','HEAD'],{cwd:root}).stdout.toString().trim();
const sourceStatus=Bun.spawnSync(['git','status','--porcelain'],{cwd:root});
const publication=sourceStatus.success&&/^[a-f0-9]{40}$/.test(commit)&&!sourceStatus.stdout.toString().trim()?'committed-source':'unpublished-working-tree';
writeFileSync(manifestPath,JSON.stringify({schemaVersion:1,producer:'AgentsToZ_byCS/common-memory-sdk',sdkVersion,sourceCommit:commit,publication,files:Object.fromEntries([...contents].map(([file,text])=>[file,hash(text)]))},null,2)+'\n');
console.log(JSON.stringify({exported:true,destination,files:contents.size,publication}));
