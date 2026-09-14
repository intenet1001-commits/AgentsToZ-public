/** Exact conversation text projection, not a summarizer. Source ownership,
 * parent chains, completion and the digest of EVERY raw record must be verified
 * separately. Unknown content fails closed; no prefix filtering or truncation. */
export const MEMORY_CONVERSATION_INPUT_LIMIT = 20_000;
export const MEMORY_CONVERSATION_PROJECTION = 'conversation-v1' as const;
export class MemoryProjectionError extends Error {
 constructor(readonly code:'UNSUPPORTED_CONTENT'|'INPUT_OVERSIZED'){super(`Memory projection: ${code}`);}
}
export interface MemoryConversationMessage {role:'user'|'assistant';content:string[]}
const object=(value:unknown):value is Record<string,any>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const only=(value:Record<string,any>,keys:readonly string[])=>Object.keys(value).every(key=>keys.includes(key));
const claudeAttachments=new Set(['deferred_tools_delta','agent_listing_delta','skill_listing','auto_mode','total_tokens_reminder','mcp_instructions_delta',
 'environment','model','instructions','session_context','date','remote_session_change','prompt_snapshot']);
const claudeMetadata=new Set(['last-prompt','mode','permission-mode','atis-latch','ai-title']);
const codexMetadata=new Set(['turn_context','world_state','token_usage_record']);
const codexEvents=new Set(['task_started','task_complete','token_count','agent_reasoning']);
const codexItems=new Set(['Reasoning','CommandExecution','McpToolCall','WebSearch','ImageGeneration','FileChange','Plan','CollabAgentToolCall']);
const codexResponses=new Set(['reasoning','function_call','function_call_output','custom_tool_call','custom_tool_call_output','web_search_call','image_generation_call','compaction']);

/** A per-turn object; callers discard it on any raw verification failure. Only
 * canonical Codex completed events are conversation. response_item records are
 * model context/duplicates, as in codexTranscriptMessage, never a fallback. */
export class MemoryConversationProjector {
 readonly messages:MemoryConversationMessage[]=[];
 readonly omitted:Record<string,number>=Object.create(null);
 #bytes=0;
 constructor(readonly agent:'claude'|'codex'){}
 #reject():never {throw new MemoryProjectionError('UNSUPPORTED_CONTENT');}
 #omit(kind:string){this.omitted[kind]=(this.omitted[kind]??0)+1;}
 #message(role:'user'|'assistant',content:string[]){
  // Bound retained structure too: many empty blocks/messages still cost bytes.
  this.#bytes+=Buffer.byteLength(JSON.stringify({role,content}))+1;
  if(this.#bytes>MEMORY_CONVERSATION_INPUT_LIMIT)throw new MemoryProjectionError('INPUT_OVERSIZED');
  this.messages.push({role,content});
 }
 #texts(content:unknown,types:readonly string[],allowedNonText:readonly string[]=[]):string[]{
  if(!Array.isArray(content))this.#reject();
  const texts:string[]=[];
  for(const part of content){
   if(!object(part)||typeof part.type!=='string')this.#reject();
   if(types.includes(part.type)){
    if(typeof part.text!=='string'||Object.keys(part).some(key=>!['type','text','text_elements'].includes(key))
     ||(part.text_elements!==undefined&&(!Array.isArray(part.text_elements)||part.text_elements.length)))this.#reject();
    texts.push(part.text);
   }else if(allowedNonText.includes(part.type))this.#omit(`${this.agent}.block.${part.type}`);
   else this.#reject();
  }
  return texts;
 }
 record(row:unknown):void {
  if(!object(row))this.#reject();
  if(this.agent==='claude'){
   if(row.type==='user'||row.type==='assistant'){
    if(!object(row.message)||row.message.role!==row.type||!only(row.message,['id','type','role','model','content','container','context_management','stop_reason','stop_sequence','stop_details','usage','diagnostics']))this.#reject();
    const content=row.message.content;
    // isMeta is not permission to drop text. Even host-shaped text is retained.
    const texts=typeof content==='string'?[content]:this.#texts(content,['text'],row.type==='user'?['tool_result']:['tool_use','thinking','redacted_thinking']);
    if(texts.length)this.#message(row.type,texts);
   }else if(row.type==='attachment'){
    if(!object(row.attachment)||!claudeAttachments.has(row.attachment.type))this.#reject();
    this.#omit(`claude.attachment.${row.attachment.type}`);
   }else if(claudeMetadata.has(row.type))this.#omit(`claude.${row.type}`);
   else this.#reject();
   return;
  }
  if(codexMetadata.has(row.type)){this.#omit(`codex.${row.type}`);return;}
  const p=row.payload;if(!object(p))this.#reject();
  if(row.type==='response_item'){
   if(p.type==='message'){
    if(!['system','developer','user','assistant'].includes(p.role))this.#reject();
    // Validate text schema, but do not promote context-only messages to turns.
    this.#texts(p.content,['input_text','output_text']);
    this.#omit(`codex.response.message.${p.role}`);
   }else if(codexResponses.has(p.type))this.#omit(`codex.response.${p.type}`);
   else this.#reject();
   return;
  }
  if(row.type!=='event_msg')this.#reject();
  if(p.type==='task_complete'){
   if(!only(p,['type','turn_id','last_agent_message','started_at','completed_at','duration_ms','time_to_first_token_ms'])
    ||(p.last_agent_message!==undefined&&p.last_agent_message!==null&&typeof p.last_agent_message!=='string'))this.#reject();
   // Completion can carry a final answer even when its separate event is absent.
   // A byte-identical conversation copy is the only text we deduplicate.
   if(typeof p.last_agent_message==='string'&&p.last_agent_message.length
    &&!this.messages.some(m=>m.role==='assistant'&&m.content.join('\n')===p.last_agent_message))this.#message('assistant',[p.last_agent_message]);
   this.#omit('codex.event.task_complete');
  }else if(p.type==='user_message'||p.type==='agent_message'){
   if(!only(p,p.type==='user_message'?['type','message','images','local_images','text_elements','turn_id']:['type','message','phase','turn_id'])
    ||typeof p.message!=='string'||(p.images!==undefined&&(!Array.isArray(p.images)||p.images.length))
    ||(p.local_images!==undefined&&(!Array.isArray(p.local_images)||p.local_images.length))
    ||(p.text_elements!==undefined&&(!Array.isArray(p.text_elements)||p.text_elements.length)))this.#reject();
   this.#message(p.type==='user_message'?'user':'assistant',[p.message]);
  }else if(p.type==='item_completed'){
   if(!object(p.item))this.#reject();
   if(p.item.type==='UserMessage'||p.item.type==='AgentMessage'){
    if(!only(p,['type','item','thread_id','turn_id','started_at_ms','completed_at_ms'])||!only(p.item,p.item.type==='UserMessage'?['type','id','content']:['type','id','content','phase']))this.#reject();
    this.#message(p.item.type==='UserMessage'?'user':'assistant',this.#texts(p.item.content,['text','Text']));
   }
   else if(codexItems.has(p.item.type))this.#omit(`codex.item.${p.item.type}`);
   else this.#reject();
  }else if(codexEvents.has(p.type))this.#omit(`codex.event.${p.type}`);
  else this.#reject();
 }
 finish(){
  if(!this.messages.some(m=>m.role==='user'&&m.content.some(text=>text.trim())))this.#reject();
  return {messages:this.messages,omitted:this.omitted};
 }
}
