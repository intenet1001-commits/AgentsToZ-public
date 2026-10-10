import type {MobileTesterRun} from './mobileTesterProtocol';
export interface TesterOverviewRequest {offset?:number; revision?:string}
export interface TesterOverviewEntry {projectId:string;name:string;state:'observed'|'not-configured'|'no-result'|'unavailable';run:MobileTesterRun|null}
export interface TesterOverview {hostName:string;checkedAt:string;revision:string;entries:TesterOverviewEntry[];total:number;nextOffset:number|null;complete:boolean}
export function parseTesterOverviewRequest(v:unknown):TesterOverviewRequest {
  const r=v as TesterOverviewRequest;
  if(!r||typeof r!=='object'||Array.isArray(r)||Object.keys(r).some(k=>!['offset','revision'].includes(k))||r.offset!==undefined&&(!Number.isSafeInteger(r.offset)||r.offset<0||r.offset>100000)||r.revision!==undefined&&(typeof r.revision!=='string'||!/^[a-f0-9]{64}$/.test(r.revision))||(r.offset??0)>0&&!r.revision)throw new Error('테스터 현황 페이지를 다시 확인하세요.');
  return r;
}
