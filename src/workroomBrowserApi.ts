import {classifyWorkroomBrowserError} from './workroomBrowserErrorCodes';
import type {WorkroomBrowserHost} from './workroomBrowserHost';
export async function handleWorkroomBrowser(req:Request,host:WorkroomBrowserHost,agent=false):Promise<Response>{
 const headers={'Cache-Control':'private, no-store','Content-Type':'application/json'};
 try{
  if(req.method!=='POST'||new URL(req.url).search||req.headers.get('content-type')?.split(';')[0]!=='application/json'||agent&&req.headers.has('origin'))throw new Error('Local JSON POST required.');
  const reader=req.body?.getReader();if(!reader)throw new Error('Request required.');const parts:Uint8Array[]=[];let bytes=0;
  try{while(true){const r=await reader.read();if(r.done)break;bytes+=r.value.length;if(bytes>32000){await reader.cancel();throw new Error('Browser request too large.');}parts.push(r.value);}}finally{reader.releaseLock();}
  const body=JSON.parse(Buffer.concat(parts).toString('utf8'));
  const result=agent?await host.agent({...body,grant:req.headers.get('x-agentstoz-browser-grant')}):await host.perform(body);
  // An agent answer may carry one bounded screenshot next to its bounded observation.
  const encoded=JSON.stringify(result);if(Buffer.byteLength(encoded)>(agent?1024*1024:512*1024))throw new Error('Browser response too large.');return new Response(encoded,{headers});
 }catch(e){return Response.json({success:false,code:classifyWorkroomBrowserError(e),error:e instanceof Error?e.message:'Browser operation failed.'},{status:400,headers});}
}
