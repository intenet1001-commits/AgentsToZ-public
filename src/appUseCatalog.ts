/** Bounded, declarative app operations. A catalog never supplies code, URLs or host tools. */
export type AppUseValue = string | number | boolean;
export interface AppUseField { key: string; label: string; type: 'string' | 'number' | 'boolean'; required: boolean }
export interface AppUseAction { id: string; label: string; effect: 'read' | 'write' | 'external'; fields: AppUseField[] }
export const APP_USE_ID = /^[a-z][a-z0-9_.-]{0,63}$/;
const label = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && v.length <= 80 && !/[\u0000-\u001f\u007f]/u.test(v);
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
export function normalizeAppUseActions(value: unknown): AppUseAction[] {
  const fail = (): never => { throw Error('앱의 USE 동작 목록을 확인하세요.'); };
  if (!Array.isArray(value) || !value.length || value.length > 12 || new TextEncoder().encode(JSON.stringify(value)).length > 4000) return fail();
  const actions = value.map(a => {
    if (!object(a) || Object.keys(a).sort().join(',') !== 'effect,fields,id,label' || typeof a.id !== 'string' || !APP_USE_ID.test(a.id) || !label(a.label)
      || !['read','write','external'].includes(String(a.effect)) || !Array.isArray(a.fields) || a.fields.length > 8) return fail();
    const fields = a.fields.map(f => {
      if (!object(f) || Object.keys(f).sort().join(',') !== 'key,label,required,type' || typeof f.key !== 'string' || !APP_USE_ID.test(f.key)
        || ['__proto__','constructor','prototype'].includes(String(f.key)) || !label(f.label) || !['string','number','boolean'].includes(String(f.type)) || typeof f.required !== 'boolean') return fail();
      return {key:f.key, label:f.label, type:f.type, required:f.required} as AppUseField;
    });
    if (new Set(fields.map(f => f.key)).size !== fields.length) return fail();
    return {id:a.id, label:a.label, effect:a.effect, fields} as AppUseAction;
  });
  if (new Set(actions.map(a => a.id)).size !== actions.length) return fail();
  return actions;
}
export function normalizeAppUseArguments(value: unknown): Record<string, AppUseValue> {
  if (!object(value) || Object.keys(value).length > 8 || new TextEncoder().encode(JSON.stringify(value)).length > 3000) throw Error('USE 동작 입력의 크기를 확인하세요.');
  for (const [key,v] of Object.entries(value)) if (!APP_USE_ID.test(key) || ['__proto__','constructor','prototype'].includes(key)
    || !(typeof v === 'boolean' || typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 1e12
      || typeof v === 'string' && !/[\u0000-\u0008\u000b-\u001f\u007f]/u.test(v) && new TextEncoder().encode(v).length <= 2000)) throw Error('USE 동작 입력 형식을 확인하세요.');
  return Object.fromEntries(Object.entries(value)) as Record<string,AppUseValue>;
}
export function validateAppUseAction(actions: readonly AppUseAction[], actionId: string, value: unknown) {
  const action = actions.find(a => a.id === actionId), args = normalizeAppUseArguments(value);
  if (!action || Object.keys(args).some(k => !action.fields.some(f => f.key === k))
    || action.fields.some(f => f.required && !(f.key in args) || f.key in args && typeof args[f.key] !== f.type)) throw Error('이 앱이 허용한 USE 동작과 입력을 선택하세요.');
  return args;
}
