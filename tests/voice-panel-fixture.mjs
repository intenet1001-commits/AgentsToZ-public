const built=await Bun.build({entrypoints:['tests/fixtures/voice/panel.tsx'],target:'browser',format:'esm',define:{'process.env.NODE_ENV':'"production"'}});
if(!built.success)throw Error(built.logs.join('\n'));
const js=built.outputs.find(o=>o.path.endsWith('.js')),css=built.outputs.find(o=>o.path.endsWith('.css'));
const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:r=>{const path=new URL(r.url).pathname;return path==='/panel.js'?new Response(js,{headers:{'Content-Type':'text/javascript'}}):path==='/panel.css'?new Response(css,{headers:{'Content-Type':'text/css'}}):new Response('<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/panel.css"><div id="root"></div><script type="module" src="/panel.js"></script>',{headers:{'Content-Type':'text/html'}});}});
console.log('Voice UI fixture http://127.0.0.1:'+server.port);
