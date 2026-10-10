import {chmodSync,copyFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
export async function buildDutyKmsg(root=import.meta.dir) {
 mkdirSync(join(root,'src-tauri/resources'),{recursive:true});
 copyFileSync(join(root,'vendor/kmsg/LICENSE'),join(root,'src-tauri/resources/agentstoz-kmsg.LICENSE'));
 if(process.platform!=='darwin')return;
 const packagePath=join(root,'vendor/kmsg');
 const child=Bun.spawn(['swift','build','--package-path',packagePath,'-c','release','--disable-automatic-resolution'],{stdout:'inherit',stderr:'inherit'});
 if(await child.exited!==0)throw Error('Bundled KakaoTalk transport build failed');
 const out=join(root,'src-tauri/resources/agentstoz-kmsg');mkdirSync(join(root,'src-tauri/resources'),{recursive:true});
 copyFileSync(join(packagePath,'.build/release/kmsg'),out);chmodSync(out,0o755);
 copyFileSync(join(packagePath,'LICENSE'),out+'.LICENSE');
}
if(import.meta.main)await buildDutyKmsg();
