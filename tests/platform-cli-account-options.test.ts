import {expect,test} from 'bun:test';
import {platformCliAccountOptions} from '../src/platformCliAccountOptions';
import type {PlatformCliAccount} from '../src/platformCliProtocol';

const account=(id:string,source:PlatformCliAccount['source'],identity:string|null,state:PlatformCliAccount['state']='ready'):PlatformCliAccount=>({id,provider:'github',label:id,source,identity,state,revision:''});
const fallback=account('pcli_default','default','owner');
const connected=account('connected','managed','Owner');
const existing=account('native-owner','native','owner');

test('one connected GitHub account gives two options without its existing-login duplicate',()=>{
  const accounts=[fallback,connected,existing];
  expect(platformCliAccountOptions(accounts,'github','pcli_default').map(a=>a.id)).toEqual(['pcli_default','connected']);
  expect(platformCliAccountOptions(accounts,'github','connected').map(a=>a.id)).toEqual(['pcli_default','connected']);
  expect(accounts).toHaveLength(3); // Displaying the picker never deletes a login or credential.
});

test('a saved native binding remains selectable without silently replacing its credential source',()=>{
  expect(platformCliAccountOptions([fallback,connected,existing],'github','native-owner').map(a=>a.id)).toEqual(['pcli_default','native-owner']);
});

test('distinct native logins stay available and an unchecked managed copy cannot hide a working login',()=>{
  const other=account('native-other','native','other');
  expect(platformCliAccountOptions([fallback,connected,existing,other],'github','pcli_default').map(a=>a.id)).toEqual(['pcli_default','connected','native-other']);
  expect(platformCliAccountOptions([fallback,{...connected,state:'login-required'},existing],'github','pcli_default').map(a=>a.id)).toEqual(['pcli_default','native-owner']);
});

test('missing identities and other providers are never deduplicated by label or email guesses',()=>{
  expect(platformCliAccountOptions([fallback,{...connected,identity:null},existing],'github','pcli_default')).toHaveLength(3);
  const google=[connected,existing].map(a=>({...a,provider:'google-workspace' as const}));
  expect(platformCliAccountOptions(google,'google-workspace','connected')).toEqual(google);
});
