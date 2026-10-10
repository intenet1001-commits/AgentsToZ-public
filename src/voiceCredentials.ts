import {spawn} from 'node:child_process';
import {mkdirSync,lstatSync,readFileSync,writeFileSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import type {VoiceRequest,VoiceResponse} from './voiceSessionProtocol';
import {createWindowsVoiceSecretStore,voiceSecretStoreName,type VoiceSecretStore} from './voiceSecretStore';

const SERVICE='com.agentstoz.voice.openai.v1',ACCOUNT='realtime';
export type VoiceSecretRunner=(args:string[],input?:string)=>Promise<{code:number|null;text:string}>;
/** No secret in argv, stderr, errors or logs. Match the existing Keychain stdin workflow. */
export const runVoiceSecretCommand:VoiceSecretRunner=(args,input)=>new Promise(resolve=>{
  const child=spawn('/usr/bin/security',args,{detached:true,stdio:['pipe','pipe','pipe']});
  let text='',done=false,overflow=false;
  const timer=setTimeout(()=>child.kill('SIGKILL'),5000);
  child.stdout.on('data',b=>{if(text.length+b.length>4096){overflow=true;child.kill('SIGKILL');}else text+=b.toString();});
  child.stderr.on('data',()=>{});
  child.stdin.on('error',()=>{});
  const finish=(code:number|null)=>{if(done)return;done=true;clearTimeout(timer);resolve({code:overflow?null:code,text:overflow?'':text});};
  child.on('error',()=>finish(null));child.on('close',finish);child.stdin.end(input);
});
export class VoiceCredentials {
  private configuration:{model:string;voice:string;keyConfigured:boolean};
  private serial:Promise<unknown>=Promise.resolve();
  /** Windows keeps the key in the Credential Manager; see voiceSecretStore.ts. */
  private store:VoiceSecretStore|null;
  constructor(private root:string,private env:Record<string,string|undefined>=process.env,private command:VoiceSecretRunner=runVoiceSecretCommand,private platform=process.platform,store?:VoiceSecretStore){
    // Built lazily-but-eagerly here so a runtime without a credential store
    // fails as "unsupported host" instead of mid-save with the key in hand.
    this.store=store??null;
    if(!this.store&&platform==='win32'){try{this.store=createWindowsVoiceSecretStore();}catch{this.store=null;}}
    this.configuration={model:'gpt-realtime-2.1',voice:'marin',keyConfigured:false};
    try{
      const dir=lstatSync(root);if(dir.isSymbolicLink()||!dir.isDirectory())throw Error();
      const path=join(root,'settings.json'),stat=lstatSync(path);
      if(stat.isSymbolicLink()||!stat.isFile()||stat.size>2048)throw Error();
      const x=JSON.parse(readFileSync(path,'utf8'));
      if(x.version!==1||!/^gpt-realtime[a-z0-9.-]{0,80}$/.test(x.model)||!['alloy','ash','ballad','coral','echo','sage','shimmer','verse','marin','cedar'].includes(x.voice)||typeof x.keyConfigured!=='boolean')throw Error();
      this.configuration={model:x.model,voice:x.voice,keyConfigured:x.keyConfigured};
    }catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw new Error('음성 설정 파일을 확인하세요. 기존 설정을 덮어쓰지 않았습니다.');}
  }
  status():VoiceResponse {
    const source=this.env.AGENTSTOZ_VOICE_API_KEY?'environment':this.configuration.keyConfigured?'keychain':'none';
    return {configured:source!=='none',keySource:source,model:this.configuration.model,voice:this.configuration.voice};
  }
  async key():Promise<string>{
    const env=this.env.AGENTSTOZ_VOICE_API_KEY;
    if(env){if(!/^[A-Za-z0-9_-]{20,512}$/.test(env))throw Error('음성 API 키 설정을 확인하세요.');return env;}
    if(this.store){
      if(!this.configuration.keyConfigured)throw Error('이 PC의 음성 설정에서 OpenAI API 키를 연결하세요.');
      const stored=await this.store.get();
      if(!stored)throw Error(`${voiceSecretStoreName(this.platform)}에서 음성 API 키를 읽지 못했습니다. 다시 저장하세요.`);
      return stored;
    }
    if(this.platform!=='darwin'||!this.configuration.keyConfigured)throw Error('Mac의 음성 설정에서 OpenAI API 키를 연결하세요.');
    const result=await this.command(['find-generic-password','-s',SERVICE,'-a',ACCOUNT,'-w']);
    const key=result.text.trim();if(result.code!==0||!/^[A-Za-z0-9_-]{20,512}$/.test(key))throw Error('음성 API 키를 읽지 못했습니다. Mac Keychain을 확인하세요.');
    return key;
  }
  configure(r:VoiceRequest):Promise<VoiceResponse>{
    const pending=this.serial.catch(()=>{}).then(async()=>{
      // The interactive command below is deliberately restricted to one safe token.
      if(r.apiKey!==undefined&&(typeof r.apiKey!=='string'||!/^[A-Za-z0-9_-]{20,512}$/.test(r.apiKey)))throw Error('API 키 형식을 확인하세요.');
      mkdirSync(this.root,{recursive:true,mode:0o700});if(lstatSync(this.root).isSymbolicLink())throw Error('음성 설정 위치를 확인하세요.');
      const next={...this.configuration};
      if((r.apiKey!==undefined||r.removeKey)&&this.store){
        // The store confirms its own write by reading the value back, so the
        // same rule holds as on macOS: only a verified save reports configured.
        if(r.removeKey)await this.store.delete();else await this.store.set(r.apiKey!);
        next.keyConfigured=!r.removeKey;
      }
      else if(r.apiKey!==undefined||r.removeKey){
        if(this.platform!=='darwin')throw Error('이 호스트는 AGENTSTOZ_VOICE_API_KEY 환경 설정을 사용하세요.');
        // security's password prompt silently truncates at 128 characters. Its
        // interactive command parser accepts the full key without putting it in argv.
        const args=r.removeKey?['delete-generic-password','-s',SERVICE,'-a',ACCOUNT]:['-i'];
        const input=r.removeKey?undefined:`add-generic-password -U -s ${SERVICE} -a ${ACCOUNT} -w ${r.apiKey}\n`;
        const result=await this.command(args,input);
        if(result.code!==0&&!(r.removeKey&&result.code===44))throw Error('Keychain 음성 키 설정을 완료하지 못했습니다.');
        if(!r.removeKey){
          // Interactive security can exit successfully even if its command fails.
          // Only an exact readback permits metadata/UI to report a successful save.
          const check=await this.command(['find-generic-password','-s',SERVICE,'-a',ACCOUNT,'-w']);
          if(check.code!==0||check.text.trim()!==r.apiKey)throw Error('Keychain에 저장한 키가 입력값과 일치하는지 확인하지 못했습니다. 다시 저장하세요.');
        }
        next.keyConfigured=!r.removeKey;
      }
      if(r.model)next.model=r.model;if(r.voice)next.voice=r.voice;
      const path=join(this.root,'settings.json'),temporary=join(this.root,'settings-'+crypto.randomUUID()+'.tmp');
      writeFileSync(temporary,JSON.stringify({version:1,...next}),{mode:0o600,flag:'wx'});renameSync(temporary,path);this.configuration=next;
      return this.status();
    });
    this.serial=pending;return pending;
  }
}
