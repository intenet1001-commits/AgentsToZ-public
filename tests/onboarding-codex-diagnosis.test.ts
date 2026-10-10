import {expect,test} from 'bun:test';
import {diagnoseCodexLogin} from '../src/onboardingCodexDiagnosis';
import {preparationEvidence} from '../src/onboardingProgress';
test('cached ChatGPT and API key login are not verified first-task success and never expose output',()=>{
 for(const output of ['Logged in using ChatGPT','Logged in using an API key - private-test-token']){
  const result=diagnoseCodexLogin({ok:true,output,timedOut:false});
  expect(result.authenticationEvidence).toBe('cached');expect(result.authenticated).toBeUndefined();
  expect(JSON.stringify(result)).not.toContain('private-test-token');
  expect(preparationEvidence('codex',{id:'codex',installed:true,...result})).toBe('configured');
 }
});
test('only explicit signed-out status requests login; timeout and unknown failure preserve credentials',()=>{
 expect(diagnoseCodexLogin({ok:false,output:'Not logged in',timedOut:false}).authenticated).toBe(false);
 for(const probe of [{ok:false,output:'Keychain locked',timedOut:false},{ok:true,output:'Logged in using ChatGPT',timedOut:true},
  {ok:true,output:'unexpected',timedOut:false},{ok:true,output:'Not logged in',timedOut:false}]){
  expect(diagnoseCodexLogin(probe).state).toBe('unknown');expect(diagnoseCodexLogin(probe).authenticated).toBeUndefined();
 }
});
