import {expect,test} from 'bun:test';

test('shared Edge Functions keep authenticated upstream reads working when legacy API keys are retired',async()=>{
  const globals=globalThis as any,oldDeno=globals.Deno,oldFetch=globalThis.fetch;
  const modern='sb_secret_rotation_fixture',legacy='legacy_key_that_must_not_be_used';
  try{
    for(const slug of ['project-memory-feed','what-i-said-feed','submit-voc']){
      let handler:(request:Request)=>Promise<Response>,reads=0;
      globals.Deno={env:{get:(name:string)=>({SUPABASE_URL:'https://example.supabase.co',SUPABASE_SERVICE_ROLE_KEY:legacy,PORTMGR_SERVICE_SECRET_KEY:modern})[name]},serve:(value:typeof handler)=>{handler=value;}};
      globalThis.fetch=(async(_url:any,init:RequestInit)=>{
        reads++;const headers=new Headers(init.headers);
        expect(headers.get('apikey')).toBe(modern);
        expect(headers.get('Authorization')).toBe(`Bearer ${modern}`);
        return Response.json(slug==='submit-voc'?[{blocked:false}]:[]);
      }) as typeof fetch;
      await import(`../supabase/functions/${slug}/index.ts?legacy-key-retirement`);
      const request=slug==='submit-voc'
        ?new Request('https://example.invalid/function',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({installationId:'10000000-0000-4000-8000-000000000001',action:'check'})})
        :new Request('https://example.invalid/function',{headers:{Authorization:`Bearer ${'a'.repeat(64)}`}});
      const response=await handler!(request);
      expect(response.status).toBe(200);expect(reads).toBe(1);
      const body=await response.text();expect(body).not.toContain(modern);expect(body).not.toContain(legacy);
    }
  }finally{globalThis.fetch=oldFetch;if(oldDeno===undefined)delete globals.Deno;else globals.Deno=oldDeno;}
});
