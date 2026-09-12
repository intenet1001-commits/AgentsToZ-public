import {expect,test} from 'bun:test';
import {diagnoseGithubAuth} from '../src/onboardingGithubAuthDiagnosis';
const entry={host:'github.com',active:true,state:'success',tokenSource:'keyring'};
function probe(value:unknown,ok=true,timedOut=false){return diagnoseGithubAuth({ok,timedOut,stdout:JSON.stringify(value)});}
const status=(overrides={})=>({hosts:{'github.com':[{...entry,...overrides}]}});
test('only explicit authenticated active Keychain entry is ready',()=>{
 expect(probe(status())).toBe('ready');
 expect(probe({hosts:{}})).toBe('installed');
 for(const tokenSource of ['oauth_token','/private/test/hosts.yml'])expect(probe(status({tokenSource}))).toBe('storage-review');
});
test('zero-exit JSON auth failure, locked storage and timeout never mean logged out or ready',()=>{
 for(const override of [{state:'error',error:'keychain unavailable'},{state:'timeout'},
  {state:'error',error:'invalid token'},{active:false},{host:'other.example'},
  {tokenSource:'GH_TOKEN'},{tokenSource:'default'},{token:'secret-must-not-be-requested'}]){
  expect(probe(status(override))).toBe('unknown');
 }
 expect(probe(status(),false)).toBe('unknown');expect(probe(status(),true,true)).toBe('unknown');
});
test('malformed or ambiguous status cannot authorize a new login',()=>{
 for(const value of [null,{}, {hosts:null},{hosts:[]},{hosts:{'github.com':[]}},
  {hosts:{'github.com':[entry,entry]}},{hosts:{'elsewhere':[entry]}}])expect(probe(value)).toBe('unknown');
 expect(diagnoseGithubAuth({ok:true,timedOut:false,stdout:'not JSON'})).toBe('unknown');
 expect(diagnoseGithubAuth({ok:true,timedOut:false,stdout:' '.repeat(65537)})).toBe('unknown');
});
