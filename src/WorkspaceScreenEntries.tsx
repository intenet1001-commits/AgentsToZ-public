import {isTauri} from '@tauri-apps/api/core';
import {Monitor,MonitorSmartphone} from 'lucide-react';
import {workModeCopy,workspaceToolsCopy,type Lang} from './i18n';
import {screenHelperLines} from './workModeScreenHelper';
import {useScreenHelper} from './useScreenHelper';
import {useViewerHelper,viewerHelperLines} from './useViewerHelper';
import {useWorkspaceToolsOpen} from './components/WorkspaceTools';

/** Opens the signed helper's UI only. It neither chooses a remote Mac nor starts a screen session. */
export function WorkspaceScreenEntries({lang}:{lang:Lang}){
  const open=useWorkspaceToolsOpen();
  return open&&isTauri()?<MountedScreenEntries lang={lang}/>:null;
}
function MountedScreenEntries({lang}:{lang:Lang}){
  const copy=workModeCopy(lang),labels=workspaceToolsCopy(lang);
  const screen=useScreenHelper(copy.screenUnverified),viewer=useViewerHelper(copy.viewerUnverified);
  const screenLines=screen.status?screenHelperLines(screen.status,copy):null;
  const viewerLines=viewerHelperLines(viewer.status,copy);
  const screenVisible=screen.status===null || screen.status.supported || screen.statusFailed;
  const viewerVisible=viewer.status===null || !!viewerLines || viewer.statusFailed;
  return <>
    {screenVisible&&<div className="workspace-screen-entry" data-testid="workspace-screen-entry">
      <strong><MonitorSmartphone size={15} aria-hidden="true"/>{labels.currentMac}</strong>
      <p data-testid="workspace-screen-status">{screenLines?.line??(screen.statusFailed?copy.screenInstanceUnknown:copy.checking)}</p>
      {screenLines?.notes.map(note=><p key={note}>{note}</p>)}
      {screenLines?.canOpen&&<button type="button" data-testid="workspace-screen-open" disabled={screen.opening} onClick={()=>void screen.open()}>{screen.opening?copy.screenOpening:copy.screenOpen}</button>}
      {screen.note&&<p role="status">{screen.note}</p>}{screen.error&&<p role="alert">{screen.error}</p>}
    </div>}
    {viewerVisible&&<div className="workspace-screen-entry" data-testid="workspace-viewer-entry">
      <strong><Monitor size={15} aria-hidden="true"/>{labels.otherMac}</strong>
      <p data-testid="workspace-viewer-status">{viewerLines?.line??(viewer.statusFailed?copy.viewerInstanceUnknown:copy.checking)}</p>
      {viewerLines?.notes.map(note=><p key={note}>{note}</p>)}
      {viewer.status&&<button type="button" data-testid="workspace-viewer-open" disabled={viewer.opening||viewer.status.otherInstanceRunning||viewer.status.instanceStatusUnknown} onClick={()=>void viewer.open()}>{viewer.opening?copy.viewerOpening:copy.viewerOpen}</button>}
      {viewer.note&&<p role="status">{viewer.note}</p>}{viewer.error&&<p role="alert">{viewer.error}</p>}
    </div>}
  </>;
}
