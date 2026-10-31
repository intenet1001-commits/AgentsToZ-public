import {describe,expect,test} from 'bun:test';
import {COMPUTER_USE_SCOPE_MCP_TOOL,computerUseScopeMcpRequest} from '../src/computerUseScopeMcp';
import {ComputerUseMcpConnection,computerUseMcpRequest,computerUseMcpResult} from '../src/computerUseMcp';
import {AGENTSTOZ_USE_MCP_TOOLS} from '../agentstoz-use-mcp-server';
const grant='a'.repeat(64),base={grant,epoch:1},observationId='observation_1',requestId='scope_request_1';
describe('scoped computer MCP boundary',()=>{
  test('a separate tool advertises scoped consent and never accepts an AI-supplied scope or caller',()=>{
    expect(AGENTSTOZ_USE_MCP_TOOLS.some(t=>t.name===COMPUTER_USE_SCOPE_MCP_TOOL.name)).toBe(true);
    expect(COMPUTER_USE_SCOPE_MCP_TOOL.description).toContain('person explicitly approves');
    expect(COMPUTER_USE_SCOPE_MCP_TOOL.description).toContain('never replay');
    // How an AI leaves its own host app, and where a refusal names the Control check (1.73.0).
    expect(COMPUTER_USE_SCOPE_MCP_TOOL.description).toContain('leave it with focus-app to another app');
    expect(COMPUTER_USE_SCOPE_MCP_TOOL.description).toContain('guardReason');
    expect(COMPUTER_USE_SCOPE_MCP_TOOL.description).toContain('OS permission or sign-in dialog is open');
    for(const key of ['scope','caller','permissions','owner'])expect(key in COMPUTER_USE_SCOPE_MCP_TOOL.inputSchema.properties).toBe(false);
    expect(computerUseScopeMcpRequest({operation:'status'})).toEqual({operation:'scope-status'});
    expect(()=>computerUseScopeMcpRequest({operation:'status',scope:{kind:'desktop'}})).toThrow();
    expect(()=>computerUseScopeMcpRequest({operation:'observe',...base,caller:{sessionId:'foreign_session'}})).toThrow();
  });
  test('coordinate space and keyboard values keep their exact closed request shapes',()=>{
    expect(computerUseScopeMcpRequest({operation:'click',...base,observationId,requestId,displayId:'display_1',x:17.5,y:33,button:'right',clickCount:2})).toEqual({operation:'scope-click',...base,observationId,requestId,displayId:'display_1',x:17.5,y:33,button:'right',clickCount:2});
    expect(computerUseScopeMcpRequest({operation:'key',...base,observationId,requestId,key:'Enter',modifiers:['cmd']})).toMatchObject({operation:'scope-key',key:'Enter',modifiers:['cmd']});
    expect(()=>computerUseScopeMcpRequest({operation:'click',...base,observationId,requestId,displayId:'display_1',x:-2,y:3,button:'left',clickCount:1})).toThrow();
    expect(()=>computerUseScopeMcpRequest({operation:'key',...base,observationId,requestId,key:'Enter',modifiers:['cmd','cmd']})).toThrow();
    expect(()=>computerUseScopeMcpRequest({operation:'type-text',...base,observationId,requestId,text:'a\0b'})).toThrow();
    expect(()=>computerUseScopeMcpRequest({operation:'capture',grant,observationId,displayId:'display_1'})).toThrow();
  });
  test('a refused request names the unexpected or missing field so an AI can correct it',()=>{
    // 1호 (2026-10-31): an AI added requestId to observe twice and only read 「요청이 올바르지 않습니다」.
    expect(()=>computerUseScopeMcpRequest({operation:'observe',...base,requestId})).toThrow('observe: 넣지 않는 항목 requestId (받는 항목: grant, epoch)');
    expect(()=>computerUseScopeMcpRequest({operation:'type-text',...base,observationId,text:'x'})).toThrow('type-text: 빠진 항목 requestId');
    expect(()=>computerUseScopeMcpRequest({operation:'click',...base,observationId,requestId,displayId:'display_1',x:-2,y:3,button:'left',clickCount:1})).toThrow('click: 값 형식을 확인하세요');
    expect(()=>computerUseScopeMcpRequest({operation:'status',grant})).toThrow('status에는 다른 항목을 넣지 않습니다');
    expect(()=>computerUseScopeMcpRequest({operation:'observe',...base,constructor:'x'})).toThrow('넣지 않는 항목 constructor');
  });
  test('the existing MCP connection forwards the new namespace without creating a new caller identity',async()=>{
    const calls:Record<string,unknown>[]=[];
    const c=new ComputerUseMcpConnection(async body=>{calls.push(body);return {success:true,connection:{id:'one_connection'}};});
    try{
      await c.call(computerUseScopeMcpRequest({operation:'status'}));
      await c.call(computerUseScopeMcpRequest({operation:'observe',...base}));
      expect(calls).toEqual([{operation:'scope-status'},{operation:'scope-observe',...base}]);
      expect(computerUseMcpRequest({operation:'status'})).toEqual({operation:'status'});
    }finally{await c.close();}
    expect(calls.at(-1)).toEqual({operation:'disconnect'});
  });
  test('scoped capture emits one image and keeps pixels out of text metadata',()=>{
    const r=computerUseMcpResult({success:true,image:{mediaType:'image/jpeg',data:'AAAA',width:640,height:480,displayWidth:1280,displayHeight:960,displayId:'display_1',originX:-1280,originY:0}});
    expect(r.content.filter(c=>c.type==='image')).toHaveLength(1);
    expect(r.structuredContent.image).toEqual({mediaType:'image/jpeg',width:640,height:480,displayWidth:1280,displayHeight:960,displayId:'display_1',originX:-1280,originY:0});
    expect(JSON.stringify(r.structuredContent)).not.toContain('AAAA');
  });
});
