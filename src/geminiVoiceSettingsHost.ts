import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import {constants,openSync,closeSync,writeFileSync,fsyncSync,renameSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {createProductionPromptGuideKeyProvider,promptGuideDirectory,readPromptGuideFile,type PromptGuideKeyProvider} from './promptGuideKeyProvider';
import {DEFAULT_GEMINI_LIVE_MODEL,parseGeminiVoiceSettingsRequest,validGeminiModel,type GeminiVoiceSettingsStatus} from './geminiVoiceSettings';
const AAD=Buffer.from('agentstoz-gemini-voice-settings-v1');
interface Stored {version:1;model:string;iv:string;tag:string;ciphertext:string;checkedAt:string|null;checkedModel:string|null}
export async function probeGeminiLive(apiKey:string,model:string,connect:(url:string)=>WebSocket=url=>new WebSocket(url),timeoutMs=15000):Promise<void>{
 return new Promise((resolve,reject)=>{
  let socket:WebSocket|undefined;let done=false;
  const finish=(error?:string)=>{if(done)return;done=true;clearTimeout(timer);if(socket){socket.onopen=null;socket.onmessage=null;socket.onerror=null;socket.onclose=null;try{socket.close()}catch{}}error?reject(Error(error)):resolve();};
  const timer=setTimeout(()=>finish('Live 연결 검사 시간이 초과됐습니다. 네트워크와 모델 이용 권한을 확인하세요.'),timeoutMs);
  try{
   // The long-lived key exists only in this host connection, never in UI responses/logs.
   socket=connect('wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key='+encodeURIComponent(apiKey));
   socket.binaryType='arraybuffer';
   socket.onopen=()=>{try{socket!.send(JSON.stringify({setup:{model:'models/'+model,generationConfig:{responseModalities:['AUDIO']}}}));}catch{finish('Live 연결 설정을 보내지 못했습니다.');}};
   socket.onmessage=async event=>{try{
    if(done)return;const raw=event.data;let text:string;
    if(typeof raw==='string'&&raw.length<=65536)text=raw;
    else if(raw instanceof ArrayBuffer&&raw.byteLength<=65536)text=new TextDecoder().decode(raw);
    else if(raw instanceof Blob&&raw.size<=65536)text=await raw.text();
    else {finish('Live 응답 형식을 확인하지 못했습니다.');return;}
    if(done)return;const value=JSON.parse(text);if(value.error)finish('키·모델 이용 권한 또는 API 할당량을 확인하세요.');else if(value.setupComplete)finish();
   }catch{finish('Live 응답을 확인하지 못했습니다.');}};
   socket.onerror=()=>finish('Live 연결에 실패했습니다. 키·네트워크·모델 이용 권한을 확인하세요.');
   socket.onclose=()=>finish('Live 세션 준비 전에 연결이 종료됐습니다. 키·모델·API 할당량을 확인하세요.');
  }catch{finish('Live 연결을 시작하지 못했습니다.');}
 });
}
export function createGeminiVoiceSettingsHost(input:{appDataDir:string;supported:boolean;keyProvider?:PromptGuideKeyProvider;probe?:(key:string,model:string)=>Promise<void>}){
 const keyProvider=input.keyProvider??createProductionPromptGuideKeyProvider({appDataDir:input.appDataDir,namespace:{keychainService:'com.portmanager.portmanager.gemini-voice.v1',keychainAccount:'voice-settings-v1',dpapiFile:'gemini-voice.v1.key.dpapi',dpapiEntropy:'agentstoz-gemini-voice-v1'}});
 const path=join(input.appDataDir,'gemini-voice-settings.v1.json');let busy=false;
 function read():Stored|null{
  const bytes=readPromptGuideFile(path,4096);if(!bytes)return null;
  try{const value=JSON.parse(bytes.toString());if(value.version!==1||!validGeminiModel(value.model)||!['iv','tag','ciphertext'].every(k=>typeof value[k]==='string'&&/^[A-Za-z0-9+/]+={0,2}$/.test(value[k]))||Buffer.from(value.iv,'base64').length!==12||Buffer.from(value.tag,'base64').length!==16)throw Error();return value;}catch{throw Error('저장된 음성 설정을 읽지 못했습니다. 기존 파일은 유지했습니다.');}finally{bytes.fill(0);}
 }
 function write(value:Stored){
  promptGuideDirectory(input.appDataDir,true);const temp=path+'.'+randomBytes(8).toString('hex')+'.tmp';let fd:number|undefined;
  try{fd=openSync(temp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);writeFileSync(fd,JSON.stringify(value));fsyncSync(fd);closeSync(fd);fd=undefined;renameSync(temp,path);}finally{if(fd!==undefined)closeSync(fd);try{unlinkSync(temp)}catch{}}
 }
 function status(value:Stored|null):GeminiVoiceSettingsStatus{return {supported:input.supported,configured:!!value,model:value?.model??DEFAULT_GEMINI_LIVE_MODEL,checkedAt:typeof value?.checkedAt==='string'?value.checkedAt:null,checkedModel:typeof value?.checkedModel==='string'?value.checkedModel:null};}
 async function runtimeKey():Promise<string>{
  const old=read();if(!input.supported||!old)throw Error('먼저 Gemini API 키를 저장하세요.');
  let key:Buffer|null=null,plaintext:Buffer|undefined;
  try{key=await keyProvider.read();if(!key)throw Error('저장된 키가 없거나 Keychain 복원이 필요합니다.');const cipher=createDecipheriv('aes-256-gcm',key,Buffer.from(old.iv,'base64'));cipher.setAAD(AAD);cipher.setAuthTag(Buffer.from(old.tag,'base64'));plaintext=Buffer.concat([cipher.update(Buffer.from(old.ciphertext,'base64')),cipher.final()]);return plaintext.toString();}
  finally{key?.fill(0);plaintext?.fill(0);}
 }
 return {status:()=>status(read()),runtimeKey,async updateModel(model:string){
  if(!validGeminiModel(model))throw Error('Gemini 모델 ID를 확인하세요.');
  if(busy)throw Error('음성 설정 작업이 진행 중입니다. 완료 후 다시 시도하세요.');busy=true;
  try{const old=read();if(!input.supported||!old)throw Error('먼저 Gemini API 키를 저장하세요.');const value={...old,model,checkedAt:null,checkedModel:null};write(value);return status(value);}finally{busy=false;}
 },async perform(raw:unknown):Promise<GeminiVoiceSettingsStatus>{
  const request=parseGeminiVoiceSettingsRequest(raw);
  if(!input.supported){if(request.operation==='status')return status(null);throw Error('키 설정은 설치된 Mac 앱에서 사용할 수 있습니다.');}
  if(request.operation==='status')return status(read()); // No Keychain access or network on render.
  if(busy)throw Error('음성 설정 작업이 진행 중입니다. 완료 후 다시 시도하세요.');busy=true;
  let key:Buffer|null=null;let plaintext:Buffer|undefined;
  try{
   const old=read();
   if(request.operation==='delete'){if(old)unlinkSync(path);return status(null);}
   key=old?await keyProvider.read():request.operation==='save'?await keyProvider.create():null;
   if(!key)throw Error('저장된 키가 없거나 Keychain 복원이 필요합니다.');
   if(request.operation==='save'){
    const iv=randomBytes(12);const cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(AAD);plaintext=Buffer.from(request.apiKey);
    const value:Stored={version:1,model:request.model,iv:iv.toString('base64'),tag:'',ciphertext:Buffer.concat([cipher.update(plaintext),cipher.final()]).toString('base64'),checkedAt:null,checkedModel:null};value.tag=cipher.getAuthTag().toString('base64');write(value);return status(value);
   }
   if(!old)throw Error('먼저 Gemini API 키를 저장하세요.');
   const cipher=createDecipheriv('aes-256-gcm',key,Buffer.from(old.iv,'base64'));cipher.setAAD(AAD);cipher.setAuthTag(Buffer.from(old.tag,'base64'));plaintext=Buffer.concat([cipher.update(Buffer.from(old.ciphertext,'base64')),cipher.final()]);
   await (input.probe??probeGeminiLive)(plaintext.toString(),request.model);
   const value={...old,model:request.model,checkedAt:new Date().toISOString(),checkedModel:request.model};write(value);return status(value);
  }catch(error){
   // Never forward credential command/provider errors. Probe messages are fixed application copy.
   if(error instanceof Error&&/^(Live |키·|먼저 Gemini|저장된 키가)/.test(error.message))throw error;
   throw Error('음성 설정 작업을 완료하지 못했습니다. Keychain 접근 상태를 확인하세요.');
  }finally{key?.fill(0);plaintext?.fill(0);busy=false;}
 }};
}
