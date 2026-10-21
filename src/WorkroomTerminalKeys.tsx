import React,{useEffect,useId,useRef,useState} from 'react';
import {createPortal} from 'react-dom';

/** Number buttons send exactly one keystroke. Some CLIs immediately submit it; Enter remains explicit. */
export function workroomChoiceInput(number:string){
 if(!/^[0-9]$/.test(number))throw Error('선택 번호를 확인하세요.');
 return number;
}
export function WorkroomTerminalKeys({sessionId,disabled,rawInputDisabled,rawInput,onToggleRaw,onSend,appCursor}:{sessionId:string;disabled:boolean;rawInputDisabled:boolean;rawInput:boolean;onToggleRaw:()=>void;onSend:(data:string)=>boolean;appCursor:()=>boolean}){
 const [more,setMore]=useState(false),dialog=useRef<HTMLDialogElement>(null),trigger=useRef<HTMLButtonElement>(null),id=useId();
 useEffect(()=>{setMore(false);},[sessionId,disabled]);
 useEffect(()=>{if(more)dialog.current?.showModal();},[more]);
 const close=()=>{dialog.current?.close();setMore(false);trigger.current?.focus({preventScroll:true});};
 const choose=(number:string)=>{onSend(workroomChoiceInput(number));close();};
 const keys=['Esc','Tab','←','→','↑','↓','Ctrl+C','Ctrl+L','Ctrl+U','Enter'];
 const data=(key:string)=>({Esc:'\x1b',Tab:'\t','←':(appCursor()?'\x1bO':'\x1b[')+'D','→':(appCursor()?'\x1bO':'\x1b[')+'C','↑':(appCursor()?'\x1bO':'\x1b[')+'A','↓':(appCursor()?'\x1bO':'\x1b[')+'B','Ctrl+C':'\x03','Ctrl+L':'\x0c','Ctrl+U':'\x15',Enter:'\r'} as Record<string,string>)[key]!;
 return <div className="ai-terminal-keys" role="group" aria-label="터미널 키">
  {['1','2','3'].map(number=><button type="button" key={number} className="ai-terminal-key" disabled={disabled} title={number+' 입력'} onClick={()=>onSend(workroomChoiceInput(number))}>{number}</button>)}
  <button type="button" ref={trigger} className="ai-terminal-key" disabled={disabled} aria-haspopup="dialog" aria-expanded={more} onClick={()=>setMore(true)}>더보기</button>
  <button type="button" className="ai-terminal-key" aria-pressed={rawInput} disabled={rawInputDisabled} onClick={onToggleRaw}>{rawInput?'직접 입력 끄기':'터미널 직접 입력'}</button>
  {keys.map(key=><button type="button" key={key} className="ai-terminal-key" disabled={disabled} onClick={()=>onSend(data(key))}>{key}</button>)}
  {more&&createPortal(<dialog ref={dialog} className="workroom-number-dialog" aria-labelledby={id+'-title'} aria-describedby={id+'-hint'} onCancel={event=>{event.preventDefault();close();}} onClose={()=>setMore(false)} onKeyDown={event=>event.stopPropagation()} onClick={event=>{if(event.target===event.currentTarget)close();}}>
   <div className="workroom-number-content"><h3 id={id+'-title'}>숫자 선택</h3><p id={id+'-hint'}>번호를 한 번 전송합니다. 확정이 필요하면 Enter를 누르세요.</p>
    <div className="workroom-number-grid">{['4','5','6','7','8','9','0'].map(number=><button type="button" key={number} disabled={disabled} title={number+' 입력'} onClick={()=>choose(number)}>{number}</button>)}</div>
    <button type="button" className="workroom-number-close" onClick={close}>닫기</button>
   </div>
  </dialog>,document.body)}
 </div>;
}
