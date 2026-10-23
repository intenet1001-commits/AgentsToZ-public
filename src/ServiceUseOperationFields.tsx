import type { ServiceUseTool } from './serviceUseProtocol';
import type {AppUseValue} from './appUseCatalog';
import type {WorkroomUseCatalog} from './workroomThreadProtocol';
export const SERVICE_USE_TOOL_LABELS: Record<ServiceUseTool, string> = {
  'materials.generate': '자료 생성', 'materials.reuse': '기존 자료 사용', 'audio.prepare': '음성 준비',
  'operation.status': '기존 요청 상태 조회', 'operation.cancel': '기존 요청 취소', 'phone.deliver': '승인된 폰에 전달',
  'app.invoke':'앱 기능 사용',
};
export interface ServiceUseFields { tool: ServiceUseTool; materialId: string; operationId: string; phoneId: string; actionId?:string; arguments?:Record<string,AppUseValue> }
export function serviceUseInput(fields: ServiceUseFields, text: string) {
  if (fields.tool === 'app.invoke') return {actionId:fields.actionId??'',arguments:fields.arguments??{}};
  if (fields.tool === 'materials.generate') return { text };
  if (fields.tool === 'operation.status' || fields.tool === 'operation.cancel') return { operationId: fields.operationId };
  if (fields.tool === 'phone.deliver') return { materialId: fields.materialId, phoneId: fields.phoneId };
  return { materialId: fields.materialId };
}
export function ServiceUseOperationFields({ value, onChange, disabled, catalog }: { value: ServiceUseFields; onChange(v: ServiceUseFields): void; disabled: boolean; catalog?:WorkroomUseCatalog }) {
  const action=catalog?.actions?.find(a=>a.id===value.actionId);
  return <fieldset className="my-2 space-y-2 rounded-lg border border-[var(--line)] p-3" disabled={disabled}>
    <legend>USE · 허용된 제품 동작</legend>
    <label>운영 도구<select aria-label="USE 운영 도구" className="min-h-11 ml-2 bg-[var(--surface)]" value={value.tool} onChange={e => onChange({ ...value, tool: e.target.value as ServiceUseTool })}>
      {!catalog?.tools.length&&<option value="">허용된 도구 확인 중</option>}{(catalog?.tools??[]).map(key => <option key={key} value={key}>{SERVICE_USE_TOOL_LABELS[key]}</option>)}
    </select></label>
    {value.tool==='app.invoke'&&<>
      <label className="block">앱에서 할 일<select aria-label="USE 앱 동작" className="min-h-11 ml-2 max-w-full bg-[var(--surface)]" value={value.actionId??''} onChange={e=>onChange({...value,actionId:e.target.value,arguments:Object.fromEntries((catalog?.actions?.find(a=>a.id===e.target.value)?.fields??[]).filter(f=>f.required&&f.type==='boolean').map(f=>[f.key,false]))})}>{catalog?.actions?.map(a=><option key={a.id} value={a.id}>{a.label}</option>)}</select></label>
      {action?.effect==='external'&&<p className="text-sm">이 동작은 앱 외부로 전송하거나 반영합니다. 대상과 내용을 확인한 뒤 요청하세요.</p>}
      {action?.fields.map(f=><label key={f.key} className="block text-sm">{f.label}{f.required?' *':''}{f.type==='boolean'?<input type="checkbox" aria-label={'USE '+f.label} checked={value.arguments?.[f.key]===true} onChange={e=>onChange({...value,arguments:{...value.arguments,[f.key]:e.target.checked}})}/>:<input type={f.type==='number'?'number':'text'} className="min-h-11 ml-2 max-w-full bg-[var(--surface)]" aria-label={'USE '+f.label} maxLength={2000} value={String(value.arguments?.[f.key]??'')} onChange={e=>{const args={...value.arguments};if(!e.target.value)delete args[f.key];else args[f.key]=f.type==='number'?Number(e.target.value):e.target.value;onChange({...value,arguments:args});}}/>}</label>)}
    </>}
    {catalog&&!catalog.executionReady&&<p role="status" className="text-sm">{catalog.problem??'앱 USE 연결을 확인하세요.'}</p>}
    {['materials.reuse', 'audio.prepare', 'phone.deliver'].includes(value.tool) && <label className="block">자료 ID<input className="min-h-11 ml-2 bg-[var(--surface)]" aria-label="USE 자료 ID" value={value.materialId} maxLength={128} onChange={e => onChange({ ...value, materialId: e.target.value })} /></label>}
    {['operation.status', 'operation.cancel'].includes(value.tool) && <label className="block">원래 요청 ID<input className="min-h-11 ml-2 bg-[var(--surface)]" aria-label="USE 원래 요청 ID" value={value.operationId} maxLength={128} onChange={e => onChange({ ...value, operationId: e.target.value })} /></label>}
    {value.tool === 'phone.deliver' && <label className="block">승인된 폰 ID<input className="min-h-11 ml-2 bg-[var(--surface)]" aria-label="USE 승인된 폰 ID" value={value.phoneId} maxLength={128} onChange={e => onChange({ ...value, phoneId: e.target.value })} /></label>}
    <p className="text-xs">앱이 확인한 자료·요청·폰 ID만 사용하세요. USE 활성화·운영기억·검증된 도구·실행환경이 모두 준비되어야 실행됩니다. 개발 요청은 DEV 담당자에게 인계합니다.</p>
  </fieldset>;
}
