import {invoke,isTauri} from '@tauri-apps/api/core';
import {WORKROOM_SCHEDULE_PATH,type WorkroomScheduleRequest,type WorkroomSchedule,type WorkroomScheduleRun} from './workroomScheduleProtocol';
import type {ScheduleSnapshot} from './workroomScheduleHost';
export interface WorkroomScheduleResult {success:true;enabled?:boolean;snapshot?:ScheduleSnapshot|null;problem?:string;schedules?:WorkroomSchedule[];runs?:WorkroomScheduleRun[]}
export type WorkroomScheduleRequester=(body:WorkroomScheduleRequest)=>Promise<WorkroomScheduleResult>;
export const requestWorkroomSchedule:WorkroomScheduleRequester=async body=>{
  let response:{status:number;body:Record<string,any>};
  if(isTauri())response=await invoke('agent_runtime_request',{path:WORKROOM_SCHEDULE_PATH,method:'POST',body});
  else{const r=await fetch(WORKROOM_SCHEDULE_PATH,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});response={status:r.status,body:await r.json()};}
  if(response.status<200||response.status>=300||response.body.success!==true)throw Error(response.body.error||'워크룸 예약을 확인하지 못했습니다.');
  return response.body as WorkroomScheduleResult;
};
