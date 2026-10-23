import {SERVICE_USE_ALL_TOOLS, type ServiceUseTool} from './serviceUseProtocol';

export const SERVICE_USE_NATURAL_LANGUAGE_GUIDANCE = 'When the user asks for a product USE (for example “ShadowLoop USE로 자료 만들어줘” or “ShadowLoop-USE”), call agentstoz_use_resolve_target with that product role, then agentstoz_use_service_operation with the returned projectId as portId. Read status first and use only the verified tool inputs and approved phone IDs. execute submits one bounded app operation; receipt checks that same requestId after delay or uncertainty without replay. A USE request never starts a DEV Workroom or opens an arbitrary app URL.';

const serviceKey={type:'string',pattern:'^[a-z0-9][a-z0-9_-]{0,63}$'};
const id={type:'string',minLength:1,maxLength:128,pattern:'^[A-Za-z0-9_-]+$'};
const requestId={...id,minLength:8};
const inputFields:Record<ServiceUseTool,Record<string,unknown>>={
  'materials.generate':{text:{type:'string',minLength:1,maxLength:2000,description:'Material source text; at most 2,000 UTF-8 bytes.'}},
  'materials.reuse':{materialId:id},'audio.prepare':{materialId:id},
  'operation.status':{operationId:id},'operation.cancel':{operationId:id},
  'phone.deliver':{materialId:id,phoneId:{...id,description:'Exact approved phone ID returned by status; never guess from a name.'}},
  'app.invoke':{actionId:{type:'string',pattern:'^[a-z][a-z0-9_.-]{0,63}$',description:'Exact action id from status.actions. Use only that action\'s declared fields.'},arguments:{type:'object',maxProperties:8,additionalProperties:{type:['string','number','boolean']},description:'Only fields declared by status.actions. Strings at most 2,000 UTF-8 bytes; total 3,000 bytes.'}},
};
export const SERVICE_USE_MCP_TOOL={
  name:'agentstoz_use_service_operation',
  description:SERVICE_USE_NATURAL_LANGUAGE_GUIDANCE+' status reports activation, memory, verified tools and environment separately. For a connected generic app read status.actions and use app.invoke with the exact actionId and declared arguments; never assume ShadowLoop tools apply to other projects. A draft is not executable. Never grant this whole OPS MCP server to an ordinary app USE agent.',
  inputSchema:{type:'object',properties:{portId:{type:'string',minLength:1},serviceUse:{oneOf:[
    {type:'object',properties:{operation:{const:'status'},serviceKey},required:['operation'],additionalProperties:false},
    {type:'object',properties:{operation:{const:'receipt'},requestId},required:['operation','requestId'],additionalProperties:false},
    {type:'object',properties:{operation:{const:'execute'},requestId,call:{oneOf:SERVICE_USE_ALL_TOOLS.map(tool=>({type:'object',properties:{
      role:{const:'use'},serviceKey,tool:{const:tool},input:{type:'object',properties:inputFields[tool],required:Object.keys(inputFields[tool]),additionalProperties:false},
    },required:['role','serviceKey','tool','input'],additionalProperties:false}))}},required:['operation','requestId','call'],additionalProperties:false},
  ]}},required:['portId','serviceUse'],additionalProperties:false},
};
