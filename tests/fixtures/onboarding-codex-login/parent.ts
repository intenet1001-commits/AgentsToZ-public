import {randomUUID} from 'node:crypto';
import {CodexLoginStore} from '../../../src/onboardingCodexLoginStore';
import {CODEX_LOGIN_RECIPE} from '../../../src/onboardingCodexLogin';
import {codexLoginDigest} from '../../../src/onboardingCodexLoginRuntime';
import {resolveAgentRuntimeGuardCommand} from '../../../src/agentRuntimeGuardLauncher';
const [executable,root,mode]=process.argv.slice(2) as [string,string,string];
const store=new CodexLoginStore(root);
const r=store.change('0',()=>({schema:1,recipe:CODEX_LOGIN_RECIPE,id:randomUUID(),revision:randomUUID(),state:'authenticating',ownerPid:process.pid,guardPid:null,checkedAt:new Date().toISOString(),updatedAt:new Date().toISOString()}));
if(mode==='cancel-before-claim')store.change(r.revision,x=>({...x!,state:'cancelled',ownerPid:null}));
store.close();
const child=Bun.spawn([...resolveAgentRuntimeGuardCommand()!,'agentstoz-onboarding-codex-auth-v1',executable,await codexLoginDigest(executable),root,r.id,r.revision],{
 cwd:'/',env:{HOME:root,OPENAI_API_KEY:'must-never-reach-login'},stdin:'pipe',stdout:'pipe',stderr:'ignore',detached:true,
});
console.log(`GUARD ${child.pid}`);
for await(const bytes of child.stdout){
 const text=new TextDecoder().decode(bytes);
 // Live preflight never exports its ephemeral URL, even to the test runner.
 if(mode==='live-cancel'){
  if(text.includes('URL ')){console.log('BROWSER_READY');child.stdin.end();}
 }else process.stdout.write(bytes);
}
await child.exited;
