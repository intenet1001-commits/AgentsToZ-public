import {afterEach,expect,test} from 'bun:test';
import {mkdtempSync,rmSync,readFileSync,statSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {saveOnboardingCloudConfiguration,type CloudConfigurationDependencies} from '../src/onboardingCloudConfiguration';
import {serviceRoleKeyPath} from '../server-supabase-service';
import type {CloudJob} from '../src/onboardingCloudHost';
const dirs:string[]=[];afterEach(()=>dirs.splice(0).forEach(p=>rmSync(p,{recursive:true,force:true})));
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'atz-cloud-config-'));dirs.push(dir);const registrations:any[]=[];let current:Record<string,any>={items:[{id:'bookmark'}],categories:['개발'],localOnlyDeletedPortIds:['keep']},key:string|null=null,authorized=true,failWrite=false;
 const job={id:crypto.randomUUID(),ref:'a'.repeat(20)} as CloudJob,value={ref:job.ref!,publicKey:'sb_publishable_fixture',serviceKey:'sb_secret_fixture',email:'owner@example.test'};
 const deps:CloudConfigurationDependencies={appDirectory:dir,deviceName:'새 Mac',withLock:async work=>work(),read:()=>current,serviceKey:()=>key,guard:v=>v,assertAccount:()=>{if(!authorized)throw Error('계정 변경');},write:next=>{if(failWrite)throw Error('disk failed');current=next;},fetch:(async(url,init)=>{expect(String(url)).toBe('https://'+'a'.repeat(20)+'.supabase.co/rest/v1/portmgr_devices?on_conflict=id');registrations.push(JSON.parse(String(init?.body)));return new Response(null,{status:201});}) as typeof fetch};
 return {deps,job,value,registrations,current:()=>current,setCurrent:(v:any)=>{current=v;},setKey:(v:string)=>{key=v;},revoke:()=>{authorized=false;},failWrite:(v:boolean)=>{failWrite=v;},dir};
}
test('fresh completion stores secrets only in a private file and registers one stable installation on retry',async()=>{
 const f=fixture(),signal=new AbortController().signal;await saveOnboardingCloudConfiguration(f.deps,f.value,f.job,signal);await saveOnboardingCloudConfiguration(f.deps,f.value,f.job,signal);
 expect(f.registrations).toHaveLength(2);expect(f.registrations[0].id).toBe(f.registrations[1].id);expect(f.registrations[0].id).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-8[a-f0-9]{3}-[a-f0-9]{12}$/);
 expect(f.current()).toMatchObject({items:[{id:'bookmark'}],categories:['개발'],localOnlyDeletedPortIds:['keep'],supabaseAnonKey:f.value.publicKey,pendingDeviceRegistration:false});expect(JSON.stringify(f.current())).not.toContain(f.value.serviceKey);
 const path=serviceRoleKeyPath(f.dir);expect(statSync(path).mode&0o777).toBe(0o600);expect(JSON.parse(readFileSync(path,'utf8')).serviceRoleKey).toBe(f.value.serviceKey);
});
test('an existing connection or administrator key is never overwritten or registered elsewhere',async()=>{
 for(const kind of ['connection','key']){const f=fixture();if(kind==='connection')f.setCurrent({supabaseUrl:'https://existing.supabase.co'});else f.setKey('existing-secret');await expect(saveOnboardingCloudConfiguration(f.deps,f.value,f.job,new AbortController().signal)).rejects.toThrow('기존');expect(f.registrations).toEqual([]);expect(existsSync(serviceRoleKeyPath(f.dir))).toBe(false);}
});
test('revocation or a new administrator key during registration prevents local credential/config writes',async()=>{
 for(const kind of ['revoke','key']){const f=fixture();const original=f.deps.fetch!;f.deps.fetch=(async(...args:Parameters<typeof fetch>)=>{const result=await original(...args);if(kind==='revoke')f.revoke();else f.setKey('concurrent-key');return result;}) as typeof fetch;
  await expect(saveOnboardingCloudConfiguration(f.deps,f.value,f.job,new AbortController().signal)).rejects.toThrow();expect(existsSync(serviceRoleKeyPath(f.dir))).toBe(false);expect(f.current()).not.toHaveProperty('supabaseUrl');}
});
test('a failed local config commit can resume with the same registration identity and no secret response',async()=>{
 const f=fixture(),signal=new AbortController().signal;f.failWrite(true);await expect(saveOnboardingCloudConfiguration(f.deps,f.value,f.job,signal)).rejects.toThrow('disk');expect(f.current()).not.toHaveProperty('supabaseUrl');
 f.failWrite(false);await saveOnboardingCloudConfiguration(f.deps,f.value,f.job,signal);expect(f.registrations[0].id).toBe(f.registrations[1].id);expect(f.current().supabaseUrl).toBe('https://'+'a'.repeat(20)+'.supabase.co');
});
