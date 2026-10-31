import {localManagedJson} from './localManagedJson';
import type {DesktopEffortHost} from './desktopEffortHost';
export async function handleDesktopEffort(request:Request,host:DesktopEffortHost,authorized:boolean){
  const headers={'Cache-Control':'private, no-store'};
  if(!authorized)return Response.json({success:false,error:'이 연결에서는 외부 앱 세션을 설정할 수 없습니다.'},{status:403,headers});
  try{return Response.json(await host.manage(await localManagedJson(request,8000)),{headers});}
  catch(e){return Response.json({success:false,error:e instanceof Error?e.message:'외부 앱 연결을 확인하지 못했습니다.'},{status:400,headers});}
}
