import type {IncrementalMemoryObservationResult} from './memorySaveIncrementalObservation';
export interface MemoryObservationProject {id:string;projectRoot:string}
export interface MemoryObservationCandidate {key:string;stamp:string;agent:'codex'|'claude';path:string;transcriptRoot:string;sessionId:string}
export interface ResolvedMemoryObservationProject extends MemoryObservationProject {memoryId:string;validateRegistration:()=>Promise<boolean>}
/** One source slice per existing host tick; no timer or model execution authority. */
export class MemoryObservationCoordinator {
  #running=false;
  #after:string|null=null;
  #preferHint=true;
  #hints=new Set<string>();
  #sourceState=new Map<string,{stamp:string;retryAt:number}>();
  #projectState=new Map<string,{after:string|null;retryAt:number}>();
  #last:{projectId:string;agent:'codex'|'claude'|null;reason:string;observed:number}|null=null;
  constructor(private deps:{
    enabled:()=>boolean;
    projects:()=>Promise<MemoryObservationProject[]>;
    resolve:(project:MemoryObservationProject)=>Promise<ResolvedMemoryObservationProject|null>;
    discover:(project:ResolvedMemoryObservationProject)=>Promise<MemoryObservationCandidate[]>;
    observe:(project:ResolvedMemoryObservationProject,source:MemoryObservationCandidate)=>Promise<IncrementalMemoryObservationResult>;
    now?:()=>number;
  }){}
  request(root:string):void {
    if(!this.deps.enabled()||!root||root.length>4096||/[\0\r\n]/.test(root))return;
    if(this.#hints.size>=64&&!this.#hints.has(root))this.#hints.delete(this.#hints.values().next().value!);
    this.#hints.add(root);
  }
  status(){return {running:this.#running,queuedHints:this.#hints.size,trackedSources:this.#sourceState.size,trackedProjects:this.#projectState.size,last:this.#last?{...this.#last}:null};}
  #boundedSet<T>(map:Map<string,T>,key:string,value:T,limit:number){map.delete(key);map.set(key,value);while(map.size>limit)map.delete(map.keys().next().value!);}
  async tick():Promise<void>{
    if(this.#running)return;
    if(!this.deps.enabled()){this.#hints.clear();this.#sourceState.clear();this.#projectState.clear();return;}
    this.#running=true;
    let selected:MemoryObservationProject|undefined;
    const now=()=>this.deps.now?.()??Date.now();
    try{
      const projects=(await this.deps.projects()).sort((a,b)=>a.id.localeCompare(b.id));
      if(!this.deps.enabled())return;
      const ready=projects.filter(p=>(this.#projectState.get(p.id)?.retryAt??0)<=now());
      const regular=ready.find(p=>this.#after===null||p.id.localeCompare(this.#after)>0)??ready[0];
      let hinted:MemoryObservationProject|undefined;
      for(const root of this.#hints){
        const project=projects.find(p=>p.projectRoot===root);
        if(!project){this.#hints.delete(root);continue;}
        if(ready.includes(project)){hinted=project;break;}
      }
      const useHint=this.#preferHint&&!!hinted;
      selected=useHint?hinted:regular;
      if(!selected)return;
      if(useHint)this.#hints.delete(selected.projectRoot);else this.#after=selected.id;
      this.#preferHint=!useHint;
      const project=await this.deps.resolve(selected);
      if(!this.deps.enabled())return;
      if(!project){this.#boundedSet(this.#projectState,selected.id,{after:null,retryAt:now()+300_000},128);return;}
      const candidates=(await this.deps.discover(project)).slice(0,32).sort((a,b)=>a.key.localeCompare(b.key));
      if(!this.deps.enabled()||!await project.validateRegistration()||!this.deps.enabled())return;
      const stateKey=(source:MemoryObservationCandidate)=>`${project.id}\0${source.key}`;
      const eligible=candidates.filter(source=>{const state=this.#sourceState.get(stateKey(source));return !state||state.stamp!==source.stamp||state.retryAt<=now();});
      const after=this.#projectState.get(project.id)?.after;
      const source=eligible.find(s=>!after||s.key.localeCompare(after)>0)??eligible[0];
      if(!source)return;
      this.#boundedSet(this.#projectState,project.id,{after:source.key,retryAt:0},128);
      let reason:string,observed=0;
      try{const result=await this.deps.observe(project,source);reason=result.reason;observed=result.observed;}
      catch{reason='unavailable';}
      const delay=reason==='more'?0:['observed','incomplete','source-changed'].includes(reason)?60_000:300_000;
      this.#boundedSet(this.#sourceState,stateKey(source),{stamp:source.stamp,retryAt:now()+delay},256);
      this.#last={projectId:project.id,agent:source.agent,reason,observed};
      if(reason==='more')this.request(project.projectRoot);
    }catch{
      if(selected){this.#boundedSet(this.#projectState,selected.id,{after:null,retryAt:now()+300_000},128);this.#last={projectId:selected.id,agent:null,reason:'unavailable',observed:0};}
    }finally{this.#running=false;}
  }
}
