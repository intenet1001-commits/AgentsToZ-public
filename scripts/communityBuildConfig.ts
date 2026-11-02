import {ECDH} from 'node:crypto';
import {closeSync,constants,fstatSync,openSync,readSync} from 'node:fs';
import {isAbsolute} from 'node:path';

export const COMMUNITY_CONFIG_INFO_KEY='AgentsToZCommunityConfigurationV1';
export type CommunityBuildConfig=Readonly<{origin:string;issuerPublicKey:string;profileId:string}>;
const invalid=()=>new Error('Invalid public community build configuration');
export function parseCommunityBuildConfig(value:unknown):CommunityBuildConfig{
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='issuerPublicKey,origin,profileId')throw invalid();
  const v=value as Record<string,unknown>;
  if(typeof v.origin!=='string'||typeof v.issuerPublicKey!=='string'||typeof v.profileId!=='string')throw invalid();
  const match=/^https:\/\/([a-z0-9.-]+)$/.exec(v.origin),host=match?.[1];
  if(!host||host.length>253||!host.endsWith('.workers.dev')||!host.split('.').every(p=>p.length<=63&&/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(p)))throw invalid();
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v.profileId)||!/^[A-Za-z0-9_-]{87}$/.test(v.issuerPublicKey))throw invalid();
  const bytes=Buffer.from(v.issuerPublicKey,'base64url');
  try{const converted=ECDH.convertKey(bytes,'prime256v1',undefined,undefined,'uncompressed');if(bytes.length!==65||bytes[0]!==4||bytes.toString('base64url')!==v.issuerPublicKey||!Buffer.isBuffer(converted)||!converted.equals(bytes))throw invalid();}
  catch{throw invalid();}
  return Object.freeze({origin:v.origin,issuerPublicKey:v.issuerPublicKey,profileId:v.profileId});
}
/** Build-time only. A bounded, explicit regular file is read once; no environment or discovery fallback. */
export function readCommunityBuildConfig(path:string):CommunityBuildConfig{
  if(!isAbsolute(path))throw invalid();
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
    const stat=fstatSync(fd);if(!stat.isFile()||stat.size>4096)throw invalid();
    const raw=Buffer.alloc(4097);let length=0;
    while(length<raw.length){const n=readSync(fd,raw,length,raw.length-length,null);if(n===0)break;length+=n;}
    if(length>4096)throw invalid();
    const text=new TextDecoder('utf-8',{fatal:true}).decode(raw.subarray(0,length)),value=JSON.parse(text);
    // Canonical JSON apart from layout whitespace rejects duplicate keys and hidden escaped aliases.
    let compact='',quoted=false,escaped=false;
    for(const c of text){if(quoted||!/[\t\r\n ]/.test(c))compact+=c;if(quoted){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quoted=false;}else if(c==='"')quoted=true;}
    if(JSON.stringify(value)!==compact)throw invalid();
    return parseCommunityBuildConfig(value);
  }catch{throw invalid();}finally{closeSync(fd);}
}
export function serializeCommunityBuildConfig(value:CommunityBuildConfig):string{return JSON.stringify(parseCommunityBuildConfig(value));}
export function communityBuildConfigPlistEntry(value:CommunityBuildConfig|undefined):string{
  if(!value)return '';
  const c=parseCommunityBuildConfig(value),xml=(s:string)=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');
  return `<key>${COMMUNITY_CONFIG_INFO_KEY}</key><dict><key>origin</key><string>${xml(c.origin)}</string><key>issuerPublicKey</key><string>${xml(c.issuerPublicKey)}</string><key>profileId</key><string>${xml(c.profileId)}</string></dict>`;
}
