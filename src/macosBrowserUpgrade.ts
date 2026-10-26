import {statSync} from 'node:fs';
import {join} from 'node:path';
const manifest=(app:string)=>join(app,'Contents/Resources/workroom-browser.json');
const framework=(app:string)=>join(app,'Contents/Frameworks/Chromium Embedded Framework.framework/Chromium Embedded Framework');
function file(path:string){try{return statSync(path).isFile();}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw new Error('앱의 브라우저 구성을 확인하지 못했습니다. 현재 앱을 유지해 주세요.');}}
export function hasMacosEmbeddedBrowser(app:string){return file(manifest(app))||file(framework(app));}
const message='현재 앱의 내장 브라우저를 유지하려면 브라우저가 포함된 새 앱이 필요합니다.';
export function assertMacosBrowserBuildVariant(installedApp:string,embedded:boolean){if(!embedded&&hasMacosEmbeddedBrowser(installedApp))throw new Error(`${message} --embedded-browser 빌드를 사용해 주세요.`);}
/** An ordinary update may add Chromium, but must not silently remove it. */
export function assertMacosBrowserUpgrade(sourceApp:string,installedApp:string){if(hasMacosEmbeddedBrowser(installedApp)&&(!file(manifest(sourceApp))||!file(framework(sourceApp))))throw new Error(message);}
