import {timingSafeEqual,createHmac} from 'node:crypto';
import {inputBody} from './onboardingProgressHttp';
import {ONBOARDING_EXECUTION_HEADER,ONBOARDING_EXECUTION_PATH,ONBOARDING_PROOF_DOMAIN} from './onboardingGithub';
export function onboardingHealthProof(capability:string|null,nonce:string|null):string|null{
 if(!/^[0-9a-f]{64}$/.test(capability??'')||!/^[0-9a-f]{64}$/.test(nonce??''))return null;
 return createHmac('sha256',Buffer.from(capability!,'hex')).update(ONBOARDING_PROOF_DOMAIN).update(Buffer.from(nonce!,'hex')).digest('hex');
}
export async function handleGithubSetup(req:Request,capability:string|null,host:()=>{status():object;act(operation:string,expected:string):Promise<object>},tool:'github'|'codex'|'codex-login'='github'):Promise<Response>{
 const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store','Connection':'close'}});
 const received=req.headers.get(ONBOARDING_EXECUTION_HEADER);
 // Exact Tauri proxy only; no source-mode bypass, remote scope reuse or browser Origin.
 if(req.headers.has('origin')||!/^[0-9a-f]{64}$/.test(capability??'')||!/^[0-9a-f]{64}$/.test(received??'')||!timingSafeEqual(Buffer.from(received!,'hex'),Buffer.from(capability!,'hex')))return json({error:'설치 앱의 보안 연결이 필요합니다.'},403);
 const url=new URL(req.url);
 const path=tool==='github'?ONBOARDING_EXECUTION_PATH:`/api/onboarding/${tool}`;
 if(url.pathname!==path||url.search||req.method!=='POST')return json({error:'허용되지 않은 요청입니다.'},405);
 try{
  const body=await inputBody(req);
  const keys=Object.keys(body).sort().join(',');
  if(body.operation==='status'&&keys==='operation')return json({success:true,...host().status()});
  if(keys!=='expectedRevision,operation'||typeof body.expectedRevision!=='string'||body.expectedRevision.length>36
   ||typeof body.operation!=='string'||!(tool==='codex'?['review','install','check','cancel']:tool==='codex-login'?['review','check','login','cancel','open-login']:['review','install','check','login','cancel','open-login']).includes(body.operation))return json({error:'요청을 확인하지 못했습니다.'},400);
  return json({success:true,...await host().act(body.operation,body.expectedRevision)});
 }catch{
  // No raw subprocess/file/network exception crosses the native boundary.
  return json({error:'작업 상태를 확인하지 못했습니다. 다시 읽고 이전 결과부터 확인해 주세요.'},409);
 }
}
