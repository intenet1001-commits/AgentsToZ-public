import {useEffect,useRef,type CSSProperties} from 'react';
import {Globe} from 'lucide-react';
import {WorkspaceTools} from './components/WorkspaceTools';
import './ProjectBrowserLauncher.css';

/** One default browser action; existing terminal-owned previews stay in its options. */
export function ProjectBrowserLauncher({disabled=false,onOpen,onCmux,onOrca,style,title,
  'data-testid':testId,'data-worktree-path':worktreePath}: {
  disabled?:boolean;onOpen:()=>unknown;onCmux?:()=>unknown;onOrca?:()=>unknown;
  style?:CSSProperties;title?:string;'data-testid':string;'data-worktree-path'?:string;
}) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(()=>{
    let frame = 0;
    const fit = () => {
      const holder = root.current;
      const panel = holder?.querySelector<HTMLElement>('details[open] > .workspace-tools-panel');
      if (!holder || !panel) return;
      const anchor = holder.getBoundingClientRect(), scale = anchor.width / holder.offsetWidth;
      if (!scale) return;
      let left=8,right=innerWidth-8,top=8,bottom=innerHeight-8;
      for(let parent=holder.parentElement;parent;parent=parent.parentElement){
        const css=getComputedStyle(parent),bounds=parent.getBoundingClientRect();
        if(['auto','scroll','hidden','clip'].includes(css.overflowX)){left=Math.max(left,bounds.left);right=Math.min(right,bounds.right);}
        if(['auto','scroll','hidden','clip'].includes(css.overflowY)){top=Math.max(top,bounds.top);bottom=Math.min(bottom,bounds.bottom);}
      }
      const below=bottom-anchor.bottom-6,above=anchor.top-top-6;
      const upward=below<panel.scrollHeight*scale&&above>below;
      panel.style.top=upward?'auto':'calc(100% + 6px)';
      panel.style.bottom=upward?'calc(100% + 6px)':'auto';
      panel.style.maxHeight=`${Math.max(0,upward?above:below)/scale}px`;
      panel.style.maxWidth=`${Math.max(0,right-left)/scale}px`;
      const width=panel.getBoundingClientRect().width;
      panel.style.left=`${(Math.max(left,Math.min(anchor.left,right-width))-anchor.left)/scale}px`;
    };
    const schedule=()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(fit);};
    root.current?.addEventListener('toggle',schedule,true);
    window.addEventListener('resize',schedule);document.addEventListener('scroll',schedule,true);
    const holder=root.current;
    return()=>{cancelAnimationFrame(frame);holder?.removeEventListener('toggle',schedule,true);window.removeEventListener('resize',schedule);document.removeEventListener('scroll',schedule,true);};
  },[]);
  return <div ref={root} className="project-browser-launcher" onClick={event=>event.stopPropagation()}>
    <button type="button" data-testid={testId} data-worktree-path={worktreePath}
      disabled={disabled} onClick={()=>onOpen()} style={style} title={title}>
      <Globe aria-hidden="true" style={{width:11,height:11}}/>브라우저
    </button>
    {(onCmux||onOrca)&&<WorkspaceTools label="브라우저 실행 옵션" compact>
      <p className="project-browser-settings-hint">기본 브라우저는 앱 설정에서 변경할 수 있습니다.</p>
      {onCmux&&<button type="button" disabled={disabled} onClick={event=>{
        event.currentTarget.closest('details')?.removeAttribute('open');onCmux();
      }}>cmux에서 열기</button>}
      {onOrca&&<button type="button" disabled={disabled} onClick={event=>{
        event.currentTarget.closest('details')?.removeAttribute('open');onOrca();
      }}>Orca에서 열기</button>}
    </WorkspaceTools>}
  </div>;
}
