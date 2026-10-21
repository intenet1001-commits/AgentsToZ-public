/** Exercise a compiled sidecar and its adjacent template with an isolated OS-user data directory. */
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,realpathSync,existsSync,readFileSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {randomBytes} from 'node:crypto';
import {TESTER_ENDPOINT,testerRequestId} from '../src/testerAgentContract';

const binary=resolve(process.argv[2]??'src-tauri/resources/agentstoz-api-sidecar');
if(!existsSync(binary)||!existsSync(join(dirname(binary),'templates/tester-agent/agentstoz-maintainer.py')))throw Error('Compiled sidecar and adjacent tester template are required');
const home=realpathSync(mkdtempSync(join(tmpdir(),'agentstoz-tester-bundle-')));
const data=join(home,'data'),project=join(home,'project');
mkdirSync(data);mkdirSync(join(project,'tests'),{recursive:true});
writeFileSync(join(project,'tests/test_core.py'),'import unittest\nclass Core(unittest.TestCase):\n def test_sum(self): self.assertEqual(2+3,5)\n');
writeFileSync(join(data,'ports.json'),JSON.stringify([{id:'bundle-project',name:'Bundle fixture',folderPath:project}]));
writeFileSync(join(data,'workspace-roots.json'),'[]');
const reservation=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response('fixture')});
const port=reservation.port!;reservation.stop(true);if(port===3001)throw Error('Fixture cannot use the live API port');
const secret=randomBytes(32).toString('hex');
const git=Bun.which('git');if(!git)throw Error('Git required for fixture guard proof');
const bin=join(home,'bin'),gitLog=join(home,'git-calls.log');mkdirSync(bin);
writeFileSync(join(bin,'git'),`#!/usr/bin/env bun
import {appendFileSync} from 'node:fs';
appendFileSync(${JSON.stringify(gitLog)},'git\\n');
const child=Bun.spawnSync([${JSON.stringify(git)},...process.argv.slice(2)],{stdin:'inherit',stdout:'inherit',stderr:'inherit'});
process.exit(child.exitCode);
`,{mode:0o700});
const gitCalls=()=>existsSync(gitLog)?readFileSync(gitLog,'utf8').length:0;
let child:Bun.Subprocess|undefined;let stderr='';
try{
  child=Bun.spawn([binary],{cwd:home,env:{PATH:bin+':'+process.env.PATH,LANG:'en_US.UTF-8',HOME:home,APP_DATA_DIR:data,
    APPDATA:join(home,'AppData'),XDG_CONFIG_HOME:join(home,'.config'),API_PORT:String(port),
    PORTMGR_BUNDLED_SIDECAR:'1',PORTMGR_PARENT_PID:String(process.pid),PORTMGR_AGENT_RUNTIME_CAPABILITY:secret},stdout:'ignore',stderr:'pipe'});
  const errors=new Response(child.stderr as ReadableStream).text().then(value=>{stderr=value;});
  const base=`http://127.0.0.1:${port}`;let ready=false;
  for(let i=0;i<200;i++){if(child.exitCode!==null)break;try{if((await fetch(base+'/api/health')).ok){ready=true;break;}}catch{}await Bun.sleep(50);}
  if(!ready)throw Error('Compiled fixture did not become ready');
  const post=async(body:unknown,authorized=true)=>{const response=await fetch(base+TESTER_ENDPOINT,{method:'POST',headers:{'Content-Type':'application/json',Origin:'tauri://localhost',...(authorized?{'X-AgentsToZ-Agent-Runtime-Capability':secret}:{})},body:JSON.stringify(body)});return {code:response.status,data:await response.json() as any};};
  const ref={portId:'bundle-project'};
  const beforeMetadataGit=gitCalls();
  const unconfiguredSets=(await post({...ref,operation:'sets'})).data.sets;
  if(unconfiguredSets?.general?.state!=='none'||unconfiguredSets.personas.state!=='none')throw Error('Compiled configuration read could not distinguish unconfigured sets');
  if(gitCalls()!==beforeMetadataGit)throw Error('Main-project metadata read invoked Git');
  if((await post({...ref,operation:'status'},false)).code!==403)throw Error('Compiled host accepted an unauthenticated request');
  const status=(await post({...ref,operation:'status'})).data;
  if(!status.success||status.status.installation!=='absent')throw Error('Compiled host could not inspect the fixture');
  const plan=(await post({...ref,operation:'plan'})).data;
  if(!plan.success)throw Error('Compiled host could not plan fixture setup');
  const applied=(await post({...ref,operation:'apply',revision:plan.plan.revision})).data;
  if(!applied.applied)throw Error('Compiled host could not apply its bundled template');
  const configured=(await post({...ref,operation:'status'})).data.status;
  if(configured.installation!=='ready')throw Error('Bundled tester not ready after setup');
  // The runner carries the shared scenario pack; setup must install it and it must lint clean.
  for(const name of ['conflict-markers','json-valid','python-syntax'])if(!existsSync(join(project,'.agentstoz/scenarios/common',name+'.json')))throw Error('Bundled tester did not install the common scenario pack');
  const lint=Bun.spawnSync([process.env.PYTHON??'python3','-B',join(project,'scripts/agentstoz-maintainer.py'),'scenarios','lint','--root',project,'--json'],{env:{PATH:process.env.PATH,HOME:home,PYTHONDONTWRITEBYTECODE:'1'}});
  if(lint.exitCode!==0||JSON.parse(lint.stdout.toString()).errors.length)throw Error('Bundled common scenarios did not lint clean');
  const receipt=(await post({...ref,operation:'start',requestId:testerRequestId(),profileId:'quick',revision:configured.configurationRevision})).data.run;
  if(!receipt)throw Error('Compiled host did not accept the test');
  let final:any;
  for(let i=0;i<150;i++){final=(await post({...ref,operation:'read',runId:receipt.id})).data.run;if(final&&!['queued','starting','running','canceling'].includes(final.state))break;await Bun.sleep(50);}
  if(final?.state!=='passed'||!final.report?.checks[0]?.output?.includes('OK'))throw Error('Compiled fixture did not return verified test output');
  if(JSON.stringify(final).includes(home))throw Error('Compiled result leaked the local fixture path');
  const context=(await post({...ref,operation:'persona-review'})).data.personaEvolution;
  if(context?.commonPersonas?.templates?.length!==3||context.commonPersonas.state!=='ready')throw Error('Bundled common personas were not installed');
  const created=(await post({...ref,operation:'persona-create',templateId:'first-time-user',revision:context.context.revision,
    goal:'prepare the first project',situation:'a newly installed device',journey:['find the project','check its readiness'],
    successCriteria:['the project readiness is visible'],checkIds:[context.context.checks[0].id]})).data.personaAccepted;
  if(!created?.accepted||created.verdict!==null)throw Error('Compiled host did not create a reviewed project persona');
  const initialSets=(await post({...ref,operation:'sets'})).data.sets;
  if(initialSets?.personas?.count!==1||initialSets.general.commonCount!==3||initialSets.personas.templates.length!==3||initialSets.instructionVersion!==2)throw Error('Compiled host did not expose both project test sets');
  writeFileSync(join(project,'README.md'),'This project has staff and first-time-user journeys.');
  const domainContext=(await post({...ref,operation:'persona-review'})).data.personaEvolution;
  const proposed=(await post({...ref,operation:'persona-propose',revision:domainContext.context.revision,role:'staff reviewer',reason:'the README declares a staff journey',goal:'review the project',situation:'a staff member begins reviewing',journey:['open the project','review its state'],successCriteria:['the state is explained'],sourcePaths:['README.md'],checkIds:[]})).data.personaEvolution;
  if(!proposed?.candidates?.some((c:any)=>c.profile?.role==='staff reviewer'&&!c.checkIds.length))throw Error('Compiled host did not preserve a contextual evidence-gap draft');
  const domainSets=(await post({...ref,operation:'sets'})).data.sets;
  if(domainSets.personas.count!==1||domainSets.personas.needsChecks<1)throw Error('A contextual draft was mistaken for an active persona');
  const personalized=(await post({...ref,operation:'status'})).data.status;
  if(personalized.personas?.count!==1||personalized.personas.latest!==null)throw Error('Persona registration was mistaken for a test run');
  const personaRun=(await post({...ref,operation:'start',requestId:testerRequestId(),profileId:'personas',revision:personalized.configurationRevision})).data.run;
  if(!personaRun)throw Error('Compiled host did not start the project persona');
  let personaFinal:any;
  for(let i=0;i<150;i++){personaFinal=(await post({...ref,operation:'read',runId:personaRun.id})).data.run;if(personaFinal&&!['queued','starting','running','canceling'].includes(personaFinal.state))break;await Bun.sleep(50);}
  if(personaFinal?.state!=='passed')throw Error('Compiled project persona did not pass its actual check');
  const verifiedPersona=(await post({...ref,operation:'status'})).data.status.personas;
  if(verifiedPersona.latest?.verdicts?.[0]?.freshness!=='current')throw Error('Compiled project persona lacks current definition evidence');
  console.log(JSON.stringify({passed:true,compiledSidecar:true,checkoutRequired:false,mainMetadataNoGitVerified:true,managementCapabilityVerified:true,
    runnerVersion:configured.installedVersion,commonScenarios:3,commonPersonas:3,personaRunId:personaFinal.id,runId:final.id,checks:final.report.checks.map((c:any)=>({id:c.id,state:c.state})),
    installedMacUI:false,realAI:false,actualIPhone:false},null,2));
  child.kill();await child.exited;await errors;child=undefined;
}finally{if(child){child.kill();await child.exited;}rmSync(home,{recursive:true,force:true});}
