import {validateDeviceName} from './deviceName';

/** A project session belongs to its host device; only the OPS project is the 총괄. */
export function workroomSessionOwner(targetId:string,opsTargetId:string|undefined,deviceName:string|undefined,remote=false):string{
  const checked=validateDeviceName(deviceName);
  const device=checked.ok?checked.value:remote?'연결된 기기':'이 기기';
  return opsTargetId&&targetId===opsTargetId?checked.ok?`총괄(${device})`:`${device} 총괄`:device;
}
