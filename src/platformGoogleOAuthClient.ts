import {constants,openSync,closeSync,fstatSync,readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {isAbsolute,join} from 'node:path';
import {PlatformCliError} from './platformCliProtocol';
import type {PlatformCliSecrets} from './platformCliStore';

const KEY='google-workspace-desktop-oauth-client-v1';
const MAX_BYTES=16_384;
const invalid=()=>new PlatformCliError('Google Cloud Console에서 데스크톱 앱 유형으로 만든 OAuth 클라이언트 JSON을 선택하세요. 웹 클라이언트·서비스 계정 키·사용자 인증 파일은 사용할 수 없습니다.');
export interface PlatformGoogleClientStatus {ready:boolean;source:'app'|'existing-cli'|'missing';projectId?:string}

/** Accept configuration, never executable paths, account tokens or custom OAuth endpoints. */
export function parseGoogleDesktopClient(value:unknown):string {
  if(typeof value!=='string'||Buffer.byteLength(value)>MAX_BYTES)throw invalid();
  let data:any;try{data=JSON.parse(value);}catch{throw invalid();}
  const c=data?.installed;
  if(!c||typeof c!=='object'||Array.isArray(c)||data.web||data.type||data.refresh_token
    ||typeof c.client_id!=='string'||!c.client_id.trim()||c.client_id.length>512||/[\s\x00-\x1f]/.test(c.client_id)
    ||typeof c.client_secret!=='string'||!c.client_secret.trim()||c.client_secret.length>4096||/[\x00-\x1f]/.test(c.client_secret)
    ||c.auth_uri!=='https://accounts.google.com/o/oauth2/auth'||c.token_uri!=='https://oauth2.googleapis.com/token'
    ||c.project_id!==undefined&&(typeof c.project_id!=='string'||!/^[-a-zA-Z0-9_]{1,128}$/.test(c.project_id)))throw invalid();
  return JSON.stringify({installed:{client_id:c.client_id,client_secret:c.client_secret,auth_uri:c.auth_uri,token_uri:c.token_uri,...(c.project_id?{project_id:c.project_id}:{})}});
}

export class PlatformGoogleOAuthClient {
  constructor(private readonly secrets:PlatformCliSecrets){}
  async save(value:unknown):Promise<PlatformGoogleClientStatus> {
    const client=parseGoogleDesktopClient(value);
    try{await this.secrets.set(KEY,client);if(await this.secrets.get(KEY)!==client)throw Error();}
    catch{throw new PlatformCliError('Google 클라이언트 파일을 OS 자격 증명 저장소에 저장하지 못했습니다. 다시 첨부하세요.');}
    return this.describe(client,'app');
  }
  async read(env:NodeJS.ProcessEnv=process.env):Promise<{client:string;source:'app'|'existing-cli'}|null> {
    let saved:string|null;try{saved=await this.secrets.get(KEY);}catch{throw new PlatformCliError('저장한 Google 클라이언트 파일을 읽지 못했습니다. 다시 첨부하세요.');}
    // A damaged app selection must never silently use a different native OAuth client.
    if(saved!==null)return {client:parseGoogleDesktopClient(saved),source:'app'};
    const directory=env.GOOGLE_WORKSPACE_CLI_CONFIG_DIR??join(homedir(),'.config','gws');
    if(!isAbsolute(directory))return null;
    let fd:number|undefined;
    try{
      fd=openSync(join(directory,'client_secret.json'),constants.O_RDONLY|(process.platform==='win32'?0:constants.O_NOFOLLOW));
      const stat=fstatSync(fd);
      if(!stat.isFile()||stat.size>MAX_BYTES||process.platform!=='win32'&&(stat.uid!==process.getuid?.()||stat.mode&0o022))return null;
      return {client:parseGoogleDesktopClient(readFileSync(fd,'utf8')),source:'existing-cli'};
    }catch{return null;}finally{if(fd!==undefined)closeSync(fd);}
  }
  async status(env?:NodeJS.ProcessEnv):Promise<PlatformGoogleClientStatus> {
    const value=await this.read(env);return value?this.describe(value.client,value.source):{ready:false,source:'missing'};
  }
  private describe(client:string,source:'app'|'existing-cli'):PlatformGoogleClientStatus {
    const projectId=JSON.parse(client).installed.project_id;
    return {ready:true,source,...(projectId?{projectId}:{})};
  }
}
