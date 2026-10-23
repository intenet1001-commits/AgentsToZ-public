import {createHash} from 'node:crypto';
import {realpathSync,statSync} from 'node:fs';
/** Host-only: binds a registered target to the same directory, including replacement at the same path. */
export function workroomThreadProjectFingerprint(cwd:string):string {
 try{const path=realpathSync(cwd),stat=statSync(path);if(!stat.isDirectory())throw Error();return createHash('sha256').update(JSON.stringify([path,stat.dev,stat.ino])).digest('hex');}
 catch{throw Error('업무 프로젝트 디렉터리 상태를 확인하지 못했습니다. Mac의 프로젝트 등록을 확인하세요.');}
}
