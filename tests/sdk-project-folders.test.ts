import {afterEach,describe,expect,test} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,symlinkSync,renameSync,realpathSync} from 'node:fs';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import {createSdkFolderActions,type RegisteredSdkFolderProject} from '../src/sdkProjectFolderService';
import {sdkFolderRequest,sdkFolderMention,normalizeSdkFolderDirectory,SDK_FOLDER_LIMIT,SDK_FOLDER_SCAN_LIMIT} from '../src/sdkProjectFolderContract';
import {projectIdentityClipboard} from '../src/projectCode';

const roots:string[]=[];afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function seed(name='SDK 한글 공간'){
  const root=mkdtempSync(join(tmpdir(),name));roots.push(root);mkdirSync(join(root,'.agentstoz'));mkdirSync(join(root,'.agent-memory'));
  writeFileSync(join(root,'.agent-memory/config.json'),JSON.stringify({memoryId:'11111111-1111-4111-8111-111111111111'}));
  writeFileSync(join(root,'.agentstoz/sdk-project.json'),JSON.stringify({schemaVersion:1,kind:'sdk-project',memoryId:'11111111-1111-4111-8111-111111111111',repository:'https://github.com/example/SDK',autoPrepare:false,modules:[{id:'remote-control',path:'remote control',description:'원격 제어',goals:['remote'],prepare:'inspect-only'},{id:'missing-module',path:'not-installed',description:'다른 Mac에서 받을 모듈',goals:[],prepare:'inspect-only'}]}));
  mkdirSync(join(root,'remote control'));mkdirSync(join(root,'scripts'));mkdirSync(join(root,'.private'));writeFileSync(join(root,'README.md'),'fixture');return realpathSync(root);
}
const project=(root:string):RegisteredSdkFolderProject=>({projectId:'a4214da5-1111-4111-8111-111111111111',projectName:'SDK',canonicalPath:root});
describe('registered SDK direct folder actions',()=>{
  test('lists actual modules and unregistered children, merges catalog descriptions, and distinguishes missing modules',async()=>{
    const root=seed(),opened:string[]=[],actions=createSdkFolderActions({resolveProject:async()=>project(root),openPath:async path=>{opened.push(path);}});
    const result=await actions.list(project(root).projectId);expect(result.folders.map(folder=>folder.name)).toEqual(['remote control','not-installed','scripts']);
    expect(result.folders[0]!.description).toBe('원격 제어');expect(result.folders[1]!.state).toBe('missing');expect(result.folders[1]!.id).toBeNull();expect(result.folders[1]!.mention).toBeNull();
    expect(result.folders[2]!.moduleId).toBeNull();expect(JSON.stringify(result)).not.toContain(root);expect(opened).toEqual([]);expect(normalizeSdkFolderDirectory(result)).toEqual(result);
    const child=result.folders[0]!;await actions.open(result.projectId,child.id!);expect(opened).toEqual([join(root,'remote control')]);
  });
  test('copy keeps the existing exact project identity and quotes spaces/control-looking child names as ordinary relative text',()=>{
    const text=sdkFolderMention(' SDK ',project('/fixture').projectId,'remote control "화면";$(do-not-run)');
    expect(text.split('\n')[0]).toBe(projectIdentityClipboard('SDK',project('/fixture').projectId));
    expect(text).toContain('[로컬프로젝트해시: A4214DA5]');expect(text).toContain('"remote control \\"화면\\";$(do-not-run)"'.replaceAll('\\\\','\\'));expect(text).not.toContain('#SDK/');
    expect(sdkFolderMention('SDK\n이름',project('/fixture').projectId,'module')).toStartWith('#SDK 이름 ');
  });
  test('rejects arbitrary paths, unregistered callers and a replaced symlink before opening; never registers children',async()=>{
    const root=seed(),outside=seed('outside SDK '),opened:string[]=[],actions=createSdkFolderActions({resolveProject:async id=>{if(id!==project(root).projectId)throw Error('not registered');return project(root);},openPath:async path=>{opened.push(path);}});
    symlinkSync(outside,join(root,'outside-link'));const listed=await actions.list(project(root).projectId);expect(listed.ignoredSymlinks).toBe(1);expect(listed.folders.some(folder=>folder.name==='outside-link')).toBe(false);
    const row=listed.folders.find(folder=>folder.name==='scripts')!;rmSync(join(root,'scripts'),{recursive:true});symlinkSync(outside,join(root,'scripts'));
    await expect(actions.open(listed.projectId,row.id!)).rejects.toThrow('현재 목록');await expect(actions.open(listed.projectId,'../outside')).rejects.toThrow('목록에서');await expect(actions.list('unknown-project')).rejects.toThrow('not registered');expect(opened).toEqual([]);
    for(const body of [{portId:listed.projectId,folderPath:outside},{portId:listed.projectId,folderId:row.id,root:root},{portId:listed.projectId,folderId:'../scripts'},null])expect(()=>sdkFolderRequest(body,'open-folder')).toThrow();
  });
  test('binds a folder id to the current root and inode rather than reusing a replaced name',async()=>{
    const root=seed(),other=seed(),opened:string[]=[];let changed=false;
    const actions=createSdkFolderActions({resolveProject:async()=>project(changed?other:root),openPath:async path=>{opened.push(path);}}),list=await actions.list(project(root).projectId),row=list.folders.find(folder=>folder.name==='scripts')!;
    changed=true;await expect(actions.open(list.projectId,row.id!)).rejects.toThrow('현재 목록');changed=false;
    renameSync(join(root,'scripts'),join(root,'old-scripts'));mkdirSync(join(root,'scripts'));await expect(actions.open(list.projectId,row.id!)).rejects.toThrow('현재 목록');expect(opened).toEqual([]);
  });
  test('bounds direct enumeration without recursively entering modules or claiming unseen folders are missing',async()=>{
    const root=seed();for(let index=0;index<SDK_FOLDER_LIMIT+10;index++)mkdirSync(join(root,`module-${index}`));
    const actions=createSdkFolderActions({resolveProject:async()=>project(root),openPath:async()=>{}}),result=await actions.list(project(root).projectId);
    expect(result.limited).toBe(true);expect(result.folders.filter(folder=>folder.state==='present').length).toBe(SDK_FOLDER_LIMIT);expect(result.folders.find(folder=>folder.name==='not-installed')?.state).toBe('missing');
    const files=seed();for(let index=0;index<SDK_FOLDER_SCAN_LIMIT+10;index++)writeFileSync(join(files,`plain-${index}.txt`),'x');
    const fileResult=await createSdkFolderActions({resolveProject:async()=>project(files),openPath:async()=>{}}).list(project(files).projectId);expect(fileResult.limited).toBe(true);
  });
  test('catalog and DTO fail closed on identity changes and unsupported path data',async()=>{
    const root=seed(),actions=createSdkFolderActions({resolveProject:async()=>project(root),openPath:async()=>{}}),result=await actions.list(project(root).projectId);
    expect(()=>normalizeSdkFolderDirectory({...result,folders:[{...result.folders[0],relativePath:'/outside'}]})).toThrow();expect(()=>normalizeSdkFolderDirectory({...result,folders:[{...result.folders[0],description:'x'.repeat(1001)}]})).toThrow();
    writeFileSync(join(root,'.agent-memory/config.json'),JSON.stringify({memoryId:'changed-memory'}));await expect(actions.list(result.projectId)).rejects.toThrow('신원');
  });
  test('configured nested modules are inspected and opened as present; a replaced ancestor symlink is refused',async()=>{
    const root=seed(),catalogFile=join(root,'.agentstoz/sdk-project.json');
    const catalog=JSON.parse(await Bun.file(catalogFile).text());catalog.modules.push({id:'nested-runtime',path:'packages/runtime',description:'중첩 런타임',goals:['runtime'],prepare:'inspect-only'});writeFileSync(catalogFile,JSON.stringify(catalog));mkdirSync(join(root,'packages/runtime'),{recursive:true});
    const opened:string[]=[],actions=createSdkFolderActions({resolveProject:async()=>project(root),openPath:async path=>{opened.push(path);}}),list=await actions.list(project(root).projectId),nested=list.folders.find(folder=>folder.relativePath==='packages/runtime')!;
    expect(nested.state).toBe('present');expect(nested.moduleId).toBe('nested-runtime');expect(nested.mention).toContain('"packages/runtime"');await actions.open(list.projectId,nested.id!);expect(opened).toEqual([join(root,'packages/runtime')]);
    const outside=seed('outside nested SDK ');rmSync(join(root,'packages'),{recursive:true});symlinkSync(outside,join(root,'packages'));await expect(actions.list(list.projectId)).rejects.toThrow('설정');await expect(actions.open(list.projectId,nested.id!)).rejects.toThrow('설정');expect(opened).toHaveLength(1);
  });
});
