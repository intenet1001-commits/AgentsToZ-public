/** Project-owned, file-only preparation/observation handoff. No native adapter, OS access, launch or input. */
import {constants,openSync,closeSync,fstatSync,readFileSync,lstatSync,mkdirSync,writeFileSync,renameSync,existsSync} from 'node:fs';
import {resolve,join,relative,isAbsolute,dirname} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {gitRunner} from '../buildVersion';
import {parseDesktopOperativeConfig,parseDesktopOperativePlan,parseDesktopManualReceipt,parseDesktopOperativeStatus,desktopOperativeStatus,manualEvidenceReferences} from '../src/testerDesktopOperative';
const root=resolve(import.meta.dir,'..'),area='.agentstoz/maintainer/desktop-operative',configPath='.agentstoz/desktop-operative.json';
const sha=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
function file(path:string,max=256_000):Buffer{
  if(isAbsolute(path)||!path||path.includes('\\')||path.split('/').some(p=>!p||p==='.'||p==='..'))throw Error('DESKTOP_OPERATIVE_PATH');
  const absolute=resolve(root,path);if(relative(root,absolute).startsWith('..'))throw Error('DESKTOP_OPERATIVE_PATH');
  for(let p=absolute;p!==root;p=dirname(p))if(lstatSync(p).isSymbolicLink())throw Error('DESKTOP_OPERATIVE_SYMLINK');
  const fd=openSync(absolute,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{const s=fstatSync(fd);if(!s.isFile()||s.size>max||process.getuid&&s.uid!==process.getuid())throw Error('DESKTOP_OPERATIVE_FILE');return readFileSync(fd);}finally{closeSync(fd);}
}
function privateDirectory(path:string){
  let current=root;for(const part of path.split('/')){current=join(current,part);if(!existsSync(current))mkdirSync(current,{mode:0o700});const s=lstatSync(current);if(!s.isDirectory()||s.isSymbolicLink()||process.getuid&&s.uid!==process.getuid()||(s.mode&0o022))throw Error('DESKTOP_OPERATIVE_DIRECTORY');}
}
function saveNew(path:string,value:unknown){writeFileSync(join(root,path),JSON.stringify(value,null,2)+'\n',{mode:0o600,flag:'wx'});}
function statusFile(value:unknown){privateDirectory(area);const temporary=join(root,area,`status-${randomUUID()}.json`);writeFileSync(temporary,JSON.stringify(value,null,2)+'\n',{mode:0o600,flag:'wx'});const destination=join(root,area,'status.json');if(existsSync(destination)){const s=lstatSync(destination);if(!s.isFile()||s.isSymbolicLink()||process.getuid&&s.uid!==process.getuid())throw Error('DESKTOP_OPERATIVE_FILE');}renameSync(temporary,destination);}
const args=process.argv.slice(2),operation=args.shift()??'status';
try{
  if(operation==='contract'){
    if(args.length)throw Error('DESKTOP_OPERATIVE_OPTIONS');
    console.log(JSON.stringify({schemaVersion:1,nativeAdapter:'absent',automaticNativeVerdict:null,commands:['status','report','prepare --device <label> --mode isolated|operational --scope-reference <human-reviewed-scope> [--app-source <published-app-SHA>]','record-manual --plan <project-relative-plan.json> --receipt <project-relative-observation.json>'],scope:'Exact project bundle, application source, device and isolated-data or explicit operational scope. A scope reference is not an OS grant.',manualReceipt:'DesktopManualReceipt in src/testerDesktopOperative.ts; actual inventory/button/before/after/effect evidence required. Project-relative regular files and SHA256 are verified; no arbitrary driver registration.',unknown:'Stop after an unknown or blocked effect. Preserve the original operation ID; no new click or automatic replay. An unresolved run blocks a new prepare.',limits:'File-only. Does not launch/capture/click, contact installed ports, change TCC, approve BIO, or turn manual/browser/fixture observations into native PASS.'},null,2));
  }else{
    const config=parseDesktopOperativeConfig(JSON.parse(file(configPath).toString()));
    let previous;try{previous=parseDesktopOperativeStatus(JSON.parse(file(area+'/status.json',16_000).toString()),config);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
    // Recover an already-recorded original after a failed status projection write. No native effect is resent.
    if(previous){try{
      const storedPlan=parseDesktopOperativePlan(JSON.parse(file(area+'/'+previous.runId+'/plan.json').toString()));
      if(storedPlan.scope.bundleId!==config.bundleId||storedPlan.maxTargets!==config.maxTargets)throw Error('DESKTOP_OPERATIVE_CURRENT_PLAN');
      const storedReceipt=parseDesktopManualReceipt(JSON.parse(file(area+'/'+previous.runId+'/manual-receipt.json').toString()),storedPlan,Date.now());
      previous=desktopOperativeStatus(storedPlan,storedReceipt);
    }catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}}
    if(operation==='status'||operation==='report'){
      if(args.length)throw Error('DESKTOP_OPERATIVE_OPTIONS');
      console.log(JSON.stringify(previous??{schemaVersion:1,state:'blocked',bundleId:config.bundleId,reason:'adapter-absent',verdict:null,inventory:0,clicked:0,effects:0},null,2));
      if(operation==='report'){console.error('DESKTOP_NATIVE_ADAPTER_ABSENT: Connected CUA host adapter is not implemented. Manual observations remain ungraded; native PASS and baseline are not emitted.');process.exitCode=3;}
    }else{
      const values=new Map<string,string>();while(args.length){const key=args.shift()!,value=args.shift();if(!value||values.has(key)||value.startsWith('--'))throw Error('DESKTOP_OPERATIVE_OPTIONS');values.set(key,value);}
      if(operation==='prepare'){
        if([...values.keys()].some(k=>!['--device','--mode','--scope-reference','--app-source'].includes(k))||previous?.state==='unknown')throw Error(previous?.state==='unknown'?'DESKTOP_OPERATIVE_ORIGINAL_UNKNOWN':'DESKTOP_OPERATIVE_OPTIONS');
        const git=gitRunner(root),head=git(['rev-parse','HEAD']),dirty=git(['status','--porcelain=v1','--untracked-files=all']);if(head.exitCode||dirty.exitCode||dirty.stdout.trim())throw Error('DESKTOP_OPERATIVE_CLEAN_SOURCE');
        const appCommit=values.get('--app-source')??head.stdout.trim();if(!/^[a-f0-9]{40}$/.test(appCommit)||git(['merge-base','--is-ancestor',appCommit,'HEAD']).exitCode)throw Error('DESKTOP_OPERATIVE_APP_SOURCE');
        const now=Date.now(),plan=parseDesktopOperativePlan({schemaVersion:1,runId:randomUUID(),projectCommit:head.stdout.trim(),scope:{bundleId:config.bundleId,appCommit,device:values.get('--device'),mode:values.get('--mode'),scopeReference:values.get('--scope-reference')},createdAt:now,expiresAt:now+1_800_000,maxTargets:config.maxTargets});
        const directory=area+'/'+plan.runId;privateDirectory(directory);saveNew(directory+'/plan.json',plan);statusFile(desktopOperativeStatus(plan));console.log(JSON.stringify({state:'blocked',plan:directory+'/plan.json',scope:plan.scope,nativeAdapter:'absent',verdict:null,next:'Only the existing connected CUA host may manually observe the reviewed app scope. Record its actual evidence with record-manual; this does not grant control or produce PASS.'},null,2));
      }else if(operation==='record-manual'){
        if(values.size!==2||!values.has('--plan')||!values.has('--receipt'))throw Error('DESKTOP_OPERATIVE_OPTIONS');
        const plan=parseDesktopOperativePlan(JSON.parse(file(values.get('--plan')!).toString()));if(plan.scope.bundleId!==config.bundleId||plan.maxTargets!==config.maxTargets||!previous||previous.runId!==plan.runId)throw Error('DESKTOP_OPERATIVE_CURRENT_PLAN');
        const raw=file(values.get('--receipt')!),receipt=parseDesktopManualReceipt(JSON.parse(raw.toString()),plan,Date.now());
        let bytes=0;const seen=new Map<string,string>();for(const ref of manualEvidenceReferences(receipt)){if(seen.has(ref.path)){if(seen.get(ref.path)!==ref.sha256)throw Error('DESKTOP_OPERATIVE_EVIDENCE_CONFLICT');continue;}const body=file(ref.path,8_000_000);bytes+=body.length;if(bytes>64_000_000||sha(body)!==ref.sha256)throw Error('DESKTOP_OPERATIVE_EVIDENCE');seen.set(ref.path,ref.sha256);}
        const saved=area+'/'+plan.runId+'/manual-receipt.json';if(existsSync(join(root,saved))){if(!file(saved).equals(raw))throw Error('DESKTOP_OPERATIVE_ORIGINAL_RECEIPT_IMMUTABLE');}else writeFileSync(join(root,saved),raw,{mode:0o600,flag:'wx'});
        const status=desktopOperativeStatus(plan,receipt);statusFile(status);console.log(JSON.stringify({...status,manualReceipt:saved,receiptSha256:sha(raw),automaticPass:false},null,2));
      }else throw Error('DESKTOP_OPERATIVE_OPTIONS');
    }
  }
}catch(error){console.error(error instanceof Error&&/^DESKTOP_OPERATIVE_[A-Z_]+$/.test(error.message)?error.message:'DESKTOP_OPERATIVE_UNAVAILABLE');process.exitCode=3;}
