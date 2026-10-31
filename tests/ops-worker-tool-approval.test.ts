import {afterEach,describe,expect,test} from 'bun:test';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AGENTSTOZ_USE_MCP_SERVER_NAME,AGENTSTOZ_USE_MCP_TOOLS} from '../agentstoz-use-mcp-server';
import {aiTerminalLaunchArgs} from '../src/aiTerminalLaunchArgs';
import {AiTerminalService} from '../src/aiTerminalService';
import {AGENTSTOZ_USE_MCP_SERVER,OPS_WORKER_PREAPPROVED_TOOLS,opsWorkerApprovalArgs} from '../src/opsWorkerToolApproval';

// 2026-10-31: an OPS task 3호 handed to 1호 sat at 「승인·확인 필요」 — the receiving Codex, started without the bypass,
// asked 「Allow the agentstoz_use MCP server to run tool …?」 at every AgentsToZ call. The person chose to pre-approve
// only the tools a handover needs, for that one worker launch.
const cleanup:(()=>Promise<unknown>)[]=[];afterEach(async()=>{for(const c of cleanup.splice(0).reverse())await c();});
const codexKey=(tool:string)=>`mcp_servers.agentstoz_use.tools.${tool}.approval_mode="approve"`;

describe('an OPS worker pre-approves only the AgentsToZ tools a handover needs',()=>{
  test('every listed tool is a real tool of the real server',()=>{
    expect(AGENTSTOZ_USE_MCP_SERVER).toBe(AGENTSTOZ_USE_MCP_SERVER_NAME);
    const names=new Set(AGENTSTOZ_USE_MCP_TOOLS.map(tool=>tool.name));
    for(const tool of OPS_WORKER_PREAPPROVED_TOOLS)expect(names.has(tool)).toBe(true);
    expect(new Set(OPS_WORKER_PREAPPROVED_TOOLS).size).toBe(OPS_WORKER_PREAPPROVED_TOOLS.length);
  });
  test('tools that answer prompts, leave the Mac or act for the person still ask',()=>{
    for(const tool of ['agentstoz_use_send_workroom_keys','agentstoz_use_submit_ops_request','agentstoz_use_computer_session','agentstoz_use_computer',
      'agentstoz_use_send_shared_shell_command','agentstoz_use_create_github_repository','agentstoz_use_create_project','agentstoz_use_register_existing_project',
      'agentstoz_use_create_team','agentstoz_use_service_operation','agentstoz_use_platform_cli','agentstoz_use_send_dialogue_message',
      'agentstoz_use_propose_control_memory','agentstoz_use_manage_common_memory','agentstoz_use_open_code_app'])
      expect((OPS_WORKER_PREAPPROVED_TOOLS as readonly string[]).includes(tool)).toBe(false);
  });
  test('Codex gets one per-tool override each; Claude one --allowedTools; Hermes and agy nothing',()=>{
    const codex=opsWorkerApprovalArgs('codex');
    expect(codex).toEqual(OPS_WORKER_PREAPPROVED_TOOLS.flatMap(tool=>['-c',codexKey(tool)]));
    // Never the whole server: 3호 measured that a per-tool key leaves every other tool asking.
    expect(codex.some(arg=>arg.includes('default_tools_approval_mode'))).toBe(false);
    expect(opsWorkerApprovalArgs('claude')).toEqual(['--allowedTools',OPS_WORKER_PREAPPROVED_TOOLS.map(tool=>`mcp__agentstoz_use__${tool}`).join(',')]);
    expect(opsWorkerApprovalArgs('hermes')).toEqual([]);expect(opsWorkerApprovalArgs('agy')).toEqual([]);
  });
  test('the launch keeps its normal policy and the prompt stays last',()=>{
    const args=aiTerminalLaunchArgs('codex','s','작업',false,null,null,false,null,null,true);
    expect(args.slice(args.indexOf('--ask-for-approval'),args.indexOf('--ask-for-approval')+4)).toEqual(['--ask-for-approval','on-request','--sandbox','workspace-write']);
    expect(args).toContain(codexKey('agentstoz_use_complete_ops_request'));
    expect(args.slice(-2)).toEqual(['--','작업']);
    const claude=aiTerminalLaunchArgs('claude','s','작업',false,null,null,false,null,null,true);
    expect(claude).toContain('--allowedTools');expect(claude.slice(-2)).toEqual(['--','작업']);
    expect(claude.slice(claude.indexOf('--permission-mode'),claude.indexOf('--permission-mode')+2)).toEqual(['--permission-mode','default']);
    // Not an OPS worker: byte-identical to before.
    expect(aiTerminalLaunchArgs('codex','s','작업',false,null,null,false,null,null,false)).toEqual(aiTerminalLaunchArgs('codex','s','작업'));
    // A bypass launch or a restricted (duty) launch never takes them.
    expect(aiTerminalLaunchArgs('codex','s','작업',true,null,null,false,null,null,true)).toEqual(aiTerminalLaunchArgs('codex','s','작업',true));
    const profile={tools:['Read'],permissionMode:'default',allowedTools:['Read'],disallowedTools:[]} as any;
    expect(aiTerminalLaunchArgs('claude','s','작업',false,null,profile,false,null,null,true)).toEqual(aiTerminalLaunchArgs('claude','s','작업',false,null,profile));
  });
});

describe('only this Mac’s OPS host can ask for it',()=>{
  function fixture(){
    const root=mkdtempSync(join(tmpdir(),'ops-worker-approval-')),launches:string[][]=[];
    const service=new AiTerminalService({resolveTarget:async()=>({cwd:root}),executable:()=>'/fixture/codex',codexHookTrustSupported:async()=>false,
      spawn:(args,options:any)=>{launches.push(args);let exit!:(n:number)=>void;const exited=new Promise<number>(r=>{exit=r;});
        queueMicrotask(()=>options.terminal.data(null,new TextEncoder().encode('› ')));
        return {pid:700002,exited,kill:()=>exit(143),terminal:{write:(text:string)=>Buffer.byteLength(text),resize(){},close(){exit(0);}}} as any;}});
    cleanup.push(async()=>{await service.shutdown();rmSync(root,{recursive:true,force:true});});
    const start=(extra:Record<string,unknown>={},options:Record<string,unknown>={opsWorker:true},authority?:any)=>service.perform({operation:'start',requestId:crypto.randomUUID(),
      targetId:'project-ops-worker-01',agent:'codex',prompt:'다른 기기의 작업',cols:100,rows:28,bypassPermissions:false,...extra},authority,options as any);
    return {launches,start};
  }
  test('the host start carries the per-tool approvals; an ordinary start does not',async()=>{
    const f=fixture();
    await f.start();expect(f.launches[0]).toContain(codexKey('agentstoz_use_start_workroom_session'));
    await f.start({},{});expect(f.launches[1]!.some(arg=>arg.includes('approval_mode="approve"'))).toBe(false);
  });
  test('the OPS host starts its worker with it and without the bypass',()=>{
    const source=readFileSync(join(import.meta.dir,'..','api-server.ts'),'utf8');
    expect(source).toContain("aiTerminalService.perform({operation:'start',...input,cols:100,rows:28,bypassPermissions:false},undefined,{opsWorker:true})");
    expect(source.match(/opsWorker:true/g)?.length).toBe(1);
  });
  test('a remote caller or a bypass launch cannot ask for it',async()=>{
    const f=fixture();
    await expect(f.start({bypassPermissions:true})).rejects.toThrow('OPS 작업 도구 허용');
    const remote={owner:'remote-device-01',targets:new Set(['project-ops-worker-01']),deviceConsentActive:()=>true};
    await expect(f.start({},{opsWorker:true},remote)).rejects.toThrow('OPS 작업 도구 허용');
    expect(f.launches).toEqual([]);
  });
});
