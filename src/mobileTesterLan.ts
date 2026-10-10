import type {MobileWorkspaceRequest,MobileWorkspaceResult} from './mobileWorkspaceProtocol';
import type {MobileTesterResult} from './mobileTesterProtocol';

/** Self-contained DOM adapter serialized into the existing LAN page, no new asset route. */
export function mountLanTester(root:HTMLElement,sendWire:(r:MobileWorkspaceRequest)=>Promise<MobileWorkspaceResult>,context:()=>{online:boolean;owner:string;supported:boolean;projects:{controlId:string;name:string}[]}){
  const labels:Record<string,string>={queued:'검사 대기',starting:'검사 준비 중',running:'검사 중',canceling:'취소 확인 중','recovery-required':'Mac에서 결과 확인 필요',passed:'선택한 검사 통과',failed:'검사 실패',blocked:'실행 조건 확인 필요',interrupted:'검사 중단',skipped:'생략'};
  const active=(s:string)=>['queued','starting','running','canceling'].includes(s);
  const uuid=()=>{const b=crypto.getRandomValues(new Uint8Array(16));b[6]=(b[6]!&15)|64;b[8]=(b[8]!&63)|128;const h=Array.from(b,x=>x.toString(16).padStart(2,'0')).join('');return h.slice(0,8)+'-'+h.slice(8,12)+'-'+h.slice(12,16)+'-'+h.slice(16,20)+'-'+h.slice(20);};
  let target='',owner='',online=false,supported=false,generation=0,busy=false;
  let data:MobileTesterResult|null=null,pending:MobileWorkspaceRequest['workspace']|null=null,timer:ReturnType<typeof setTimeout>|undefined;
  const element=<K extends keyof HTMLElementTagNameMap>(tag:K,text='')=>{const e=document.createElement(tag);e.textContent=text;return e;};
  const title=element('h2','프로젝트 테스터'),message=element('p'),select=element('select'),profile=element('select'),result=element('div'),error=element('p');
  select.setAttribute('aria-label','테스터 프로젝트');profile.setAttribute('aria-label','모바일 검사 범위');error.setAttribute('role','alert');result.setAttribute('role','status');
  const refresh=element('button','테스트 상태 새로고침'),start=element('button','테스트 실행'),cancel=element('button','이 검사 취소');
  const reset=element('button','이전 요청 보류 해제·설정 다시 확인');
  root.append(title,message,select,profile,start,refresh,cancel,reset,error,result);
  function render(){
    root.hidden=false;
    message.textContent=!online?'Mac에 연결하면 검사와 결과를 확인합니다.':!supported?'이 Mac 앱을 업데이트하면 모바일에서 테스트할 수 있습니다.':'Mac에서 준비한 검사를 실행합니다. 통신이 끊겨도 접수한 검사는 계속됩니다. 상세 로그와 AI 개선은 Mac에서 확인하세요.';
    const usable=online&&supported&&!!target;
    profile.hidden=data?.installation!=='ready';
    profile.disabled=busy||!!pending||!!data?.run&&active(data.run.state);
    select.disabled=busy;refresh.disabled=!usable||busy;
    start.hidden=!usable||data?.installation!=='ready';
    start.textContent=pending?'같은 검사 요청 확인':'테스트 실행';
    start.disabled=busy||!data?.canRun||!data.environmentReady||!profile.value||!!data.run&&active(data.run.state);
    cancel.hidden=!usable||!data?.run||!active(data.run.state)||!data.canCancel;cancel.disabled=busy;
    reset.hidden=!pending||busy||!!data?.run&&active(data.run.state);
    result.replaceChildren();
    if(!usable||!data)return;
    if(data.installation&&data.installation!=='ready')result.append(element('p','Mac의 프로젝트 → 테스터 에이전트에서 검사 설정과 Python을 준비하세요.'));
    if(!data.canRun)result.append(element('p','조회만 허용됐습니다. Mac 워크룸의 기기 권한에서 테스트 실행을 허용하세요.'));
    if(data.run){const r=data.run;result.append(element('strong',labels[r.state]??'검사 상태 확인 필요'),element('p',r.profileId+' · '+new Date(r.createdAt).toLocaleString()),element('p','실행 ID: '+r.id));
      if(data.freshness==='source-changed'||r.sourceUnchanged===false)result.append(element('p','검사 기준 이후 코드가 변경됐습니다. 다시 검사하세요.'));
      for(const c of r.checks.slice(0,12))result.append(element('p',c.id+' · '+(labels[c.state]??'확인 필요')));
      if(r.checkCount>r.checks.length)result.append(element('p','검사 '+r.checkCount+'개 중 '+r.checks.length+'개 표시'));
    }
  }
  async function send(workspace:MobileWorkspaceRequest['workspace']){
    if(busy||!online||!supported||!target)return;
    const mine=generation;busy=true;error.textContent='';render();let completed=false;
    try{
      const response=await sendWire({operation:'workspace',targetId:target,requestId:uuid(),workspace});
      if(mine!==generation)return;
      if(response.kind!=='workspace'||response.action!==workspace.action||!response.tester)throw Error('테스터 응답을 확인하지 못했습니다.');
      const next=response.tester;data=workspace.action==='tester.status'?next:{...data,...next};
      if(next.profiles){const selected=profile.value;profile.replaceChildren();for(const p of next.profiles)profile.add(new Option(p.id==='quick'?'빠른 검사':p.id,p.id));profile.value=next.profiles.some(p=>p.id===selected)?selected:next.defaultProfile??next.profiles[0]?.id??'';}
      if(workspace.action==='tester.start')pending=null;
      completed=workspace.action==='tester.read'&&!!data.run&&!active(data.run.state);
    }catch(e){if(mine===generation)error.textContent=(e instanceof Error?e.message:'검사 응답 확인 필요')+(pending?' · 전달됐을 수 있으므로 같은 요청으로 확인하세요.':'');}
    finally{if(mine===generation){busy=false;render();schedule();if(completed)void send({action:'tester.status'});}}
  }
  function schedule(){clearTimeout(timer);if(online&&supported&&data?.run&&active(data.run.state))timer=setTimeout(()=>{if(!document.hidden&&document.body.dataset.workspaceTab!=='workroom')void send({action:'tester.read',runId:data!.run!.id});else schedule();},3000);}
  select.onchange=()=>{target=select.value;generation++;busy=false;data=null;pending=null;error.textContent='';render();void send({action:'tester.status'});};
  refresh.onclick=()=>void send({action:'tester.status'});
  start.onclick=()=>{pending??={action:'tester.start',profileId:profile.value,revisionHash:data?.revision,testRequestId:'test_'+Date.now()+'_'+uuid()};void send(pending);};
  cancel.onclick=()=>{if(data?.run)void send({action:'tester.cancel',runId:data.run.id});};
  reset.onclick=()=>{pending=null;void send({action:'tester.status'});};
  return {update(){
    const c=context(),changed=c.owner!==owner||c.online!==online||c.supported!==supported;
    if(c.owner!==owner){target='';pending=null;}
    owner=c.owner;online=c.online;supported=c.supported;
    select.replaceChildren(new Option('검사할 프로젝트 선택',''));
    for(const p of c.projects)select.add(new Option(p.name,p.controlId));
    if(target&&!c.projects.some(p=>p.controlId===target)){target='';pending=null;}
    select.value=target;
    if(changed){generation++;busy=false;data=null;error.textContent='';clearTimeout(timer);}
    render();if(changed&&online&&target)void send({action:'tester.status'});
  }};
}
