/**
 * Human-readable device names. These values are display metadata, never identity or authority.
 */
import { runPortalDataWriteExclusive } from './portalLocalMetadata';

export const DEVICE_NAME_MAX_LENGTH = 40;
export const DEFAULT_DEVICE_NAME = '이 Mac의 AgentsToZ';

export type DeviceNameValidation =
  | { ok: true; value: string }
  | { ok: false; error: string };

const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const BIDI_CONTROL_CHARS = /[\u200e\u200f\u061c\u202a-\u202e\u2066-\u2069]/u;

export function validateDeviceName(raw: unknown): DeviceNameValidation {
  if (typeof raw !== 'string') return { ok: false, error: '기기 이름을 입력하세요.' };
  const value = raw.normalize('NFC').trim();
  if (!value) return { ok: false, error: '기기 이름을 입력하세요.' };
  if (CONTROL_CHARS.test(value)) return { ok: false, error: '기기 이름에 줄바꿈이나 제어 문자를 쓸 수 없습니다.' };
  if (BIDI_CONTROL_CHARS.test(value)) return { ok: false, error: '기기 이름에 글자 방향 제어 문자를 쓸 수 없습니다.' };
  if ([...value].length > DEVICE_NAME_MAX_LENGTH) return { ok: false, error: `기기 이름은 ${DEVICE_NAME_MAX_LENGTH}자 이하로 입력하세요.` };
  return { ok: true, value };
}

/**
 * Resolve the display label exposed by newly created LAN/internet pairings.
 * Invalid legacy/corrupt portal values must never leak into a protocol field.
 */
export function deviceHostName(portal: Record<string, unknown> | null | undefined): string {
  const checked = validateDeviceName(portal?.deviceName);
  return checked.ok ? checked.value : DEFAULT_DEVICE_NAME;
}

export const DEVICE_NAME_CHANGED_EVENT = 'agentstoz:device-name-changed';
export interface DeviceNameChange { deviceId: string; deviceName: string }

export function dispatchDeviceNameChanged(change: DeviceNameChange): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent<DeviceNameChange>(DEVICE_NAME_CHANGED_EVENT,{detail:change}));
}

export function onDeviceNameChanged(handler:(change:DeviceNameChange)=>void):()=>void {
  if (typeof window === 'undefined') return ()=>{};
  const listener=(event:Event)=>{const detail=(event as CustomEvent<DeviceNameChange>).detail;if(detail&&typeof detail.deviceId==='string'&&typeof detail.deviceName==='string')handler(detail);};
  window.addEventListener(DEVICE_NAME_CHANGED_EVENT,listener);
  return ()=>window.removeEventListener(DEVICE_NAME_CHANGED_EVENT,listener);
}

export type RemoteRenameOutcome='updated'|'not-registered'|'skipped'|'failed';
export interface RenameThisDeviceDeps {
  loadPortal():Promise<Record<string,unknown>>;
  savePortal(next:Record<string,unknown>):Promise<void>;
  updateRemoteName?:(portal:Record<string,unknown>,deviceId:string,name:string)=>Promise<Exclude<RemoteRenameOutcome,'failed'>>;
  notify?:(change:DeviceNameChange)=>void;
}
export interface RenameThisDeviceResult {deviceName:string;changed:boolean;remote:RemoteRenameOutcome;remoteError?:string}

export class DeviceRenameError extends Error {
  constructor(message:string){super(message);this.name='DeviceRenameError';}
}

/**
 * Save the local authority first. A remote failure does not roll it back; the next Push retries
 * propagation. The on-disk device id is rechecked inside the shared portal write lease.
 */
export async function renameThisDevice(input:{deviceId:string;name:string},deps:RenameThisDeviceDeps):Promise<RenameThisDeviceResult> {
  const validation=validateDeviceName(input.name);
  if(!validation.ok)throw new DeviceRenameError(validation.error);
  const deviceName=validation.value,expectedDeviceId=input.deviceId.trim();
  if(!expectedDeviceId)throw new DeviceRenameError('이 기기의 Device ID를 읽지 못해 이름을 바꾸지 않았습니다.');
  const saved=await runPortalDataWriteExclusive(async()=>{
    const portal=await deps.loadPortal();
    const diskDeviceId=typeof portal.deviceId==='string'?portal.deviceId.trim():'';
    if(diskDeviceId!==expectedDeviceId)throw new DeviceRenameError('이 기기의 신원이 화면과 달라 이름을 바꾸지 않았습니다. 화면을 새로고침한 뒤 다시 시도하세요.');
    const current=typeof portal.deviceName==='string'?portal.deviceName.normalize('NFC').trim():'';
    if(current===deviceName)return {portal,changed:false};
    const next={...portal,deviceName};
    try{await deps.savePortal(next);}catch(error){throw new DeviceRenameError(`이 기기에 이름을 저장하지 못했습니다: ${error instanceof Error?error.message:String(error)}`);}
    return {portal:next,changed:true};
  });
  (deps.notify??dispatchDeviceNameChanged)({deviceId:expectedDeviceId,deviceName});
  if(!deps.updateRemoteName)return {deviceName,changed:saved.changed,remote:'skipped'};
  try{return {deviceName,changed:saved.changed,remote:await deps.updateRemoteName(saved.portal,expectedDeviceId,deviceName)};}
  catch(error){return {deviceName,changed:saved.changed,remote:'failed',remoteError:error instanceof Error?error.message:String(error)};}
}

export function describeRenameResult(result:RenameThisDeviceResult):{message:string;kind:'success'|'error'} {
  if(result.remote==='failed')return {message:`이 기기에는 「${result.deviceName}」(으)로 저장했지만 Supabase에 바로 반영하지 못했습니다. 다음 올리기(Push) 때 다시 보냅니다. (${result.remoteError??'알 수 없는 오류'})`,kind:'error'};
  if(result.remote==='not-registered')return {message:`이 기기 이름을 「${result.deviceName}」(으)로 바꿨습니다. 다음 올리기(Push) 때 다른 기기에도 보입니다.`,kind:'success'};
  return {message:`이 기기 이름을 「${result.deviceName}」(으)로 바꿨습니다.`,kind:'success'};
}
