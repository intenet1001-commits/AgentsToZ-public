export const GEMINI_VOICE_SETTINGS_PATH='/api/agent-runtime/voice-settings';
export const DEFAULT_GEMINI_LIVE_MODEL='gemini-3.8-live';
// Application resource bound, not a provider format/length assumption. Auth keys
// are opaque strings; newer Google keys include dots and exceed legacy lengths.
export const MAX_GEMINI_API_KEY_LENGTH=2048;
export type GeminiVoiceSettingsRequest={operation:'status'}|{operation:'delete'}|{operation:'save';apiKey:string;model:string}|{operation:'test';model:string};
export interface GeminiVoiceSettingsStatus {supported:boolean;configured:boolean;model:string;checkedAt:string|null;checkedModel:string|null}
export function validGeminiModel(value:unknown):value is string{return typeof value==='string'&&/^gemini-[a-z0-9][a-z0-9.-]{0,100}$/.test(value);}
export function parseGeminiVoiceSettingsRequest(value:unknown):GeminiVoiceSettingsRequest {
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('요청 형식을 확인하세요.');
 const v=value as Record<string,unknown>;
 const keys=v.operation==='save'?['operation','apiKey','model']:v.operation==='test'?['operation','model']:['operation'];
 if(Object.keys(v).some(k=>!keys.includes(k))||!['status','save','test','delete'].includes(String(v.operation)))throw Error('지원하지 않는 음성 설정 요청입니다.');
 if((v.operation==='save'||v.operation==='test')&&!validGeminiModel(v.model))throw Error('Gemini 모델 ID를 확인하세요.');
 if(v.operation==='save'&&(typeof v.apiKey!=='string'||v.apiKey.length<20||v.apiKey.length>MAX_GEMINI_API_KEY_LENGTH||!/^[\x21-\x7e]+$/.test(v.apiKey)))throw Error('API 키 전체를 복사해 넣어 주세요. 공백·줄바꿈 없이 키 값만 입력해야 합니다.');
 return v as GeminiVoiceSettingsRequest;
}
