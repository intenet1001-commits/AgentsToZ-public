import {afterAll, beforeAll, describe, expect, test} from 'bun:test';
import {createServer, type Server} from 'node:http';
import {BrowserContextHost} from '../src/browserContextHost';
import {fetchBrowserDocument,isPublicBrowserIpv4,readBrowserContextRequest,resolveBrowserUrl} from '../src/browserContextPolicy';

let server:Server,port:number,host:BrowserContextHost;let sideRequests=0;
beforeAll(async()=>{
 server=createServer((req,res)=>{if(req.url!=='/'){sideRequests++;res.writeHead(200,{'Content-Type':'text/html'});res.end('unexpected');return;}res.writeHead(200,{'Content-Type':'text/html'});res.end('<html><head><title>Fixture title</title></head><body><h1>Safe visible fixture</h1><form><label>Secret<input value="TOPSECRET"></label></form><div contenteditable>PRIVATE EDIT</div><script>document.body.innerText="SCRIPT RAN";fetch("/script")</script><img src="/image"><iframe src="/frame"></iframe><a href="https://example.com/">Reference</a><a href="https://example.com/?token=secret">Credential link</a></body></html>');});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));port=(server.address() as {port:number}).port;
 host=new BrowserContextHost({packaged:false,registeredPorts:async()=>[port]});
});
afterAll(async()=>{await host.dispose();await new Promise<void>(resolve=>server.close(()=>resolve()));});

describe('bounded isolated browser host',()=>{
 test('URL and DNS policy blocks private, encoded loopback, credentials and redirects inputs',async()=>{
  for(const raw of ['file:///etc/passwd','http://2130706433/','http://127.1/','http://127.0.0.1:3001/','http://169.254.169.254/','http://[::1]/','https://user:pass@example.com/','https://example.com/?token=a','https://example.com/#a'])await expect(resolveBrowserUrl(raw,[])).rejects.toThrow();
  await expect(resolveBrowserUrl('https://example.com/',[],async()=>['8.8.8.8','10.0.0.1'])).rejects.toThrow();
  expect((await resolveBrowserUrl('https://example.com/',[],async()=>['8.8.8.8'])).address).toBe('8.8.8.8');
  for(const ip of ['0.0.0.0','100.64.0.1','192.168.0.1','198.18.0.1','224.0.0.1','::ffff:8.8.8.8'])expect(isPublicBrowserIpv4(ip)).toBe(false);
 });
 test('transport actually pins lookup instead of resolving the original hostname again',async()=>{
  const html=await fetchBrowserDocument({url:new URL(`http://does-not-resolve.invalid:${port}/`),address:'127.0.0.1'});
  expect(html).toContain('Safe visible fixture');
 });
 test('packaged status is honestly unavailable without installing anything',async()=>{
  const unavailable=new BrowserContextHost({packaged:true,registeredPorts:async()=>[]});
  const status=await unavailable.perform({operation:'status'});expect(status.available).toBe(false);expect(status.sessions).toEqual([]);
 });
 test('rejects unknown caller power and bounds input',async()=>{
  await expect(host.perform({operation:'status',cdp:'localhost'})).rejects.toThrow();
  await expect(readBrowserContextRequest(new Request('http://localhost',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({x:'a'.repeat(5000)})}))).rejects.toThrow();
 });
 test('real Chromium reads safe document, suppresses scripts/subresources/form values and closes',async()=>{
  const status=await host.perform({operation:'status'});expect(status.available).toBe(true);
  const opened=await host.perform({operation:'open',url:`http://127.0.0.1:${port}/`});
  const session=opened.session as {sessionId:string};expect(session.sessionId).toBeTruthy();
  const read=await host.perform({operation:'read',sessionId:session.sessionId,screenshot:true});
  const snapshot=read.snapshot as {title:string;text:string;links:unknown[];screenshotDataUrl:string};
  expect(snapshot.title).toBe('Fixture title');expect(snapshot.text).toContain('Safe visible fixture');
  expect(JSON.stringify(snapshot)).not.toContain('TOPSECRET');expect(snapshot.text).not.toContain('PRIVATE EDIT');expect(snapshot.text).not.toContain('SCRIPT RAN');
  expect(snapshot.links).toHaveLength(1);expect(snapshot.screenshotDataUrl).toStartWith('data:image/jpeg;base64,');expect(sideRequests).toBe(0);
  const second=await host.perform({operation:'open',url:`http://127.0.0.1:${port}/`});
  await expect(host.perform({operation:'open',url:`http://127.0.0.1:${port}/`})).rejects.toThrow('세션 한도');
  await host.perform({operation:'close',sessionId:(second.session as {sessionId:string}).sessionId});
  expect(await host.perform({operation:'close',sessionId:session.sessionId})).toEqual({success:true});
  await expect(host.perform({operation:'read',sessionId:session.sessionId})).rejects.toThrow();
 },20000);
});

test('request body deadline cancels a stalled stream',async()=>{
 let cancelled=false;
 const body=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new TextEncoder().encode('{'));},cancel(){cancelled=true;}});
 const request=new Request('http://localhost',{method:'POST',headers:{'Content-Type':'application/json'},body});
 const started=Date.now();
 await expect(readBrowserContextRequest(request)).rejects.toThrow('수신 시간이');
 expect(cancelled).toBe(true);expect(Date.now()-started).toBeLessThan(3000);
},4000);

test('shutdown cancels and waits for an opening document; no new session can publish',async()=>{
 let arrived!:()=>void;const arrival=new Promise<void>(resolve=>{arrived=resolve;});
 const slow=createServer((_req,res)=>{res.writeHead(200,{'Content-Type':'text/html'});res.write('<html><body>');arrived();});
 await new Promise<void>(resolve=>slow.listen(0,'127.0.0.1',resolve));
 const slowPort=(slow.address() as {port:number}).port;
 const own=new BrowserContextHost({packaged:false,registeredPorts:async()=>[slowPort]});
 const pending=own.perform({operation:'open',url:`http://127.0.0.1:${slowPort}/`});
 // Attach the error observer before aborting, so the intentionally cancelled operation is owned.
 const result=pending.then(()=>false,()=>true);
 await arrival;
 await expect(own.perform({operation:'open',url:`http://127.0.0.1:${slowPort}/`})).rejects.toThrow('작업 중');
 await own.dispose();expect(await result).toBe(true);
 await expect(own.perform({operation:'status'})).rejects.toThrow('종료 중');
 slow.closeAllConnections();await new Promise<void>(resolve=>slow.close(()=>resolve()));
},5000);

test('document absolute deadline stops a slow-drip response despite activity',async()=>{
 let writes=0;
 const drip=createServer((_req,res)=>{res.writeHead(200,{'Content-Type':'text/html'});res.write('<html>');const timer=setInterval(()=>{writes++;res.write('a');},50);res.once('close',()=>clearInterval(timer));});
 await new Promise<void>(resolve=>drip.listen(0,'127.0.0.1',resolve));
 const dripPort=(drip.address() as {port:number}).port;
 const started=Date.now();
 await expect(fetchBrowserDocument({url:new URL(`http://127.0.0.1:${dripPort}/`),address:'127.0.0.1'})).rejects.toThrow();
 expect(writes).toBeGreaterThan(1);expect(Date.now()-started).toBeLessThan(11500);
 drip.closeAllConnections();await new Promise<void>(resolve=>drip.close(()=>resolve()));
},12500);

test('one aggregate opening deadline aborts a slow page without publishing a late session',async()=>{
 const delayed=createServer((_req,res)=>{res.writeHead(200,{'Content-Type':'text/html'});res.write('<html><body>');});
 await new Promise<void>(resolve=>delayed.listen(0,'127.0.0.1',resolve));const delayedPort=(delayed.address() as {port:number}).port;
 const own=new BrowserContextHost({packaged:false,registeredPorts:async()=>[delayedPort],openTimeoutMs:200});
 const started=Date.now();await expect(own.perform({operation:'open',url:`http://127.0.0.1:${delayedPort}/`})).rejects.toThrow();
 expect(Date.now()-started).toBeLessThan(1200);expect((await own.perform({operation:'status'})).sessions).toEqual([]);
 await own.dispose();delayed.closeAllConnections();await new Promise<void>(resolve=>delayed.close(()=>resolve()));
},2000);

test('read deadline closes only its session and retains unsettled read admission',async()=>{
 const own=new BrowserContextHost({packaged:false,registeredPorts:async()=>[port],readTimeoutMs:80});
 const first=await own.perform({operation:'open',url:`http://127.0.0.1:${port}/`});
 const second=await own.perform({operation:'open',url:`http://127.0.0.1:${port}/`});
 const id=(first.session as {sessionId:string}).sessionId,other=(second.session as {sessionId:string}).sessionId;
 type InspectedSession={page:import('playwright').Page;context:import('playwright').BrowserContext;busy:boolean};
 const state=own as unknown as {sessions:Map<string,InspectedSession>;reads:Map<string,Promise<void>>};
 const session=state.sessions.get(id)!;let rejectEvaluation!:(error:Error)=>void;
 session.page.evaluate=()=>new Promise<never>((_,reject)=>{rejectEvaluation=reject;});
 await expect(own.perform({operation:'read',sessionId:id,screenshot:false})).rejects.toThrow('읽기 시간이');
 expect(session.busy).toBe(true);expect(state.reads.has(id)).toBe(true);
 expect(state.sessions.has(id)).toBe(false);expect(state.sessions.has(other)).toBe(true);
 await expect(own.perform({operation:'open',url:`http://127.0.0.1:${port}/`})).rejects.toThrow('세션 한도');
 const settled=state.reads.get(id)!;rejectEvaluation(new Error('controlled renderer settlement'));await settled;
 expect(state.reads.has(id)).toBe(false);expect(session.busy).toBe(false);
 await own.dispose();
},12000);

test('closing contexts retain quota and duplicate close joins the same actual cleanup',async()=>{
 const own=new BrowserContextHost({packaged:false,registeredPorts:async()=>[port]});
 const one=await own.perform({operation:'open',url:`http://127.0.0.1:${port}/`});
 await own.perform({operation:'open',url:`http://127.0.0.1:${port}/`});
 const id=(one.session as {sessionId:string}).sessionId;
 const state=own as unknown as {sessions:Map<string,{context:import('playwright').BrowserContext}>;closing:Map<string,Promise<void>>};
 const context=state.sessions.get(id)!.context,actualClose=context.close.bind(context);
 let release!:()=>void,calls=0;const deferred=new Promise<void>(resolve=>{release=resolve;});
 context.close=async()=>{calls++;await deferred;await actualClose();};
 const first=own.perform({operation:'close',sessionId:id});
 const second=own.perform({operation:'close',sessionId:id});
 expect(state.closing.has(id)).toBe(true);expect(calls).toBe(1);
 await expect(own.perform({operation:'open',url:`http://127.0.0.1:${port}/`})).rejects.toThrow('세션 한도');
 release();await Promise.all([first,second]);expect(state.closing.has(id)).toBe(false);expect(calls).toBe(1);
 await own.dispose();
},12000);
