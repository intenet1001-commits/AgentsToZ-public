import type {TesterRequest,TesterResult,TesterSets,TesterTarget} from './testerAgentContract';
import {testerRequest} from './testerAgentClient';
export interface TesterSetsSnapshot {data?:TesterSets;error?:string;loading:boolean}
type Entry={target:TesterTarget;snapshot:TesterSetsSnapshot;listeners:Set<(s:TesterSetsSnapshot)=>void>;loadedAt:number;generation:number;queued:boolean;running:boolean};
const key=(t:TesterTarget)=>t.portId+'\0'+(t.workspaceTargetId??'');
/** On-demand, two reads at once, bounded cache/queue; hidden rows unsubscribe. No polling. */
export class TesterSetsCache {
  private entries=new Map<string,Entry>();private queue:Entry[]=[];private active=0;
  constructor(private transport:(r:TesterRequest)=>Promise<TesterResult>,private now=()=>Date.now()){}
  watch(target:TesterTarget,listener:(s:TesterSetsSnapshot)=>void){
    const id=key(target);let entry=this.entries.get(id);
    if(!entry){
      this.trim();
      if(this.entries.size>=64){const idle=[...this.entries].find(([,e])=>!e.listeners.size&&!e.running&&!e.queued);if(idle)this.entries.delete(idle[0]);else{listener({loading:false,error:'표시할 프로젝트가 많습니다. 프로젝트를 선택해 구성을 확인하세요.'});return ()=>{};}}
      entry={target,snapshot:{loading:true},listeners:new Set(),loadedAt:0,generation:0,queued:false,running:false};this.entries.set(id,entry);}
    this.entries.delete(id);this.entries.set(id,entry);entry.listeners.add(listener);listener(entry.snapshot);
    if(!entry.loadedAt||this.now()-entry.loadedAt>30_000)this.enqueue(entry);
    this.trim();
    return ()=>{entry!.listeners.delete(listener);if(!entry!.listeners.size&&entry!.queued){entry!.queued=false;this.queue=this.queue.filter(e=>e!==entry);}this.trim();};
  }
  refresh(target:TesterTarget){const entry=this.entries.get(key(target));if(entry){entry.loadedAt=0;entry.generation++;if(entry.listeners.size)this.enqueue(entry);}}
  private publish(entry:Entry){for(const listener of entry.listeners)listener(entry.snapshot);}
  private enqueue(entry:Entry){
    if(entry.queued||entry.running)return;
    if(this.queue.length>=64){entry.snapshot={...entry.snapshot,loading:false,error:'구성 조회가 많습니다. 프로젝트를 선택해 다시 확인하세요.'};this.publish(entry);return;}
    entry.queued=true;entry.snapshot={...entry.snapshot,loading:true,error:undefined};this.queue.push(entry);this.publish(entry);this.pump();
  }
  private pump(){
    while(this.active<2&&this.queue.length){
      const entry=this.queue.shift()!;entry.queued=false;if(!entry.listeners.size)continue;
      const generation=entry.generation;entry.running=true;this.active++;
      void this.transport({...entry.target,operation:'sets'}).then(result=>{
        if(!result.sets)throw Error('이 호스트의 테스트 세트 구성 조회를 확인하지 못했습니다. 앱 업데이트가 필요할 수 있습니다.');
        if(generation!==entry.generation)return;
        entry.snapshot={data:result.sets,loading:false};entry.loadedAt=this.now();
      }).catch(e=>{if(generation===entry.generation){entry.snapshot={...entry.snapshot,loading:false,error:e instanceof Error?e.message:'구성 조회를 확인하지 못했습니다.'};entry.loadedAt=this.now();}}).finally(()=>{
        entry.running=false;this.active--;if(generation!==entry.generation&&entry.listeners.size)this.enqueue(entry);else this.publish(entry);this.trim();this.pump();
      });
    }
  }
  private trim(){
    let bytes=0;for(const entry of this.entries.values())bytes+=JSON.stringify(entry.snapshot).length*2;
    for(const [id,entry] of this.entries){if(this.entries.size<=64&&bytes<=4_000_000)break;if(entry.listeners.size||entry.running||entry.queued)continue;bytes-=JSON.stringify(entry.snapshot).length*2;this.entries.delete(id);}
    // Large snapshots may remain in the visible component, but are not retained as cache history.
    if(bytes>4_000_000)for(const entry of this.entries.values()){if(bytes<=4_000_000)break;if(entry.running||!entry.snapshot.data)continue;bytes-=JSON.stringify(entry.snapshot).length*2;entry.snapshot={loading:false};entry.loadedAt=0;}
  }
}
export const testerSetsCache=new TesterSetsCache(testerRequest);
