import {join, basename} from 'node:path';
import {mkdirSync} from 'node:fs';
import {createCliAccountsApiFixture} from './cliAccountsApi';
const fixture=await createCliAccountsApiFixture();
const out=join(fixture.home,'ui');mkdirSync(out);
const built=await Bun.build({entrypoints:[join(import.meta.dir,'cli-accounts-ui.tsx')],outdir:out,target:'browser',minify:false});
if(!built.success)throw Error('UI fixture build failed');
const script=built.outputs.find(o=>o.kind==='entry-point')!,style=built.outputs.find(o=>o.path.endsWith('.css'));
const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:async req=>{
 const u=new URL(req.url);
 if(u.pathname.startsWith('/api/')){
  const headers=new Headers({'Content-Type':'application/json',Origin:'http://localhost:9000'});
  return fetch(fixture.baseUrl+u.pathname+u.search,{method:req.method,headers,body:req.method==='GET'?undefined:await req.arrayBuffer()});
 }
 if(u.pathname.endsWith('.js'))return new Response(Bun.file(script.path),{headers:{'Content-Type':'text/javascript'}});
 if(u.pathname.endsWith('.css')&&style)return new Response(Bun.file(style.path),{headers:{'Content-Type':'text/css'}});
 return new Response(`<!doctype html><html lang="ko"><meta name="viewport" content="width=device-width,initial-scale=1"><head>${style?`<link rel="stylesheet" href="/${basename(style.path)}">`:''}</head><body style="margin:0"><div id="root"></div><script type="module" src="/${basename(script.path)}"></script></body></html>`,{headers:{'Content-Type':'text/html'}});
}});
console.log(JSON.stringify({url:server.url.toString(),api:fixture.baseUrl}));
const close=async()=>{server.stop(true);await fixture.close();process.exit(0);};
process.on('SIGTERM',()=>void close());process.on('SIGINT',()=>void close());
