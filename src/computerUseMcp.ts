import {parseComputerAgentRequest} from './computerUseProtocol';
import {parseComputerScopeAgentRequest} from './computerUseScopeProtocol';
export const COMPUTER_USE_MCP_TOOL={
  name:'agentstoz_use_computer',
  // Claude Code truncates long MCP text: keep onboarding and safety first, and the whole text short.
  description:'Use one Mac window a person approved in AgentsToZ Control, through background Accessibility actions. First call status; the person then selects this MCP connection and one window in AgentsToZ Tools and Settings → Computer Use and approves in Control with Touch ID. A connection may cover several chats of an app; do not claim per-chat isolation. Observe before every action; human activity pauses or refuses input. capture returns an image only when screen images were approved for that grant in Control and macOS Screen Recording is allowed. click takes window-relative points (image pixel × windowWidth/width and × windowHeight/height), needs a capture of the same observation and presses only an exactly observed accessible control. No global mouse, arbitrary keys, canvas pixel clicks, process launch or self-approval; agent, terminal and security apps are excluded. Keep request IDs, read receipts after uncertainty and never replay an unknown action.',
  inputSchema:{type:'object',properties:{operation:{type:'string',enum:['status','observe','capture','click','press','set-value','receipt','request-human']},grant:{type:'string'},epoch:{type:'integer'},requestId:{type:'string'},observationId:{type:'string'},element:{type:'string'},value:{type:'string'},x:{type:'number'},y:{type:'number'}},required:['operation'],additionalProperties:false},
} as const;
/** Return pixels as an MCP image block, not duplicated in text or structured metadata. */
export function computerUseMcpResult(result:Record<string,unknown>) {
  const image=result.image;
  if(result.success===true&&image&&typeof image==='object'&&!Array.isArray(image)) {
    const {data,mediaType,...dimensions}=image as Record<string,unknown>;
    if(mediaType!=='image/jpeg'||typeof data!=='string'||data.length>320000||!data.length
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) throw Error('Invalid screen image.');
    const metadata={...result,image:{mediaType,...dimensions}};
    return {content:[{type:'text',text:JSON.stringify(metadata)},{type:'image',mimeType:mediaType,data}],structuredContent:metadata,isError:false};
  }
  return {content:[{type:'text',text:JSON.stringify(result)}],structuredContent:result,isError:false};
}
export function computerUseMcpRequest(value:unknown):Record<string,unknown>{
  if(value&&typeof value==='object'&&!Array.isArray(value)&&typeof (value as any).operation==='string'&&(value as any).operation.startsWith('scope-'))return parseComputerScopeAgentRequest(value);
  if(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===1&&(value as any).operation==='status')return {operation:'status'};
  return parseComputerAgentRequest(value);
}
/** One transport per MCP process. The secret is sent in a header, never in a tool body or result. */
export class ComputerUseMcpConnection {
  private timer?:ReturnType<typeof setInterval>;
  private active=false;
  private failures=0;
  constructor(private readonly request:(body:Record<string,unknown>)=>Promise<Record<string,unknown>>){}
  async call(value:unknown){
    const body=computerUseMcpRequest(value),result=await this.request(body);
    if(result.success===true&&!this.active){
      this.active=true;this.timer=setInterval(()=>{void this.request({operation:'heartbeat'}).then(r=>{
        if(r.success===true)this.failures=0;else if(++this.failures>=3)this.stop();
      }).catch(()=>{if(++this.failures>=3)this.stop();});},20000);this.timer.unref?.();
    }
    return result;
  }
  private stop(){if(this.timer)clearInterval(this.timer);this.timer=undefined;this.active=false;}
  async close(){const wasActive=this.active;this.stop();if(wasActive)await this.request({operation:'disconnect'}).catch(()=>{});}
}
