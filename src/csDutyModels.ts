/** Picker values are explicit provider IDs, never shell fragments or automatic routing. */
export const DUTY_PROVIDERS = ['claude', 'codex', 'agy'] as const;
export type DutyProvider = typeof DUTY_PROVIDERS[number];
export const DUTY_MODEL_PRESETS: Record<DutyProvider, {id:string; label:string}[]> = {
 claude: [{id:'claude-haiku-4-5',label:'Haiku 4.5'},{id:'claude-sonnet-4-6',label:'Sonnet 4.6'},{id:'claude-opus-4-6',label:'Opus 4.6'}],
 codex: [{id:'gpt-5.3-codex-spark',label:'GPT-5.3 Codex Spark'},{id:'gpt-5.6-luna',label:'GPT-5.6 Luna'},{id:'gpt-5.6-terra',label:'GPT-5.6 Terra'},{id:'gpt-5.6-sol',label:'GPT-5.6 Sol'},{id:'gpt-6-astra',label:'GPT-6 Astra'}],
 agy: [{id:'gemini-3.8-flash-low',label:'Gemini 3.8 Flash Low'},{id:'gemini-3.8-flash-medium',label:'Gemini 3.8 Flash Medium'},{id:'gemini-3.8-flash-high',label:'Gemini 3.8 Flash High'},{id:'gemini-3.7-flash-low',label:'Gemini 3.7 Flash Low'},{id:'gemini-3.6-flash-low',label:'Gemini 3.6 Flash Low'},{id:'gemini-3.1-pro-low',label:'Gemini 3.1 Pro Low'},{id:'gemini-3.1-pro-high',label:'Gemini 3.1 Pro High'},{id:'claude-sonnet-4-6',label:'Claude Sonnet 4.6 Thinking'},{id:'claude-opus-4-6-thinking',label:'Claude Opus 4.6 Thinking'},{id:'gpt-oss-120b-medium',label:'GPT-OSS 120B Medium'}],
};
export function validDutyModel(provider: unknown, model:unknown):boolean {
 return typeof provider==='string'&&DUTY_PROVIDERS.includes(provider as DutyProvider)&&typeof model==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/.test(model);
}
