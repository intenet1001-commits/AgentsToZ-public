import {readFileSync,realpathSync,statSync} from 'node:fs';
import {basename,dirname,join} from 'node:path';
import {homedir} from 'node:os';
/** Metadata only. Never starts a provider or reads an authentication file. */
export function workroomEffortRuntimeSupport(executable: string, agent: string, env: Record<string,string|undefined>, cwd: string) {
  let version = '';
  try {
    let path = realpathSync(executable);
    if (/^\d+\.\d+\.\d+$/.test(basename(path))) version = basename(path);
    for (let depth = 0; !version && depth < 8; depth++, path = dirname(path)) {
      for (const name of ['package.json', ...(agent === 'codex' ? ['codex-package.json'] : [])]) {
        const file = join(path,name);
        try {
          if (statSync(file).size > 65536) continue;
          const p=JSON.parse(readFileSync(file,'utf8'));
          const npm=/^@(?:openai\/codex(?:-|$)|anthropic-ai\/claude-code$)/.test(p.name??'');
          // Official standalone releases keep version + target beside bin/codex, without an npm name.
          const standalone=name==='codex-package.json' && path===dirname(dirname(realpathSync(executable))) && /^(?:aarch64|x86_64)-(?:apple-darwin|unknown-linux-(?:gnu|musl)|pc-windows-msvc)$/.test(p.target??'');
          if ((npm||standalone) && /^\d+\.\d+\.\d+$/.test(p.version??'')) version=p.version;
        } catch {}
      }
      if (dirname(path) === path) break;
    }
  } catch {}
  const parts=version.split('.').map(Number);
  const claudeSessionPicker=agent==='claude' && (parts[0]!>2 || parts[0]===2 && (parts[1]!>1 || parts[1]===1 && parts[2]!>=257));
  let codexDefaultKeys=agent==='codex' && parts[0]===0 && parts[1]!>=163;
  if(codexDefaultKeys) {
    const paths=[join(env.CODEX_HOME??join(env.HOME??homedir(),'.codex'),'config.toml'),'/etc/codex/managed_config.toml'];
    let dir=cwd;
    for(let depth=0;depth<32;depth++){paths.push(join(dir,'.codex/config.toml'));if(dirname(dir)===dir)break;dir=dirname(dir);}
    for(const file of new Set(paths))try{if(statSync(file).size>65536){codexDefaultKeys=false;break;}if(/(?:keymap|keybindings)/i.test(readFileSync(file,'utf8').replace(/^\s*#.*$/gm,''))){codexDefaultKeys=false;break;}}catch(e:any){if(e?.code!=='ENOENT'&&e?.code!=='ENOTDIR'){codexDefaultKeys=false;break;}}
  }
  return {claudeSessionPicker,codexDefaultKeys};
}
