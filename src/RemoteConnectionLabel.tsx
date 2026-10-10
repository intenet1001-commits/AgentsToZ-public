import React,{useState} from 'react';
import {DeviceNameEditor} from './components/DeviceNameEditor';
import {validateDeviceName} from './deviceName';

/** Display-only connection aliases. They never participate in identity or permissions. */
const LABEL_PREFIX='agentstoz.remote-device-label.v1:';
export const internetConnectionLabelKey=(sessionId:string)=>`${LABEL_PREFIX}${sessionId}`;
// LAN session ids rotate on reconnect; pairedAt survives that rotation without weakening authority.
export const lanConnectionLabelKey=(pairedAt:string)=>`${LABEL_PREFIX}lan:${pairedAt}`;

export function readConnectionLabel(key:string):string {
  try{const checked=validateDeviceName(localStorage.getItem(key)??'');return checked.ok?checked.value:'';}catch{return '';}
}
export function writeConnectionLabel(key:string,name:string):string {
  const checked=validateDeviceName(name);if(!checked.ok)throw new Error(checked.error);
  try{localStorage.setItem(key,checked.value);}catch{throw new Error('이름을 저장하지 못했습니다. 다시 시도해 주세요.');}
  return checked.value;
}

export function RemoteConnectionLabel({sessionId,fallback,storageKey,testIdPrefix='remote-connection-label'}:{sessionId:string;fallback:string;storageKey?:string;testIdPrefix?:string}) {
  const key=storageKey??internetConnectionLabelKey(sessionId);
  const [name,setName]=useState(()=>readConnectionLabel(key));
  return <div className="min-w-0">
    <DeviceNameEditor value={name} emptyLabel={fallback} editLabel={name?'기기 이름 수정':'기기 이름 붙이기'}
      placeholder="예: 아이폰17 · TestFlight" hint="이 Mac에만 보이는 이름입니다. 권한과는 관계없습니다."
      testIdPrefix={testIdPrefix} nameClassName="text-xs font-semibold text-zinc-200" onSave={next=>{setName(writeConnectionLabel(key,next));}}/>
    <div className="mt-1 text-[10px] text-zinc-500">연결 {sessionId.slice(-8)}{name?` · ${fallback}`:''}</div>
  </div>;
}

export function connectionDisplayName(storageKey:string,fallback:string):string{return readConnectionLabel(storageKey)||fallback;}
