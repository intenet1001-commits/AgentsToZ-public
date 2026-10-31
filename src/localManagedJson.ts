/** Small local management requests. Call only after checking the route's own capability and origin. */
export async function localManagedJson(request:Request,maxBytes=16000):Promise<unknown>{
  const url=new URL(request.url);
  if(request.method!=='POST'||url.search||url.href.includes('?')||request.headers.get('content-type')?.split(';')[0]?.trim()!=='application/json')throw Error('로컬 JSON POST만 허용합니다.');
  const reader=request.body?.getReader();if(!reader)throw Error('JSON 요청이 필요합니다.');
  const chunks:Uint8Array[]=[];let length=0;const until=Date.now()+5000;
  try{while(true){
    const remaining=until-Date.now();if(remaining<=0)throw Error('요청 시간이 초과됐습니다.');
    let timer:ReturnType<typeof setTimeout>|undefined;
    const row=await Promise.race([reader.read(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('요청 시간이 초과됐습니다.')),remaining);timer.unref?.();})]).finally(()=>{if(timer)clearTimeout(timer);});
    if(row.done)break;length+=row.value.length;if(length>maxBytes)throw Error('요청 크기를 줄여 주세요.');chunks.push(row.value);
  }return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
  }catch(e){void reader.cancel().catch(()=>{});throw e;}finally{reader.releaseLock();}
}
