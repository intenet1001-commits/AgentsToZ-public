import {timingSafeEqual} from 'node:crypto';
import {inputBody} from './onboardingProgressHttp';
import {ONBOARDING_EXECUTION_HEADER} from './onboardingGithub';
import type {MacSetupHost} from './macSetupHost';
export async function handleMacSetup(req:Request,capability:string|null,host:()=>MacSetupHost){
  const json=(body:unknown,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'no-store','Connection':'close'}});
  const received=req.headers.get(ONBOARDING_EXECUTION_HEADER),url=new URL(req.url);
  if(req.headers.has('origin')||!/^[0-9a-f]{64}$/.test(capability??'')||!/^[0-9a-f]{64}$/.test(received??'')||!timingSafeEqual(Buffer.from(capability!,'hex'),Buffer.from(received!,'hex')))return json({error:'설치 앱에서 준비를 시작하세요.'},403);
  if(req.method!=='POST'||url.pathname!=='/api/onboarding/mac-setup'||url.search)return json({error:'허용되지 않은 요청입니다.'},405);
  try{
    const body=await inputBody(req);
    if(body.operation==='status'&&Object.keys(body).length===1)return json({success:true,...host().status()});
    if(Object.keys(body).some(k=>!['operation','expectedRevision','requestId','selected'].includes(k)))throw Error();
    return json({success:true,...await host().act(body)});
  }catch{return json({error:'준비 상태를 다시 읽고 이어가세요. 진행 중인 설치를 반복하지 않았습니다.'},409);}
}
