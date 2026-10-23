import { Resolver } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

export const BROWSER_CONTEXT_PATH = '/api/agent-runtime/browser-context';
export const BROWSER_CONTEXT_LIMITS = { maxSessions: 2, ttlMs: 600_000, textChars: 12_000, links: 40 } as const;
export class BrowserContextError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); }
}
const fail = () => new BrowserContextError('browser_context_url_denied', '명시한 공개 HTTP(S) URL 또는 등록된 localhost 앱 주소만 사용할 수 있습니다. 인증·검색 매개변수·리다이렉트는 지원하지 않습니다.');
export function isPublicBrowserIpv4(address: string): boolean {
  if (isIP(address) !== 4) return false;
  const [a,b,c] = address.split('.').map(Number) as [number,number,number,number];
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99)))
    || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
}
export async function resolveBrowserUrl(raw: unknown, registeredPorts: readonly number[], resolve?: (hostname:string)=>Promise<string[]>): Promise<{url: URL; address: string}> {
  if (typeof raw !== 'string' || raw.length > 2048 || raw !== raw.trim() || /[\u0000-\u0020\\]/.test(raw)) throw fail();
  let url: URL; try { url = new URL(raw); } catch { throw fail(); }
  if (/[\[\]:]/.test(url.hostname) || !['http:','https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw fail();
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
    if (!registeredPorts.includes(port) || [3001,9000,9001,1420].includes(port)) throw fail();
    return {url, address:'127.0.0.1'};
  }
  // Public targets only use normal web ports; IPv6 and all special-use addresses fail closed.
  if (![80,443].includes(port) || url.hostname.endsWith('.localhost') || url.hostname.endsWith('.local')) throw fail();
  let addresses: string[];
  const resolver=new Resolver({timeout:3000,tries:1});
  let dnsTimer:ReturnType<typeof setTimeout>|undefined;
  try { addresses = isIP(url.hostname) ? [url.hostname] : await Promise.race([(resolve??(host=>resolver.resolve4(host)))(url.hostname),new Promise<never>((_,reject)=>{dnsTimer=setTimeout(()=>{resolver.cancel();reject(fail());},3000);})]); } catch { throw fail(); } finally {if(dnsTimer)clearTimeout(dnsTimer);} 
  if (!addresses.length || addresses.some(a => !isPublicBrowserIpv4(a))) throw fail();
  return {url, address:addresses[0]!};
}
/** Single anonymous GET pinned to the validated address; no redirects, cookies, auth or ambient proxy. */
export async function fetchBrowserDocument(target: {url: URL; address: string}, signal?:AbortSignal): Promise<string> {
  const {url,address} = target;
  return new Promise((resolve,reject) => {
    const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      method:'GET', agent:false, family:4, signal, lookup:(_host,_options,callback) => callback(null,address,4),
      headers:{Accept:'text/html, text/plain;q=0.8','Accept-Encoding':'identity','User-Agent':'AgentsToZ-ReadOnlyContext/1'},
      timeout:8000,
    }, res => {
      const type = res.headers['content-type']?.split(';')[0]?.trim();
      if ((res.statusCode ?? 0) < 200 || (res.statusCode ?? 0) >= 300 || !['text/html','text/plain'].includes(type ?? '') || (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity')) {
        res.destroy(); reject(new BrowserContextError('browser_context_document_denied','HTML/텍스트 정상 응답만 읽을 수 있습니다. 리다이렉트·로그인은 지원하지 않습니다.')); return;
      }
      const chunks: Buffer[] = []; let bytes = 0;
      res.on('data',(chunk: Buffer) => {bytes += chunk.length;if(bytes > 512_000) {req.destroy(new BrowserContextError('browser_context_document_large','페이지가 수집 한도(512 KB)를 초과했습니다.'));} else chunks.push(chunk);});
      res.on('end',() => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(type === 'text/plain' ? `<html><body><pre>${text.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;')}</pre></body></html>` : text);
      });
      res.on('error',reject);
    });
    const deadline=setTimeout(()=>req.destroy(new Error('deadline')),10_000);
    req.once('close',()=>clearTimeout(deadline));
    req.on('timeout',() => req.destroy(new Error('timeout')));
    req.on('error',error => reject(error instanceof BrowserContextError ? error : new BrowserContextError('browser_context_fetch_failed','페이지에 연결하지 못했습니다. 주소와 실행 상태를 확인하세요.')));
    req.end();
  });
}
export async function readBrowserContextRequest(req: Request): Promise<Record<string,unknown>> {
  if (req.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json') throw new BrowserContextError('browser_context_invalid_request','JSON 요청만 허용합니다.',415);
  const reader = req.body?.getReader(); const chunks:Uint8Array[] = []; let size = 0;
  let bodyTimer:ReturnType<typeof setTimeout>|undefined;
  const cancel=()=>{void reader?.cancel().catch(()=>{});};
  const deadline=new Promise<never>((_,reject)=>{bodyTimer=setTimeout(()=>{reject(new BrowserContextError('browser_context_body_timeout','요청 본문 수신 시간이 초과됐습니다.',408));cancel();},2000);});
  const abort=()=>cancel();req.signal.addEventListener('abort',abort,{once:true});
  if (reader) try {while(true){const part=await Promise.race([reader.read(),deadline]);if(part.done)break;size+=part.value.byteLength;if(size>4096){await reader.cancel();throw new BrowserContextError('browser_context_request_large','요청이 너무 큽니다.',413);}chunks.push(part.value);}} finally {if(bodyTimer)clearTimeout(bodyTimer);req.signal.removeEventListener('abort',abort);reader.releaseLock();}
  if(!reader){if(bodyTimer)clearTimeout(bodyTimer);req.signal.removeEventListener('abort',abort);}
  let data:unknown;try{data=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new BrowserContextError('browser_context_invalid_request','요청 형식을 확인하세요.');}
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new BrowserContextError('browser_context_invalid_request','요청 형식을 확인하세요.');
  return data as Record<string,unknown>;
}
