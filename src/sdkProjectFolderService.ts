import {createHash} from 'node:crypto';
import {opendir,lstat,realpath} from 'node:fs/promises';
import {join,relative,isAbsolute} from 'node:path';
import {readSdkCatalog,type SdkModule} from './sdkProjectManagement';
import {SDK_FOLDER_LIMIT,SDK_FOLDER_SCAN_LIMIT,SdkFolderError,sdkFolderMention,type SdkFolderDirectory,type SdkFolderRow} from './sdkProjectFolderContract';

export interface RegisteredSdkFolderProject {projectId:string;projectName:string;canonicalPath:string}
type Found={row:SdkFolderRow;canonicalPath:string;identity:string};
const folderId=(root:string,name:string,identity:string)=>`sdkf_${createHash('sha256').update(`agentstoz-sdk-folder-v1\0${root}\0${name}\0${identity}`).digest('hex').slice(0,32)}`;
const inside=(root:string,path:string)=>{const child=relative(root,path);return !!child&&!child.startsWith('..')&&!isAbsolute(child);};
const plainChild=(name:string)=>!!name&&!name.startsWith('.')&&name.length<=255&&!/[\\/\u0000-\u001f\u007f]/.test(name);
function checkedCatalog(root:string){
  try{const catalog=readSdkCatalog(root);if(catalog)return catalog;}catch{}
  throw new SdkFolderError('SDK_CATALOG_REQUIRED','SDK 모듈 설정과 기억 신원을 확인할 수 있는 프로젝트를 선택하세요.');
}
async function inspectFolder(root:string,path:string,project:RegisteredSdkFolderProject,module?:SdkModule):Promise<Found|null>{
  let current=root;
  for(const part of path.split('/')){
    current=join(current,part);
    try{const metadata=await lstat(current);if(metadata.isSymbolicLink())throw new SdkFolderError('SDK_FOLDER_SYMLINK','연결 폴더는 SDK 목록에서 열 수 없습니다.');if(!metadata.isDirectory())return null;}
    catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT'||(error as NodeJS.ErrnoException).code==='ENOTDIR')return null;throw error;}
  }
  const before=await lstat(current),canonicalPath=await realpath(current),after=await lstat(current);
  if(!inside(root,canonicalPath)||canonicalPath!==current||after.isSymbolicLink()||!after.isDirectory()||before.dev!==after.dev||before.ino!==after.ino)throw new SdkFolderError('SDK_FOLDER_CHANGED','SDK 폴더가 조회 중 변경되었습니다. 목록을 다시 확인하세요.');
  const identity=`${after.dev}:${after.ino}`;
  return {canonicalPath,identity,row:{id:folderId(root,path,identity),name:path,relativePath:path,moduleId:module?.id??null,description:module?.description??'SDK 프로젝트의 하위 폴더',state:'present',mention:sdkFolderMention(project.projectName,project.projectId,path)}};
}

async function scan(project:RegisteredSdkFolderProject):Promise<{directory:SdkFolderDirectory;found:Found[]}>{
  const root=await realpath(project.canonicalPath),catalog=checkedCatalog(root);
  const found:Found[]=[];let examined=0,limited=false,ignoredSymlinks=0;
  const directory=await opendir(root,{bufferSize:32});
  for await(const entry of directory){
    if(++examined>SDK_FOLDER_SCAN_LIMIT){limited=true;break;}
    if(!plainChild(entry.name))continue;
    if(entry.isSymbolicLink()){ignoredSymlinks++;continue;}
    if(!entry.isDirectory())continue;
    if(found.length>=SDK_FOLDER_LIMIT){limited=true;break;}
    const child=await inspectFolder(root,entry.name,project,catalog.modules.find(item=>item.path===entry.name));
    if(child)found.push(child);
  }
  const folders=found.map(item=>item.row);
  // The catalog may name nested modules. Inspect those exact paths (at most 32×16 components)
  // without recursively walking their contents, even when the direct-child listing was bounded.
  for(const module of catalog.modules){
    if(folders.some(folder=>folder.relativePath===module.path))continue;
    if(module.path.length>1024||module.path.split('/').length>16){limited=true;continue;}
    const child=await inspectFolder(root,module.path,project,module);
    if(child){found.push(child);folders.push(child.row);}
    else folders.push({id:null,name:module.path,relativePath:module.path,moduleId:module.id,description:module.description,state:'missing',mention:null});
  }
  const order=new Map(catalog.modules.map((module,index)=>[module.path,index]));
  folders.sort((first,second)=>(order.get(first.relativePath)??999)-(order.get(second.relativePath)??999)||first.name.localeCompare(second.name));
  return {directory:{projectId:project.projectId,projectName:project.projectName,folders,limited,ignoredSymlinks},found};
}

/** Reuses the registered project resolver. Neither action accepts a root or relative path from the UI. */
export function createSdkFolderActions(deps:{resolveProject:(projectId:string)=>Promise<RegisteredSdkFolderProject>;openPath:(path:string)=>Promise<void>}){
  return {
    async list(projectId:string):Promise<SdkFolderDirectory>{return (await scan(await deps.resolveProject(projectId))).directory;},
    async open(projectId:string,id:string):Promise<{opened:true;folderId:string;name:string}>{
      if(!/^sdkf_[a-f0-9]{32}$/.test(id))throw new SdkFolderError('SDK_FOLDER_ID_INVALID','목록에서 SDK 하위 폴더를 선택하세요.',400);
      const project=await deps.resolveProject(projectId),root=await realpath(project.canonicalPath);
      const match=(await scan(project)).found.find(item=>item.row.id===id);
      if(!match)throw new SdkFolderError('SDK_FOLDER_NOT_CURRENT','폴더가 변경되었거나 현재 목록에 없습니다. 목록을 다시 확인하세요.');
      const fresh=await deps.resolveProject(projectId);
      if(fresh.projectId!==project.projectId||await realpath(fresh.canonicalPath)!==root)throw new SdkFolderError('SDK_PROJECT_CHANGED','등록된 SDK 프로젝트가 변경되었습니다. 다시 선택하세요.');
      checkedCatalog(root);
      const final=await lstat(match.canonicalPath);
      if(final.isSymbolicLink()||!final.isDirectory()||`${final.dev}:${final.ino}`!==match.identity||await realpath(match.canonicalPath)!==match.canonicalPath||!inside(root,match.canonicalPath))throw new SdkFolderError('SDK_FOLDER_CHANGED','SDK 폴더가 변경되었습니다. 목록을 다시 확인하세요.');
      await deps.openPath(match.canonicalPath);
      return {opened:true,folderId:id,name:match.row.name};
    },
  };
}
