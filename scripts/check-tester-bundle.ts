/** Exercise a compiled sidecar and its adjacent template with an isolated OS-user data directory. */
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,realpathSync,existsSync} from 'node:fs';
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
let child:Bun.Subprocess|undefined;let stderr='';
try{
  child=Bun.spawn([binary],{cwd:home,env:{PATH:process.env.PATH,LANG:'en_US.UTF-8',HOME:home,APP_DATA_DIR:data,
    APPDATA:join(home,'AppData'),XDG_CONFIG_HOME:join(home,'.config'),API_PORT:String(port),
    PORTMGR_BUNDLED_SIDECAR:'1',PORTMGR_PARENT_PID:String(process.pid),PORTMGR_AGENT_RUNTIME_CAPABILITY:secret},stdout:'ignore',stderr:'pipe'});
  const errors=new Response(child.stderr as ReadableStream).text().then(value=>{stderr=value;});
  const base=`http://127.0.0.1:${port}`;let ready=false;
  for(let i=0;i<200;i++){if(child.exitCode!==null)break;try{if((await fetch(base+'/api/health')).ok){ready=true;break;}}catch{}await Bun.sleep(50);}
  if(!ready)throw Error('Compiled fixture did not become ready');
  const post=async(body:unknown,authorized=true)=>{const response=await fetch(base+TESTER_ENDPOINT,{method:'POST',headers:{'Content-Type':'application/json',Origin:'tauri://localhost',...(authorized?{'X-AgentsToZ-Agent-Runtime-Capability':secret}:{})},body:JSON.stringify(body)});return {code:response.status,data:await response.json() as any};};
  const ref={portId:'bundle-project'};
  if((await post({...ref,operation:'status'},false)).code!==403)throw Error('Compiled host accepted an unauthenticated request');
  const status=(await post({...ref,operation:'status'})).data;
  if(!status.success||status.status.installation!=='absent')throw Error('Compiled host could not inspect the fixture');
  const plan=(await post({...ref,operation:'plan'})).data;
  if(!plan.success)throw Error('Compiled host could not plan fixture setup');
  const applied=(await post({...ref,operation:'apply',revision:plan.plan.revision})).data;
  if(!applied.applied)throw Error('Compiled host could not apply its bundled template');
  const configured=(await post({...ref,operation:'status'})).data.status;
  if(configured.installation!=='ready')throw Error('Bundled tester not ready after setup');
  const receipt=(await post({...ref,operation:'start',requestId:testerRequestId(),profileId:'quick',revision:configured.configurationRevision})).data.run;
  if(!receipt)throw Error('Compiled host did not accept the test');
  let final:any;
  for(let i=0;i<150;i++){final=(await post({...ref,operation:'read',runId:receipt.id})).data.run;if(final&&!['queued','starting','running','canceling'].includes(final.state))break;await Bun.sleep(50);}
  if(final?.state!=='passed'||!final.report?.checks[0]?.output?.includes('OK'))throw Error('Compiled fixture did not return verified test output');
  if(JSON.stringify(final).includes(home))throw Error('Compiled result leaked the local fixture path');
  console.log(JSON.stringify({passed:true,compiledSidecar:true,checkoutRequired:false,managementCapabilityVerified:true,
    runnerVersion:configured.installedVersion,runId:final.id,checks:final.report.checks.map((c:any)=>({id:c.id,state:c.state})),
    installedMacUI:false,realAI:false,actualIPhone:false},null,2));
  child.kill();await child.exited;await errors;child=undefined;
}finally{if(child){child.kill();await child.exited;}rmSync(home,{recursive:true,force:true});}
