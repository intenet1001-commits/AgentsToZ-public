import {createHash} from 'node:crypto';
import {lstatSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {withOwnedPortalFileLock} from './portalFileLock';
import {CodexNewChatReceiptError} from './codexNewChatReceipts';

/** Serializes every legacy and v2 launch and local resolve for one exact directory. */
export async function withCodexProjectLaunchLock<T>(appDataDir:string,projectIdentity:string,operation:()=>Promise<T>):Promise<T>{
  const parent=join(appDataDir,'remote-control'),dir=join(parent,'codex-project-locks');
  mkdirSync(dir,{recursive:true,mode:0o700});
  const parentStat=lstatSync(parent);
  const st=lstatSync(dir);
  if(!parentStat.isDirectory()||parentStat.isSymbolicLink()||!st.isDirectory()||st.isSymbolicLink()
    ||(process.platform!=='win32'&&((parentStat.mode&0o077)!==0||parentStat.uid!==process.getuid?.()||(st.mode&0o077)!==0||st.uid!==process.getuid?.()))) {
    throw new CodexNewChatReceiptError('CODEX_NEW_CHAT_RECEIPT_UNAVAILABLE','새 대화 보호 잠금을 확인할 수 없습니다.');
  }
  const name=createHash('sha256').update(projectIdentity).digest('hex');
  try{return await withOwnedPortalFileLock(join(dir,name+'.lock'),operation,{label:'codex project launch',attempts:3,retryMs:0});}
  catch(error){
    if(error instanceof CodexNewChatReceiptError)throw error;
    // Propagate failures from the operation. Lock acquisition errors carry the
    // lock label; never reinterpret a failed launch as a safe retry.
    if(error instanceof Error && error.message.includes('codex project launch') && error.message.includes('잠금')) throw new CodexNewChatReceiptError('CODEX_NEW_CHAT_BUSY','이 프로젝트의 Codex 대화 요청이 진행 중입니다.');
    throw error;
  }
}
