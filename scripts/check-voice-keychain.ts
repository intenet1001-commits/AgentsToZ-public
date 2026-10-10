/** Manual macOS check: generated test keys in a unique, temporary Keychain service.
 * No provider calls, production credentials, or secret values in output.
 * Run: bun scripts/check-voice-keychain.ts
 */
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {VoiceCredentials,runVoiceSecretCommand,type VoiceSecretRunner} from '../src/voiceCredentials';

if(process.platform!=='darwin')throw Error('This check requires macOS Keychain.');
const service='com.agentstoz.voice.regression.'+crypto.randomUUID();
const root=mkdtempSync(join(tmpdir(),'voice-keychain-regression-'));
const command:VoiceSecretRunner=(args,input)=>runVoiceSecretCommand(
  args.map(a=>a==='com.agentstoz.voice.openai.v1'?service:a),
  input?.replaceAll('com.agentstoz.voice.openai.v1',service),
);
let checked=0;
try{
  for(const length of [32,127,128,129,164,256,512]){
    const key='sk-proj-'+crypto.randomUUID().replaceAll('-','').repeat(16).slice(0,length-8);
    const credentials=new VoiceCredentials(root,{},command);
    const saved=await credentials.configure({action:'configure',requestId:crypto.randomUUID(),apiKey:key});
    const reopened=new VoiceCredentials(root,{},command);
    if(!saved.configured||await reopened.key()!==key)throw Error('KEYCHAIN_EXACT_ROUNDTRIP_FAILED');
    if(readFileSync(join(root,'settings.json'),'utf8').includes(key))throw Error('SECRET_IN_METADATA');
    checked++;
  }
  const removed=await new VoiceCredentials(root,{},command).configure({action:'configure',requestId:crypto.randomUUID(),removeKey:true});
  const absent=await command(['find-generic-password','-s',service,'-a','realtime','-w']);
  if(removed.configured||absent.code!==44)throw Error('KEYCHAIN_TEST_ITEM_REMOVAL_FAILED');
  console.log(JSON.stringify({passed:true,exactRoundTrips:checked,lengths:[32,127,128,129,164,256,512],replacementAndReload:true,testItemRemoved:true,providerCalls:0}));
}finally{
  await command(['delete-generic-password','-s',service,'-a','realtime']);
  rmSync(root,{recursive:true,force:true});
}
