/** Explicit network validation only: isolated HOME, no account login, no global app install. */
import {mkdtempSync,mkdirSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createMacSetupEffects} from '../src/macSetupEffects';
if(process.platform!=='darwin'||!process.argv.includes('--isolated-network-check'))throw Error('Use on macOS with --isolated-network-check');
const root=mkdtempSync(join(tmpdir(),'atz-official-installer-')),home=join(root,'home'),data=join(root,'data'),bin=join(home,'.local/bin');mkdirSync(bin,{recursive:true});mkdirSync(data);
const report:{id:string;state:string;message:string}[]=[];
try{
  for(const name of ['node','npm','git']){const existing=Bun.which(name);if(!existing)throw Error('This isolated check needs an already installed '+name);symlinkSync(existing,join(bin,name));}
  const effects=createMacSetupEffects(data,home,{searchPaths:[bin]});
  const tools=process.argv.includes('--native-ai-only')?['hermes','agy'] as const:['github','supabase','codex','claude','vercel','google-workspace'] as const;
  for(const id of tools){
    if((await effects.probe(id)).state!=='missing')throw Error('Isolation failed: '+id);
    await effects.install(id,new AbortController().signal);
    const result=await effects.probe(id);report.push(result);console.log(JSON.stringify(result));if(result.state!=='installed')throw Error('No executable proof: '+id);
    // Repeating a completed recipe must preserve the installed executable and skip installation.
    await effects.install(id,new AbortController().signal);
  }
}finally{writeFileSync(process.argv.includes('--native-ai-only')?'/tmp/atz-mac-native-ai-installer-results.json':'/tmp/atz-mac-official-installer-results.json',JSON.stringify({isolation:'temporary HOME and user-local prefix, version checks only, no authentication',results:report},null,2));rmSync(root,{recursive:true,force:true});}
