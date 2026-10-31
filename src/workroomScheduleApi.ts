import {localManagedJson} from './localManagedJson';
import type {WorkroomScheduleHost} from './workroomScheduleHost';
export async function handleWorkroomSchedules(request:Request,host:WorkroomScheduleHost,authorized:boolean){
  const headers={'Cache-Control':'private, no-store'};
  if(!authorized)return Response.json({success:false,error:'이 연결에서는 워크룸 예약을 관리할 수 없습니다.'},{status:403,headers});
  try{return Response.json(await host.manage(await localManagedJson(request)),{headers});}
  catch(e){return Response.json({success:false,error:e instanceof Error?e.message:'예약 상태를 확인하지 못했습니다.'},{status:400,headers});}
}
