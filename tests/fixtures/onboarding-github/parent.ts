import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {OnboardingGithubStore} from '../../../src/onboardingGithubStore';
import {resolveAgentRuntimeGuardCommand} from '../../../src/agentRuntimeGuardLauncher';
const executable=process.argv[2]!;
const store=new OnboardingGithubStore(process.argv[3]!);let r=store.review('0');r=store.change(r.revision,x=>({...x!,state:'authenticating',ownerPid:process.pid}));
if(process.argv[4]==='cancel-before-claim')store.change(r.revision,x=>({...x!,state:'cancelled',ownerPid:null}));
store.close();
const child=Bun.spawn([...resolveAgentRuntimeGuardCommand()!,'agentstoz-onboarding-github-auth-v1',executable,createHash('sha256').update(readFileSync(executable)).digest('hex'),process.argv[3]!,r.id,r.revision],{
 cwd:'/',env:{HOME:process.argv[3]!,GH_TOKEN:'must-never-reach-login'},stdin:'pipe',stdout:'pipe',stderr:'pipe',detached:true,
});
console.log(`GUARD ${child.pid}`);
for await(const bytes of child.stdout)process.stdout.write(bytes);
await child.exited;
