import type {NativeCommunityMobileIdentity} from './communityMobileNativeIdentity';
import type {CommunityMobileControlHost} from './communityMobileControlHost';

type Instance={identity:Pick<NativeCommunityMobileIdentity,'ended'|'close'>;host:Pick<CommunityMobileControlHost,'start'|'close'|'status'>};
/** Recreate a fenced Native lineage, never an old command. Initial enrollment can be completed in place. */
export class CommunityMobileRuntime {
  private instance?:Instance;private timer?:ReturnType<typeof setInterval>;private pending?:Promise<void>;private closed=false;
  constructor(private readonly create:()=>Instance){}
  status(){return this.instance?.host.status()??{phase:'unsupported',closed:this.closed,pendingHandshakes:0,activeChannels:0,purposes:[]};}
  async refresh():Promise<void>{
    if(this.closed)return;if(this.pending)return this.pending;
    const task=(async()=>{
      if(this.instance?.identity.ended){this.instance.host.close();this.instance.identity.close();this.instance=undefined;}
      if(!this.instance){this.instance=this.create();await this.instance.host.start();}
    })();this.pending=task;try{await task;}finally{if(this.pending===task)this.pending=undefined;}
  }
  async start():Promise<void>{if(this.closed)return;if(!this.timer){this.timer=setInterval(()=>{void this.refresh().catch(()=>{});},15_000);this.timer.unref?.();}await this.refresh();}
  close(){if(this.closed)return;this.closed=true;if(this.timer)clearInterval(this.timer);this.instance?.host.close();this.instance?.identity.close();}
}
