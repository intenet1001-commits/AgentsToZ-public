import {expect,test} from 'bun:test';
import {decodeNativeTesterResult,decodeTesterResult} from '../src/testerAgentClient';

test('native Agent Runtime proxy unwraps its HTTP envelope before reading tester status',()=>{
  const body={success:true,status:{installation:'ready',profiles:[{id:'quick'}]}};
  expect(decodeNativeTesterResult({status:200,body}).status?.installation).toBe('ready');
  expect(Object.is(decodeTesterResult(body),body)).toBe(true);
});
test('native error preserves the server rejection needed to replace a stale request ID',()=>{
  try{decodeNativeTesterResult({status:409,body:{success:false,code:'TESTER_CONFIG_CHANGED',error:'설정 변경'}});throw Error('Expected rejection');}
  catch(e:any){expect(e.message).toBe('설정 변경');expect(e.code).toBe('TESTER_CONFIG_CHANGED');expect(e.serverRejected).toBe(true);}
});
test('invalid native transport response stays uncertain and is never treated as server rejection',()=>{
  for(const raw of [null,[],{success:true}, {status:'200',body:{success:true}},{status:0,body:{success:true}},{status:200,body:{success:true},extra:1}]){
    try{decodeNativeTesterResult(raw);throw Error('Expected invalid response');}catch(e:any){expect(e.message).toContain('네이티브');expect(e.serverRejected).toBeUndefined();}
  }
});
