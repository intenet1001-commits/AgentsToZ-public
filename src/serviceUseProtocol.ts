import {APP_USE_ID, normalizeAppUseArguments, type AppUseValue} from './appUseCatalog';
/** Channel-neutral, path-free application operations. A tool draft never grants authority. */
export const SERVICE_USE_TOOLS = ['materials.generate', 'materials.reuse', 'audio.prepare', 'operation.status', 'operation.cancel', 'phone.deliver'] as const;
export const SERVICE_USE_ALL_TOOLS = [...SERVICE_USE_TOOLS, 'app.invoke'] as const;
export type ServiceUseTool = typeof SERVICE_USE_ALL_TOOLS[number];
export interface ServiceUseCall {
  role: 'use';
  serviceKey: string;
  tool: ServiceUseTool;
  input: { text?: string; materialId?: string; operationId?: string; phoneId?: string; actionId?: string; arguments?: Record<string, AppUseValue> };
}
export interface ServiceUseBinding {
  role: 'use'; projectId: string; serviceKey: string; serviceMemoryId: string;
  principalId: string; libraryId: string; deviceId: string; installationId: string;
  definitionRevision: string; grantRevision: string; allowedTools: ServiceUseTool[];
}
export interface ServiceUseOutcome {
  state: 'completed' | 'running' | 'failed' | 'unknown' | 'cancelled';
  message: string;
  operationId?: string;
  materialId?: string;
  /** Separate evidence; a Mac upload is not an iPhone receipt. */
  evidence?: { generated?: boolean; audioPrepared?: boolean; transferred?: boolean; phoneReceived?: boolean };
}
export interface ServiceUseReadiness {
  enabled: boolean;
  memoryReady: boolean;
  tools: 'draft' | 'verified' | 'unavailable';
  environmentReady: boolean;
  executionReady: boolean;
  problem: string | null;
}
export type ServiceUseRequest = { operation: 'status'; serviceKey: string }
  | { operation: 'execute'; requestId: string; call: ServiceUseCall }
  | { operation: 'receipt'; requestId: string };
export function parseServiceUseRequest(value: unknown): ServiceUseRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('USE 운영 요청을 확인하세요.');
  const v = value as Record<string, unknown>;
  const fields = v.operation === 'status' ? ['operation', 'serviceKey'] : v.operation === 'execute' ? ['operation', 'requestId', 'call'] : v.operation === 'receipt' ? ['operation', 'requestId'] : [];
  if (!fields.length || Object.keys(v).some(k => !fields.includes(k))) throw Error('허용된 USE 운영 요청만 사용하세요.');
  if (v.operation === 'status') {
    const serviceKey = v.serviceKey ?? 'default';
    if (typeof serviceKey !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(serviceKey)) throw Error('USE 서비스 키를 확인하세요.');
    return { operation: 'status', serviceKey };
  }
  if (typeof v.requestId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(v.requestId)) throw Error('USE 요청 ID를 확인하세요.');
  return v.operation === 'execute' ? { operation: 'execute', requestId: v.requestId, call: normalizeServiceUseCall(v.call) } : { operation: 'receipt', requestId: v.requestId };
}
const id = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v);
export function normalizeServiceUseCall(value: unknown): ServiceUseCall {
  const v = value as ServiceUseCall;
  const fail = (): never => { throw Error('USE 도구와 입력을 확인하세요. 소스·Git·셸 작업은 DEV 담당자에게 인계하세요.'); };
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).some(k => !['role', 'serviceKey', 'tool', 'input'].includes(k))
    || v.role !== 'use' || typeof v.serviceKey !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(v.serviceKey)
    || !(SERVICE_USE_ALL_TOOLS as readonly unknown[]).includes(v.tool) || !v.input || typeof v.input !== 'object' || Array.isArray(v.input)) return fail();
  if (v.tool === 'app.invoke') {
    if (Object.keys(v.input).sort().join(',') !== 'actionId,arguments' || typeof v.input.actionId !== 'string' || !APP_USE_ID.test(v.input.actionId)) return fail();
    return {role:'use', serviceKey:v.serviceKey, tool:v.tool, input:{actionId:v.input.actionId, arguments:normalizeAppUseArguments(v.input.arguments)}};
  }
  const fields: Record<typeof SERVICE_USE_TOOLS[number], string[]> = {
    'materials.generate': ['text'], 'materials.reuse': ['materialId'], 'audio.prepare': ['materialId'],
    'operation.status': ['operationId'], 'operation.cancel': ['operationId'], 'phone.deliver': ['materialId', 'phoneId'],
  };
  const required = fields[v.tool];
  if (Object.keys(v.input).length !== required.length || required.some(k => !(k in v.input)) || Object.keys(v.input).some(k => !required.includes(k))) return fail();
  for (const [key, input] of Object.entries(v.input)) {
    if (key === 'text') {
      if (typeof input !== 'string' || !input.trim() || /[\u0000-\u0008\u000b-\u001f\u007f]/u.test(input) || new TextEncoder().encode(input).length > 2000) return fail();
    } else if (!id(input)) return fail();
  }
  return { role: 'use', serviceKey: v.serviceKey, tool: v.tool, input: Object.fromEntries(required.map(k => [k, v.input[k as keyof ServiceUseCall['input']]])) };
}
export function normalizeServiceUseOutcome(value: ServiceUseOutcome): ServiceUseOutcome {
  if (!value || !['completed', 'running', 'failed', 'unknown', 'cancelled'].includes(value.state)
    || typeof value.message !== 'string' || !value.message.trim() || new TextEncoder().encode(value.message).length > 2000
    || Object.keys(value).some(k => !['state', 'message', 'operationId', 'materialId', 'evidence'].includes(k))
    || value.operationId !== undefined && !id(value.operationId) || value.materialId !== undefined && !id(value.materialId)
    || value.evidence !== undefined && (!value.evidence || typeof value.evidence !== 'object' || Array.isArray(value.evidence)
      || Object.entries(value.evidence).some(([k, v]) => !['generated', 'audioPrepared', 'transferred', 'phoneReceived'].includes(k) || typeof v !== 'boolean'))) throw Error('앱의 USE 실행 영수증을 검증하지 못했습니다.');
  return { ...value, ...(value.evidence ? { evidence: { ...value.evidence } } : {}) };
}
