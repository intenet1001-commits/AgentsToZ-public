export const VOICE_POPOUT_LABEL='voice-dock';
export const VOICE_POPOUT_CONTEXT_EVENT='voice-dock:context';
export const VOICE_POPOUT_ACTION_EVENT='voice-dock:action';
export interface VoicePopoutContext {deviceName:string;opsAvailable:boolean;devices:{key:string;name:string}[]}
export function parseVoicePopout(search:string):{panel:boolean}|null {
  if(search==='?voice-popout=1')return {panel:false};
  if(search==='?voice-popout=1&panel=1')return {panel:true};
  return null;
}
export const emptyVoicePopoutContext:VoicePopoutContext={deviceName:'',opsAvailable:false,devices:[]};
