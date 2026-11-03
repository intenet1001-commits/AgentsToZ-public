import {afterEach,test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,copyFileSync,rmSync,existsSync,symlinkSync} from 'node:fs';
import {join,resolve} from 'node:path';import {tmpdir} from 'node:os';import {createHash,randomUUID} from 'node:crypto';
const roots:string[]=[];afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
const sha=(b:string)=>createHash('sha256').update(b).digest('hex');
function fixture(){const root=mkdtempSync(join(tmpdir(),'desktop-operative-cli-'));roots.push(root);for(const d of ['scripts','src','.agentstoz'])mkdirSync(join(root,d));for(const p of ['scripts/desktop-operative.ts','src/testerDesktopOperative.ts','buildVersion.ts'])copyFileSync(resolve(import.meta.dir,'..',p),join(root,p));writeFileSync(join(root,'.gitignore'),'.agentstoz/maintainer/\n');writeFileSync(join(root,'.agentstoz/desktop-operative.json'),JSON.stringify({schemaVersion:1,surfaceId:'native-app',bundleId:'com.example.Product',platform:'darwin',maxTargets:64}));
 const env={...process.env,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'};
 const git=(...args:string[])=>{const p=Bun.spawnSync(['git','-c','core.hooksPath=/dev/null',...args],{cwd:root,env,stdout:'pipe',stderr:'pipe'});if(p.exitCode)throw Error('Fixture Git failed');return p.stdout.toString().trim();};git('init','--quiet');git('add','.');git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--quiet','-m','Fixture source');
 const run=(...args:string[])=>{const p=Bun.spawnSync(['bun','--env-file=/dev/null','scripts/desktop-operative.ts',...args],{cwd:root,env,stdout:'pipe',stderr:'pipe'});return {code:p.exitCode,out:p.stdout.toString(),err:p.stderr.toString()};};return {root,run,git};}
test('file-only runner blocks actual-native report, preserves an unknown original, and recovers a lost projection',()=>{
 const {root,run,git}=fixture();expect(run('contract').code).toBe(0);expect(run('report').code).toBe(3);expect(existsSync(join(root,'.agentstoz/maintainer'))).toBe(false);
 const prepared=run('prepare','--device','Mac 3','--mode','operational','--scope-reference','Explicit navigation only');expect(prepared.code).toBe(0);const {plan:path}=JSON.parse(prepared.out);const plan=JSON.parse(readFileSync(join(root,path),'utf8'));
 expect(plan.projectCommit).toBe(git('rev-parse','HEAD'));expect(plan.scope.appCommit).toBe(plan.projectCommit);
 const directory=join(root,'.agentstoz/maintainer/desktop-operative/evidence');mkdirSync(directory);const ref=(name:string,text:string)=>{writeFileSync(join(directory,name),text);return {path:'.agentstoz/maintainer/desktop-operative/evidence/'+name,sha256:sha(text)};};
 const before=ref('before.json','synthetic host before fixture observation'),after=ref('after.json','synthetic host after fixture observation');
 const receipt={schemaVersion:1,runId:plan.runId,scope:plan.scope,origin:'manual-cua-observation',observedAt:Date.now(),application:{bundleId:plan.scope.bundleId,appCommit:plan.scope.appCommit,infoSha256:'a'.repeat(64),cdHash:'b'.repeat(40)},inventory:[{id:'tools',role:'button',label:'Tools',evidence:before}],actions:[{operationId:randomUUID(),targetId:'tools',outcome:'unknown',before,after,effect:{kind:'no-change',evidence:after}}]};
 const input='.agentstoz/maintainer/desktop-operative/input.json';writeFileSync(join(root,input),JSON.stringify(receipt));const record=run('record-manual','--plan',path,'--receipt',input);expect(record.code).toBe(0);expect(JSON.parse(record.out)).toMatchObject({state:'unknown',verdict:null,automaticPass:false});expect(run('report').code).toBe(3);
 expect(run('prepare','--device','Mac 1','--mode','operational','--scope-reference','Do not replay')).toMatchObject({code:3,err:'DESKTOP_OPERATIVE_ORIGINAL_UNKNOWN\n'});
 // A write failure after the immutable original was stored cannot reopen a fresh run through a stale status file.
 const projection=join(root,'.agentstoz/maintainer/desktop-operative/status.json'),status=JSON.parse(readFileSync(projection,'utf8'));writeFileSync(projection,JSON.stringify({...status,state:'blocked',reason:'adapter-absent',inventory:0,clicked:0,effects:0}));
 expect(JSON.parse(run('status').out).state).toBe('unknown');expect(run('prepare','--device','Mac 1','--mode','operational','--scope-reference','Still do not replay').code).toBe(3);
 // The same original receipt is an idempotent read/projection repair; another claimed effect cannot replace it.
 expect(run('record-manual','--plan',path,'--receipt',input).code).toBe(0);writeFileSync(join(root,input),JSON.stringify({...receipt,actions:[{...receipt.actions[0],outcome:'observed',effect:{kind:'ui-change',evidence:after}}]}));expect(run('record-manual','--plan',path,'--receipt',input).code).toBe(3);
 expect(git('status','--porcelain')).toBe('');expect(existsSync(join(root,'.agentstoz/click-sweep/desktop/native/darwin/native-app.json'))).toBe(false);
});
test('manual record verifies evidence bytes and refuses symlinked paths without touching an app',()=>{
 const {root,run}=fixture();const ready=run('prepare','--device','Mac 3','--mode','isolated','--scope-reference','Own fixture app-data only');expect(ready.code).toBe(0);const path=JSON.parse(ready.out).plan,plan=JSON.parse(readFileSync(join(root,path),'utf8'));
 const file='.agentstoz/maintainer/desktop-operative/actual.json';writeFileSync(join(root,file),'before');const ref={path:file,sha256:sha('wrong bytes')};const input='.agentstoz/maintainer/desktop-operative/input.json';
 const receipt={schemaVersion:1,runId:plan.runId,scope:plan.scope,origin:'manual-cua-observation',observedAt:Date.now(),application:{bundleId:plan.scope.bundleId,appCommit:plan.scope.appCommit,infoSha256:'a'.repeat(64),cdHash:'b'.repeat(40)},inventory:[{id:'tools',role:'button',label:'Tools',evidence:ref}],actions:[{operationId:randomUUID(),targetId:'tools',outcome:'unknown',before:ref,after:ref,effect:{kind:'no-change',evidence:ref}}]};
 writeFileSync(join(root,input),JSON.stringify(receipt));expect(run('record-manual','--plan',path,'--receipt',input).code).toBe(3);
 const link='.agentstoz/maintainer/desktop-operative/link.json';symlinkSync(join(root,file),join(root,link));receipt.inventory[0]!.evidence={path:link,sha256:sha('before')};writeFileSync(join(root,input),JSON.stringify(receipt));expect(run('record-manual','--plan',path,'--receipt',input).code).toBe(3);
 expect(JSON.parse(run('status').out)).toMatchObject({state:'blocked',verdict:null,inventory:0});
});
