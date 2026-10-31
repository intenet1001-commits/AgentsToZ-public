import React,{useId,useState,type ReactNode} from 'react';

/**
 * Folding pieces of 아젠투지 설정 (docs/design/agentstoz-settings-2026-10-26.md): a purpose section that folds under its
 * heading, and a memory candidate shown as a title and a preview whose full text is read before it can be saved.
 * Browser-safe and request-free; ControlProfilePanel owns the data and every action.
 */
const button='min-h-11 rounded-xl border border-[var(--line)] px-4 py-2 text-sm disabled:opacity-50';

/**
 * A WAI-ARIA disclosure under an h3. The heading's button carries exactly the section title (the 펼치기/접기 cue is
 * aria-hidden, aria-expanded says the state), `summary` stays visible while folded so a count, an error or a needed
 * action is never behind the fold, and the body stays in the DOM (`hidden`) — component state and the panel's document
 * order survive a fold. With nothing to open (`foldable={false}`) the title is a plain heading and the body shows.
 */
export function FoldSection({id,title,open,onToggle,summary,children,testId,foldable=true}:{
 id:string;title:string;open:boolean;onToggle:()=>void;summary?:ReactNode;children?:ReactNode;testId?:string;foldable?:boolean}){
 return <section data-testid={testId} aria-labelledby={`${id}-heading`} className="mt-4 border-t border-[var(--line)] pt-2">
  <h3 id={`${id}-heading`} className="font-bold">{foldable
   ?<button type="button" id={`${id}-toggle`} aria-expanded={open} aria-controls={`${id}-body`} onClick={onToggle} className="flex min-h-11 w-full items-center justify-between gap-3 rounded-lg text-left">
     <span className="min-w-0 break-words">{title}</span>
     <span aria-hidden="true" className="shrink-0 text-xs font-normal text-[var(--ink-3)]">{open?'접기':'펼치기'}</span>
    </button>
   :<span className="flex min-h-11 items-center break-words">{title}</span>}</h3>
  {summary}
  {foldable?<div id={`${id}-body`} hidden={!open}>{children}</div>:children}
 </section>;
}

const segmenter=typeof Intl.Segmenter==='function'?new Intl.Segmenter('ko',{granularity:'grapheme'}):null;
/** Hangul syllables, emoji sequences and combining marks each count, and are cut, as one character. */
const characters=(text:string)=>segmenter?Array.from(segmenter.segment(text),part=>part.segment):Array.from(text);
export const CANDIDATE_PREVIEW={chars:120,lines:3,evidenceChars:80} as const;

/** The first `lines` lines and at most `chars` characters of `text`, whether anything was left out, and its length. */
export function previewText(text:string,chars:number,lines:number):{text:string;truncated:boolean;length:number}{
 const rows=text.split('\n');
 let kept=characters(rows.slice(0,lines).join('\n')),truncated=rows.length>lines;
 if(kept.length>chars){kept=kept.slice(0,chars);truncated=true;}
 return {text:truncated?`${kept.join('').trimEnd()}…`:text,truncated,length:characters(text).length};
}

export type CandidateView={id:string;title:string;body:string;evidence:string};

/**
 * A memory candidate waiting for a person. A long one opens as its title and a preview; the full body and evidence open
 * in place, and saving stays off until the full text has been shown — a saved entry is only appended and this screen
 * has no way to correct it (docs/control-profile.md). What was shown is tied to the exact text: if the candidate's text
 * changes, it folds and must be read again. Excluding never needs the full text. The save and exclude buttons keep
 * their names, and the panel sends the same reviewed request as before.
 */
export function CandidateCard({candidate,busy,saveDisabled,onSave,onReject}:{
 candidate:CandidateView;busy:boolean;saveDisabled:boolean;onSave:()=>void;onReject:()=>void}){
 const id=useId(),text=`${candidate.title}\u0000${candidate.body}\u0000${candidate.evidence}`;
 const [openText,setOpenText]=useState<string|null>(null),[seenText,setSeenText]=useState<string|null>(null);
 const body=previewText(candidate.body,CANDIDATE_PREVIEW.chars,CANDIDATE_PREVIEW.lines);
 const evidence=previewText(candidate.evidence,CANDIDATE_PREVIEW.evidenceChars,1);
 const folds=body.truncated||evidence.truncated,open=openText===text,full=open||!folds,gated=folds&&seenText!==text;
 return <article data-testid="control-profile-candidate" data-candidate-id={candidate.id} className="mt-3 rounded-xl border border-[var(--line)] p-3">
  <h4 className="break-words font-semibold">{candidate.title}</h4>
  <div id={`${id}-text`}>
   <p className="mt-2 whitespace-pre-wrap break-words text-sm">{full?candidate.body:body.text}</p>
   <p className="mt-2 whitespace-pre-wrap break-words text-xs">근거: {full?candidate.evidence:evidence.text}</p>
  </div>
  {gated&&<p id={`${id}-gate`} data-testid="control-profile-candidate-gate" className="mt-2 text-xs text-[var(--ink-3)]">전체 내용을 펼쳐 확인한 뒤 저장할 수 있습니다.</p>}
  <div className="mt-3 flex flex-wrap gap-2">
   {folds&&<button type="button" data-testid="control-profile-candidate-toggle" className={button} aria-expanded={open} aria-controls={`${id}-text`}
    onClick={()=>{if(open){setOpenText(null);return;}setOpenText(text);setSeenText(text);}}>{open?'접기':body.truncated?`전체 보기 · ${body.length}자`:'근거 전체 보기'}</button>}
   <button type="button" className={button} disabled={busy||saveDisabled||gated} aria-describedby={gated?`${id}-gate`:undefined} onClick={onSave}>운영 기억에 저장</button>
   <button type="button" className={button} disabled={busy} onClick={onReject}>제외</button>
  </div>
 </article>;
}
