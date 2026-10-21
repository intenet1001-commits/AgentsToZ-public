import {createHash} from 'node:crypto';
import {redactWhatISaidForFeed} from './whatISaidRedaction';
import {CORRECTION_OUTCOME_PROTOCOL,type CorrectionRelatednessCounts} from './projectMemoryCorrectionOutcome';
export interface CorrectionTaskExposure {
 memoryId:string;contextHash:string;sourceWithheld:boolean;
 /** The outcome protocol the relatedness counts were taken for; absent on exposures recorded before it existed. */
 protocolVersion?:number;
 /** relatedness: query-term counts only (never the terms) — the task text must not enter the durable receipt. */
 entries:{entryKey:string;contentVersionHash:string;reportIds:string[];relatedness?:CorrectionRelatednessCounts}[];
}
export interface CorrectionTaskGuidance {text:string;exposure:CorrectionTaskExposure;validate():void}
type CorrectionRecall={memoryId:string;correctionSearch?:{complete:boolean};corrections:{entryKey:string;contentVersionHash:string;title:string;relatedness?:CorrectionRelatednessCounts;reports:{eventId?:string;kind:string;evidence:string;recordedAt:string}[]}[]};
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** The id an exposure records for a delivered report; outcome matching uses the identical hash. */
export const correctionReportId=(eventId:string)=>hash(eventId);
/** Reported corrections are context, never promoted instructions or proof that a later task succeeded. */
export function buildCorrectionTaskGuidance(result:CorrectionRecall):Omit<CorrectionTaskGuidance,'validate'>|null {
 if(result.correctionSearch?.complete===false)throw Error('교정 기록을 읽지 못해 요청을 보내지 않았습니다. 교정 기록을 확인한 뒤 다시 시도하세요.');
 const corrections=result.corrections.slice(0,3);if(!corrections.length)return null;
 const entries=corrections.map(c=>({entryKey:c.entryKey,contentVersionHash:c.contentVersionHash,reportIds:c.reports.slice(-3).map(r=>r.eventId!==undefined?correctionReportId(r.eventId):hash(r))}));
 const lines=corrections.map(c=>c.reports.filter(r=>r.kind==='corrected'||r.kind==='contradicted').slice(-2).map(r=>r.evidence).join(' / '));
 const raw='[관련 프로젝트 교정 · 사용자가 보고한 실패 원인과 다음 처리입니다. 원래 지침의 정답 인증이 아니며 현재 요청과 맞는지 확인하세요.]\n'+lines.map((line,i)=>`${i+1}. ${corrections[i]!.title}: ${line}`).join('\n')+'\n[교정 문맥 끝]';
 const redacted=redactWhatISaidForFeed(raw,6000);
 const text=(redacted.text??'[관련 프로젝트 교정 원문에 민감한 정보가 있어 자동 포함을 보류했습니다. 로컬 교정 화면에서 실패 원인과 다음 처리를 확인하세요.]').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g,'');
 // The context hash covers what was shown, not the relatedness counts, so it is unchanged from before they existed.
 const counted=entries.map((entry,i)=>corrections[i]!.relatedness?{...entry,relatedness:corrections[i]!.relatedness}:entry);
 const related=corrections.some(c=>c.relatedness);
 return {text,exposure:{memoryId:result.memoryId,contextHash:hash([entries,text]),sourceWithheld:redacted.withheld,...(related?{protocolVersion:CORRECTION_OUTCOME_PROTOCOL.version}:{}),entries:counted}};
}
