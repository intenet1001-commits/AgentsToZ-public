import React,{useEffect,useRef,useState} from 'react';
import {Check,Loader2,Pencil,X} from 'lucide-react';
import {DEVICE_NAME_MAX_LENGTH,validateDeviceName} from '../deviceName';

export interface DeviceNameEditorProps {
  value:string;emptyLabel:string;onSave:(name:string)=>Promise<void>|void;editLabel:string;
  hint?:string;placeholder?:string;testIdPrefix:string;disabled?:boolean;suffix?:React.ReactNode;
  className?:string;nameClassName?:string;
}

export function DeviceNameEditor({value,emptyLabel,onSave,editLabel,hint,placeholder,testIdPrefix,disabled,suffix,className,nameClassName}:DeviceNameEditorProps) {
  const [editing,setEditing]=useState(false),[draft,setDraft]=useState(value),[error,setError]=useState('');
  const [pending,setPending]=useState<string|null>(null),[confirmed,setConfirmed]=useState<string|null>(null);
  const inputRef=useRef<HTMLInputElement>(null),editButtonRef=useRef<HTMLButtonElement>(null),mountedRef=useRef(true);
  useEffect(()=>()=>{mountedRef.current=false;},[]);
  useEffect(()=>{setConfirmed(null);},[value]);
  useEffect(()=>{if(editing)inputRef.current?.select();},[editing]);
  const shown=pending??confirmed??value;
  const cancel=()=>{setEditing(false);setError('');setDraft(value);requestAnimationFrame(()=>editButtonRef.current?.focus());};
  const save=async()=>{
    const checked=validateDeviceName(draft);if(!checked.ok){setError(checked.error);return;}
    if(checked.value===(confirmed??value)){cancel();return;}
    setError('');setPending(checked.value);setEditing(false);
    try{await onSave(checked.value);if(!mountedRef.current)return;setConfirmed(checked.value);setPending(null);}
    catch(reason){if(!mountedRef.current)return;setPending(null);setDraft(checked.value);setError(reason instanceof Error?reason.message:String(reason));setEditing(true);}
  };
  if(editing)return <div className={className} data-testid={`${testIdPrefix}-editor`}>
    <div className="flex flex-wrap items-center gap-1.5">
      <input ref={inputRef} autoFocus aria-label={editLabel} aria-invalid={error?true:undefined} data-testid={`${testIdPrefix}-input`}
        className="portal-field min-h-9 min-w-0 flex-1" style={{minWidth:160}} placeholder={placeholder} maxLength={DEVICE_NAME_MAX_LENGTH*2}
        value={draft} onChange={event=>{setDraft(event.target.value);if(error)setError('');}}
        onKeyDown={event=>{if(event.key==='Enter'&&!event.nativeEvent.isComposing){event.preventDefault();void save();}if(event.key==='Escape'){event.preventDefault();event.stopPropagation();cancel();}}}/>
      <button type="button" data-testid={`${testIdPrefix}-save`} onClick={()=>void save()} className="portal-mini-button inline-flex min-h-9 items-center gap-1"><Check className="h-3.5 w-3.5" aria-hidden="true"/>저장</button>
      <button type="button" data-testid={`${testIdPrefix}-cancel`} onClick={cancel} className="portal-mini-button inline-flex min-h-9 items-center gap-1"><X className="h-3.5 w-3.5" aria-hidden="true"/>취소</button>
    </div>
    {error?<p role="alert" data-testid={`${testIdPrefix}-error`} className="mb-0 mt-1 text-[11px] text-[color:var(--danger)]">{error}</p>:<p className="mb-0 mt-1 text-[11px] text-[color:var(--ink-3)]">{hint??`${DEVICE_NAME_MAX_LENGTH}자 이하 · Enter 저장 · Esc 취소`}</p>}
  </div>;
  return <div className={className}>
    <div className="flex min-w-0 items-center gap-1.5">
      <span data-testid={`${testIdPrefix}-value`} className={`min-w-0 truncate ${nameClassName??''}`} title={shown||emptyLabel}>{shown||emptyLabel}</span>{suffix}
      {pending!==null?<Loader2 data-testid={`${testIdPrefix}-saving`} className="h-3.5 w-3.5 shrink-0 animate-spin text-[color:var(--ink-3)]" aria-label="이름 저장 중"/>:
       <button ref={editButtonRef} type="button" data-testid={`${testIdPrefix}-edit`} aria-label={editLabel} title={editLabel} disabled={disabled}
         onClick={()=>{setDraft(shown);setError('');setEditing(true);}} className="inline-flex min-h-8 min-w-8 shrink-0 items-center justify-center rounded text-[color:var(--ink-3)] hover:text-[color:var(--ink)] disabled:opacity-40"><Pencil className="h-3.5 w-3.5" aria-hidden="true"/></button>}
    </div>
    {error&&<p role="alert" data-testid={`${testIdPrefix}-error`} className="mb-0 mt-1 text-[11px] text-[color:var(--danger)]">{error}</p>}
  </div>;
}
