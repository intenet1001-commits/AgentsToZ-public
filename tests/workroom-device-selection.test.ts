import {expect,test} from 'bun:test';
import {WORKROOM_DEVICE_EVENT,requestWorkroomDevice,workroomDeviceRequest} from '../src/workroomDeviceSelection';

/**
 * ⚠️ 브라우저 전역을 **테스트 안에서만** 세우고 즉시 되돌린다. 예전에는 모듈 수준에서 세웠는데,
 * `bun test`는 파일들을 한 프로세스에서 돌리므로 `window`가 살아남아 다른 파일(PGlite·에이전트
 * 런타임)이 자기를 브라우저로 착각해 5건이 실패했다 — 단독 실행만으로는 안 보이는 오염이다.
 */
function withBrowser<T>(run:()=>T):T{
  const scope=globalThis as Record<string,unknown>;
  const had={window:'window'in scope,storage:'sessionStorage'in scope,event:'CustomEvent'in scope};
  const prior={window:scope.window,storage:scope.sessionStorage,event:scope.CustomEvent};
  const listeners=new Map<string,Set<(event:{type:string;detail:unknown})=>void>>();
  const store=new Map<string,string>();
  scope.CustomEvent=class{type:string;detail:unknown;constructor(type:string,init?:{detail?:unknown}){this.type=type;this.detail=init?.detail;}};
  scope.window={
    addEventListener:(type:string,listener:any)=>{listeners.set(type,(listeners.get(type)??new Set()).add(listener));},
    removeEventListener:(type:string,listener:any)=>{listeners.get(type)?.delete(listener);},
    dispatchEvent:(event:{type:string})=>{for(const listener of listeners.get(event.type)??[])listener(event as any);return true;},
  };
  scope.sessionStorage={
    getItem:(key:string)=>store.has(key)?store.get(key)!:null,
    setItem:(key:string,value:string)=>{store.set(key,value);},
    removeItem:(key:string)=>{store.delete(key);},
  };
  try{return run();}
  finally{
    for(const [key,present,value] of [['window',had.window,prior.window],['sessionStorage',had.storage,prior.storage],['CustomEvent',had.event,prior.event]] as const)
      if(present)scope[key]=value;else delete scope[key];
  }
}

test('the dock hands the chosen device to the Workroom screen',()=>{
  withBrowser(()=>{
    const seen:unknown[]=[];
    const listener=(event:{detail:unknown})=>{seen.push(event.detail);};
    (globalThis as any).window.addEventListener(WORKROOM_DEVICE_EVENT,listener);
    const first=requestWorkroomDevice('endpoint-1',{ops:true});
    const second=requestWorkroomDevice('endpoint-1',{ops:true});
    // 같은 기기를 다시 눌러도 전달된다 — 일련번호가 다르다.
    expect(second.nonce).toBeGreaterThan(first.nonce);
    expect((globalThis as any).sessionStorage.getItem('agentstoz-workroom-device')).toBe('endpoint-1');
    // 「이 기기」로 돌아오면 저장을 지운다(다음 창 열기에 남의 기기가 묻어 오지 않게).
    requestWorkroomDevice('');
    expect((globalThis as any).sessionStorage.getItem('agentstoz-workroom-device')).toBeNull();
    expect(seen.map(detail=>workroomDeviceRequest(detail)?.device)).toEqual(['endpoint-1','endpoint-1','']);
    expect(workroomDeviceRequest(seen[0])?.ops).toBe(true);
    expect(workroomDeviceRequest(seen[2])?.ops).toBe(false);
  });
  // 전역을 되돌렸는지 — 이게 깨지면 다른 테스트 파일이 조용히 망가진다.
  expect('window' in (globalThis as Record<string,unknown>)).toBe(false);
});

test('a malformed request is ignored — this event is open to the whole window',()=>{
  for(const bad of [null,undefined,'endpoint',{device:1,nonce:1},{device:'a'},{nonce:1},{device:'x'.repeat(201),nonce:1}])
    expect(workroomDeviceRequest(bad)).toBeNull();
});
