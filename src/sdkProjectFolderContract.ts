export const SDK_FOLDER_LIMIT=128;
export const SDK_FOLDER_SCAN_LIMIT=512;
export const SDK_FOLDER_ROW_LIMIT=160;
export interface SdkFolderRow {id:string|null;name:string;relativePath:string;moduleId:string|null;description:string;state:'present'|'missing';mention:string|null}
export interface SdkFolderDirectory {projectId:string;projectName:string;folders:SdkFolderRow[];limited:boolean;ignoredSymlinks:number}
export class SdkFolderError extends Error {constructor(readonly code:string,message:string,readonly status=409){super(message);}}
export function sdkFolderRequest(value:unknown,operation:'folders'|'open-folder'):{portId:string;folderId?:string}{
  const keys=operation==='folders'?['portId']:['portId','folderId'];
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||Object.keys(value).some(key=>!keys.includes(key)))throw new SdkFolderError('SDK_FOLDER_INPUT_INVALID','등록된 SDK 프로젝트와 하위 폴더를 선택하세요.',400);
  const input=value as Record<string,unknown>;
  if(typeof input.portId!=='string'||!/^[A-Za-z0-9_-]{1,160}$/.test(input.portId)||operation==='open-folder'&&(typeof input.folderId!=='string'||!/^sdkf_[a-f0-9]{32}$/.test(input.folderId)))throw new SdkFolderError('SDK_FOLDER_INPUT_INVALID','등록된 SDK 프로젝트와 하위 폴더를 선택하세요.',400);
  return {portId:input.portId,...(operation==='open-folder'?{folderId:input.folderId as string}:{})};
}
/** The registered root remains the mention. A child is quoted plain text, never a new slash alias. */
export function sdkFolderMention(projectName:string,projectId:string,relativePath:string):string{
  const name=projectName.replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim().slice(0,120);
  return `${projectIdentityClipboard(name,projectId)}\n하위 폴더 ${JSON.stringify(relativePath)}를 참고해 주세요.`;
}
export function normalizeSdkFolderDirectory(value:unknown):SdkFolderDirectory{
  const invalid=()=>{throw new Error('SDK 하위 폴더 목록 형식을 확인하지 못했습니다.');};
  if(!value||typeof value!=='object'||Array.isArray(value))return invalid();
  const result=value as SdkFolderDirectory;
  if(typeof result.projectId!=='string'||typeof result.projectName!=='string'||!Array.isArray(result.folders)||result.folders.length>SDK_FOLDER_ROW_LIMIT||typeof result.limited!=='boolean'||!Number.isSafeInteger(result.ignoredSymlinks)||result.ignoredSymlinks<0)return invalid();
  for(const folder of result.folders){
    if(!folder||typeof folder.name!=='string'||folder.name.length>1024||typeof folder.relativePath!=='string'||folder.relativePath.length>1024||folder.relativePath.startsWith('/')||folder.relativePath.includes('\\')||folder.relativePath.split('/').some(part=>!part||part==='.'||part==='..')||typeof folder.description!=='string'||folder.description.length>1000||!['present','missing'].includes(folder.state)||(folder.moduleId!==null&&typeof folder.moduleId!=='string')||(folder.state==='present'?(folder.id===null||!/^sdkf_[a-f0-9]{32}$/.test(folder.id)||typeof folder.mention!=='string'):folder.id!==null||folder.mention!==null))return invalid();
  }
  return result;
}
import {projectIdentityClipboard} from './projectCode';
