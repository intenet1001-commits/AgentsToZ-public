export const IMPROVEMENT_STAGES=['observed','changed','rechecked'] as const;
export const IMPROVEMENT_SURFACES=['mac','iphone13','browser'] as const;
export const IMPROVEMENT_LANES=['installed','native-fixture','browser-fixture'] as const;
export interface TesterImprovementInput {
 requestId:string;expectedRevision:number;persona:string;scenario:string;expected:string;note:string;
 stage:typeof IMPROVEMENT_STAGES[number];outcome?:'clear'|'confusing'|'blocked';
 surface:typeof IMPROVEMENT_SURFACES[number];lane:typeof IMPROVEMENT_LANES[number];version:string;
 evidence?:string;checkId?:string;runId?:string;
}
export interface TesterImprovementEvent extends TesterImprovementInput {at:string}
export interface TesterImprovement {
 id:string;revision:number;persona:string;scenario:string;expected:string;firstSeenAt:string;updatedAt:string;
 observations:number;changes:number;rechecks:number;stage:TesterImprovementInput['stage'];outcome?:TesterImprovementInput['outcome'];
 events:TesterImprovementEvent[];receipts:{id:string;digest:string}[];
}
export interface TesterImprovements {schemaVersion:1;items:TesterImprovement[];limit:number;class:'exploratory/observed';verdict:null}
export function parseTesterImprovement(input:unknown):TesterImprovementInput {
 const v=input as TesterImprovementInput;
 const text=(s:unknown,max:number)=>typeof s==='string'&&!!s.trim()&&s.length<=max&&!/[\x00-\x08\x0b-\x1f]/.test(s);
 const fail=()=>{throw Error('개선 시나리오의 입력을 확인하세요.');};
 if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!['requestId','expectedRevision','persona','scenario','expected','note','stage','outcome','surface','lane','version','evidence','checkId','runId'].includes(k)))return fail();
 if(!text(v.requestId,96)||!/^[-a-zA-Z0-9_]{8,96}$/.test(v.requestId)||!Number.isSafeInteger(v.expectedRevision)||v.expectedRevision<0||!text(v.persona,120)||!text(v.scenario,180)||!text(v.expected,400)||!text(v.note,500)||!text(v.version,80)||!IMPROVEMENT_STAGES.includes(v.stage)||!IMPROVEMENT_SURFACES.includes(v.surface)||!IMPROVEMENT_LANES.includes(v.lane))return fail();
 if(v.stage==='rechecked'?!['clear','confusing','blocked'].includes(v.outcome!):v.outcome!==undefined)return fail();
 if(v.evidence!==undefined&&(!text(v.evidence,240)||v.evidence.startsWith('/')||v.evidence.includes('\\')||v.evidence.split('/').some(p=>!p||p==='.'||p==='..')||/^[A-Za-z]:/.test(v.evidence)))return fail();
 if(v.checkId!==undefined&&!/^[a-z0-9][a-z0-9-]{0,63}$/.test(v.checkId)||v.runId!==undefined&&!/^\d{8}T\d{6}Z-[a-f0-9]{8}$/.test(v.runId))return fail();
 return {...v,persona:v.persona.trim().normalize('NFC').replace(/\s+/g,' '),scenario:v.scenario.trim().normalize('NFC').replace(/\s+/g,' ')};
}
