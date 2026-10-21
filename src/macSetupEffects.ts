import {spawn} from 'node:child_process';
import {accessSync,constants,existsSync,mkdirSync,mkdtempSync,rmSync,symlinkSync,lstatSync,copyFileSync,chmodSync,writeFileSync} from 'node:fs';
import {join,isAbsolute,basename} from 'node:path';
import {homedir,tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import type {MacSetupEffects} from './macSetupHost';
import type {MacSetupRow,MacSetupToolId} from './macSetupCatalog';

const names:Partial<Record<MacSetupToolId,string>>={codex:'codex',claude:'claude',hermes:'hermes',agy:'agy',git:'git',node:'node',github:'gh',vercel:'vercel',supabase:'supabase','google-workspace':'gws'};
const apps={
  'codex-app':{name:'Codex.app',bundle:'com.openai.codex',team:'2DC432GLL2'},
  'claude-app':{name:'Claude.app',bundle:'com.anthropic.claudefordesktop',team:'Q6L2SF6YDW'},
  'hermes-app':{name:'Hermes.app',bundle:'com.nousresearch.hermes',team:'T2F6S8MF7C'},
  'ego-app':{name:'ego lite.app',bundle:'com.citrolabs.ego.lite',team:'JGQLC6YQYJ'},
} as const;
const setupChildren=new Set<()=>void>();
process.once('exit',()=>{for(const kill of setupChildren)kill();});
// Only fixed argv follow the wrapper. Nothing is interpolated or evaluated as shell text.
const PARENT_GUARD='parent="$1"; shift; "$@" & worker=$!; (while kill -0 "$parent" 2>/dev/null; do sleep 1; done; /bin/kill -KILL -"$$") & watcher=$!; wait "$worker"; result=$?; kill "$watcher" 2>/dev/null; exit "$result"';
/** Fixed argv only. Installer output is discarded; only bounded probe output may be returned. */
export function macSetupCommand(executable:string,args:string[],env:NodeJS.ProcessEnv,signal?:AbortSignal,timeoutMs=20_000,output=true,acceptedExitCodes:readonly number[]=[0]):Promise<string>{
  return new Promise((resolve,reject)=>{
    if(signal?.aborted)return reject(Error('CANCELLED'));
    const child=spawn('/bin/sh',['-c',PARENT_GUARD,'agentstoz-setup',String(process.pid),executable,...args],{env,stdio:['ignore',output?'pipe':'ignore',output?'pipe':'ignore'],detached:true});
    let text='',bytes=0,settled=false,exitCode=1;
    const kill=()=>{if(child.pid)try{process.kill(-child.pid,'SIGKILL');}catch{}};
    setupChildren.add(kill);
    const stop=()=>{kill();finish(false);};
    const timer=setTimeout(stop,timeoutMs);
    const finish=(ok:boolean)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',stop);kill();setupChildren.delete(kill);ok?resolve(text.trim()):reject(Error('MAC_SETUP_PROCESS'));};
    signal?.addEventListener('abort',stop,{once:true});
    child.stdout?.on('data',c=>{bytes+=c.length;if(bytes>512_000)stop();else text+=c.toString();});
    child.stderr?.on('data',c=>{bytes+=c.length;if(bytes>512_000)stop();});
    child.on('error',()=>finish(false));child.on('exit',c=>{exitCode=c??-1;kill();});child.on('close',()=>finish(acceptedExitCodes.includes(exitCode)));
  });
}
export function createMacSetupEffects(appDirectory:string,home=homedir(),options:{searchPaths?:string[]}={}):MacSetupEffects {
  const managed=join(home,'.local','share','agentstoz','tools'),bin=join(home,'.local','bin');
  const env:NodeJS.ProcessEnv={HOME:home,USER:process.env.USER,LOGNAME:process.env.LOGNAME,TMPDIR:process.env.TMPDIR,LANG:'en_US.UTF-8',PATH:[bin,join(managed,'npm','bin'),join(home,'.hermes','bin'),join(home,'.volta','bin'),...(process.env.PATH??'').split(':').filter(isAbsolute),'/opt/homebrew/bin','/usr/local/bin','/usr/bin','/bin','/usr/sbin','/sbin'].join(':'),CI:'1',NO_COLOR:'1',HOMEBREW_NO_AUTO_UPDATE:'1',GIT_TERMINAL_PROMPT:'0'};
  const run=async(exe:string,args:string[],signal?:AbortSignal,timeout?:number,output=true)=>{
    if(basename(exe)!=='npm')return macSetupCommand(exe,args,env,signal,timeout,output);
    // npm 11 rejects the same file loaded as both user and global config. Keep both
    // credential-free and distinct, including when the person's npm has its own settings.
    const folder=mkdtempSync(join(tmpdir(),'agentstoz-setup-npm-'));
    try{
      const user=join(folder,'user.npmrc'),global=join(folder,'global.npmrc');
      for(const file of [user,global])writeFileSync(file,'',{mode:0o600,flag:'wx'});
      return await macSetupCommand(exe,args,{...env,NPM_CONFIG_USERCONFIG:user,NPM_CONFIG_GLOBALCONFIG:global},signal,timeout,output);
    }finally{rmSync(folder,{recursive:true,force:true});}
  };
  const which=(name:string)=>(options.searchPaths??env.PATH!.split(':')).map(p=>join(p,name)).find(p=>{try{accessSync(p,constants.X_OK);return true;}catch{return false;}})??null;
  const appPath=async(id:keyof typeof apps)=>{
    const known=['/Applications',join(home,'Applications')].map(p=>join(p,apps[id].name)).find(p=>existsSync(p));if(known)return known;
    // The current OpenAI desktop distribution can carry its original bundle identity under ChatGPT.app.
    if(id==='codex-app')for(const root of ['/Applications',join(home,'Applications')]){const path=join(root,'ChatGPT.app');if(existsSync(path)&&await run('/usr/bin/plutil',['-extract','CFBundleIdentifier','raw','-o','-',join(path,'Contents/Info.plist')]).catch(()=>null)===apps[id].bundle)return path;}
    return null;
  };
  async function probe(id:MacSetupToolId):Promise<MacSetupRow>{
    const row=(state:MacSetupRow['state'],message:string):MacSetupRow=>({id,state,message,checkedAt:Date.now()});
    if(id in apps){
      const a=id as keyof typeof apps,path=await appPath(a);if(!path)return row('missing','설치 필요');
      const bundle=await run('/usr/bin/plutil',['-extract','CFBundleIdentifier','raw','-o','-',join(path,'Contents/Info.plist')]).catch(()=>null);
      if(bundle!==apps[a].bundle)return row('needs-action',a==='hermes-app'&&bundle==='com.nousresearch.hermes.setup'?'Hermes 첫 설치 화면을 마친 뒤 다시 검사하세요.':'같은 이름의 앱을 확인해야 합니다. 기존 파일을 보존했습니다.');
      const processes=await run('/bin/ps',['-axo','comm=']);
      return processes.split('\n').some(p=>p.trim().startsWith(path+'/Contents/MacOS/'))?row('running','실제 실행 확인 · 계정 로그인은 앱 안에서 확인하세요.'):row('installed','설치됨 · 앱 실행 확인 필요');
    }
    const exe=which(names[id]!);if(!exe)return row('missing','설치 필요');
    // The system Git stub can trigger a developer-tools dialog even for --version.
    if(id==='git'&&exe==='/usr/bin/git'&&!await run('/usr/bin/xcode-select',['-p']).catch(()=>null))return row('missing','Apple 개발자 도구 설치 필요');
    try{
      const version=await run(exe,['--version']);
      const number=version.match(/(?<![0-9])\d+\.\d+(?:\.\d+)?(?:[-+][A-Za-z0-9.-]+)?\b/)?.[0];
      if(!number)return row('needs-action','실행 응답을 해석하지 못했습니다. 기존 설치를 보존했습니다.');
      if(id==='node'&&!await run(which('npm')??'/usr/local/bin/npm',['--version']).catch(()=>null))return row('needs-action','Node.js는 실행됐으나 npm 확인이 필요합니다.');
      return row('installed','실제 실행 확인 · '+number.slice(0,50));
    }catch{return row('needs-action','설치 파일은 있으나 실행을 확인하지 못했습니다. 재설치하지 않았습니다.');}
  }
  async function download(url:string,file:string,signal:AbortSignal){
    await run('/usr/bin/curl',['--fail','--location','--silent','--show-error','--proto','=https','--proto-redir','=https','--max-time','1200','--max-filesize','1200000000','--output',file,url],signal,1_210_000,false);
  }
  async function json(url:string,signal:AbortSignal){return JSON.parse(await run('/usr/bin/curl',['-fsSL','--proto','=https','--proto-redir','=https','--max-time','30',url],signal,35_000));}
  async function digest(file:string,expected:string,signal:AbortSignal){if(!/^[a-f0-9]{64}$/.test(expected))throw Error('DIGEST');const actual=(await run('/usr/bin/shasum',['-a','256',file],signal)).split(/\s/)[0];if(actual!==expected)throw Error('DIGEST');}
  async function signedApp(path:string,bundle:string,team:string,signal:AbortSignal){
    if(await run('/usr/bin/plutil',['-extract','CFBundleIdentifier','raw','-o','-',join(path,'Contents/Info.plist')],signal)!==bundle)throw Error('BUNDLE');
    await run('/usr/bin/codesign',['--verify','--deep','--strict','-R',`anchor apple generic and identifier "${bundle}" and certificate leaf[subject.OU] = "${team}"`,path],signal);
    await run('/usr/sbin/spctl',['--assess','--type','execute',path],signal,60_000);
  }
  async function work<T>(fn:(dir:string)=>Promise<T>){mkdirSync(join(appDirectory,'mac-setup'),{recursive:true,mode:0o700});const dir=mkdtempSync(join(appDirectory,'mac-setup','download-'));try{return await fn(dir);}finally{rmSync(dir,{recursive:true,force:true});}}
  async function installApp(id:keyof typeof apps,signal:AbortSignal){
    if(await appPath(id))return;
    await work(async dir=>{
      let url:string,sha:string|undefined,zip=false,bundle:string=apps[id].bundle;
      if(id==='codex-app'||id==='claude-app'){
        const d=await json('https://formulae.brew.sh/api/cask/'+(id==='codex-app'?'codex-app':'claude')+'.json',signal);
        const host=new URL(d.url).hostname;
        if(id==='codex-app'?host!=='persistent.oaistatic.com':host!=='downloads.claude.ai')throw Error('SOURCE');
        url=d.url;sha=d.sha256;if(typeof sha!=='string'||!/^[a-f0-9]{64}$/.test(sha))throw Error('SOURCE_DIGEST');zip=url.endsWith('.zip');
      }else if(id==='ego-app')url=`https://cdn.ego.app/setup/macos/${process.arch==='arm64'?'arm64':'x64'}/egolite.dmg`;
      else {if(process.arch!=='arm64')throw Error('HERMES_ARCH');url='https://hermes-assets.nousresearch.com/Hermes-Setup.dmg';bundle='com.nousresearch.hermes.setup';}
      const archive=join(dir,zip?'app.zip':'app.dmg'),mount=join(dir,'mount');await download(url,archive,signal);if(sha)await digest(archive,sha,signal);
      let attached=false;
      try{
        if(zip){mkdirSync(mount);await run('/usr/bin/ditto',['-x','-k',archive,mount],signal,120_000);}
        else{mkdirSync(mount);await run('/usr/bin/hdiutil',['attach','-readonly','-nobrowse','-noautoopen','-mountpoint',mount,archive],signal,90_000);attached=true;}
        const source=join(mount,apps[id].name);await signedApp(source,bundle,apps[id].team,signal);
        const destinationDir=join(home,'Applications');mkdirSync(destinationDir,{recursive:true});
        const dest=join(destinationDir,apps[id].name);if(existsSync(dest)||await appPath(id))return;
        const staging=join(destinationDir,'.atz-'+id+'-'+createHash('sha256').update(dir).digest('hex').slice(0,12)+'.app');
        try{
          await run('/usr/bin/ditto',[source,staging],signal,120_000);await signedApp(staging,bundle,apps[id].team,signal);
          // mkdir is the atomic, no-replace destination claim (rename may replace an empty directory).
          mkdirSync(dest);
          await run('/usr/bin/ditto',[staging,dest],signal,120_000);await signedApp(dest,bundle,apps[id].team,signal);
          if(id==='hermes-app')await run('/usr/bin/open',[dest],signal);
        }finally{rmSync(staging,{recursive:true,force:true});}
      }finally{if(attached)await run('/usr/bin/hdiutil',['detach',mount],undefined,30_000).catch(()=>{});}
    });
  }
  async function nodeInstaller(signal:AbortSignal){
    // Native Installer owns administrator approval; neither passwords nor sudo go through the app.
    const index=await json('https://nodejs.org/dist/index.json',signal),release=index.find((r:any)=>r.lts&&r.files?.includes('osx-x64-pkg'));
    if(!release||!/^v\d+\.\d+\.\d+$/.test(release.version))throw Error('NODE_RELEASE');
    const folder=mkdtempSync(join(appDirectory,'mac-setup','node-installer-'));
    const name='node-'+release.version+'.pkg',file=join(folder,name),base='https://nodejs.org/dist/'+release.version+'/';
    const sums=await run('/usr/bin/curl',['-fsSL','--proto','=https','--max-time','30',base+'SHASUMS256.txt'],signal,35_000);
    const expected=sums.split('\n').find(l=>l.trim().endsWith(' '+name))?.split(/\s+/)[0];if(!expected)throw Error('NODE_DIGEST');
    try{
      await download(base+name,file,signal);await digest(file,expected,signal);
      const info=await run('/usr/sbin/pkgutil',['--check-signature',file],signal);if(!info.includes('Developer ID Installer: Node.js Foundation (HX7739G8FX)'))throw Error('NODE_SIGNATURE');
      await run('/usr/sbin/spctl',['--assess','--type','install',file],signal,60_000);
      await run('/usr/bin/open',['-W',file],signal,1_200_000);
    }finally{rmSync(folder,{recursive:true,force:true});}
  }
  async function releaseBinary(id:'github'|'supabase',signal:AbortSignal){
    const repo=id==='github'?'cli/cli':'supabase/cli',binary=names[id]!,arch=process.arch==='arm64'?'arm64':'amd64';
    await work(async dir=>{
      const release=await json('https://api.github.com/repos/'+repo+'/releases/latest',signal);
      const asset=release.assets.find((a:any)=>typeof a.name==='string'&&(id==='github'?a.name.startsWith('gh_')&&a.name.endsWith(`_macOS_${arch}.zip`):a.name===`supabase_darwin_${arch}.tar.gz`));
      if(!asset||!asset.browser_download_url.startsWith('https://github.com/'+repo+'/releases/download/')||!/^sha256:[a-f0-9]{64}$/.test(asset.digest))throw Error('RELEASE');
      const file=join(dir,id==='github'?'archive.zip':'archive.tar.gz');await download(asset.browser_download_url,file,signal);await digest(file,asset.digest.slice(7),signal);
      const unpack=join(dir,'unpack');mkdirSync(unpack);
      if(id==='github')await run('/usr/bin/ditto',['-x','-k',file,unpack],signal,90_000);else await run('/usr/bin/tar',['-xzf',file,'-C',unpack,'supabase'],signal,90_000);
      const source=id==='github'?join(unpack,asset.name.slice(0,-4),'bin','gh'):join(unpack,'supabase');
      await run(source,['--version'],signal);
      mkdirSync(bin,{recursive:true});const dest=join(bin,binary);
      // copyFile COPYFILE_EXCL prevents overwriting even when the binary appears during download.
      copyFileSync(source,dest,constants.COPYFILE_EXCL);
    });
  }
  async function install(id:MacSetupToolId,signal:AbortSignal){
    if((await probe(id)).state!=='missing')return;
    if(id in apps)return installApp(id as keyof typeof apps,signal);
    if(id==='git'){await run('/usr/bin/xcode-select',['--install'],signal);return;}
    if(id==='node')return nodeInstaller(signal);
    if(id==='github'||id==='supabase')return releaseBinary(id,signal);
    if(id==='agy')return work(async dir=>{
      // Reuse the official bootstrap manifest and digest, keeping Gatekeeper and shell settings intact.
      const manifest=await json(`https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/darwin_${process.arch==='arm64'?'arm64':'amd64'}.json`,signal);
      if(typeof manifest.url!=='string'||!manifest.url.startsWith('https://')||!/^[a-f0-9]{128}$/.test(manifest.sha512))throw Error('AGY_MANIFEST');
      const archive=join(dir,'agy-payload');await download(manifest.url,archive,signal);
      if((await run('/usr/bin/shasum',['-a','512',archive],signal)).split(/\s/)[0]!==manifest.sha512)throw Error('AGY_DIGEST');
      let source=archive;
      if(new URL(manifest.url).pathname.endsWith('.tar.gz')){await run('/usr/bin/tar',['-xzf',archive,'-C',dir,'antigravity'],signal,90_000);source=join(dir,'antigravity');}
      chmodSync(source,0o755);await run(source,['--version'],signal);mkdirSync(bin,{recursive:true});copyFileSync(source,join(bin,'agy'),constants.COPYFILE_EXCL);
    });
    if(id==='hermes'){
      if(id==='hermes'&&(await probe('git')).state!=='installed')throw Error('GIT_REQUIRED');
      return work(async dir=>{
        const url='https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh',file=join(dir,'install.sh');
        await download(url,file,signal);
        await run('/bin/bash',[file,'--non-interactive','--skip-browser','--skip-computer-use'],signal,1_200_000,false);
      });
    }
    const npm=which('npm');if(!npm)throw Error('NODE_REQUIRED');
    const packages:Partial<Record<MacSetupToolId,string>>={codex:'@openai/codex',claude:'@anthropic-ai/claude-code',vercel:'vercel','google-workspace':'@googleworkspace/cli'};
    const pkg=packages[id];if(!pkg)throw Error('UNKNOWN_INSTALLER');
    const prefix=join(managed,'npm');mkdirSync(prefix,{recursive:true,mode:0o700});
    await run(npm,['install','--global','--prefix',prefix,'--no-audit','--no-fund',pkg],signal,1_200_000,false);
    mkdirSync(bin,{recursive:true});const dest=join(bin,names[id]!);if(!existsSync(dest))symlinkSync(join(prefix,'bin',names[id]!),dest);
  }
  return {probe,install,launch:async(id,signal)=>{if(!(id in apps))throw Error('APP_REQUIRED');const path=await appPath(id as keyof typeof apps);if(!path)throw Error('MISSING_APP');await run('/usr/bin/open',[path],signal);for(let i=0;i<15&&!signal.aborted;i++){if((await probe(id)).state==='running')return;await new Promise(r=>setTimeout(r,1000));}}};
}
