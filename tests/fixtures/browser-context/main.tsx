import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {BrowserContextPanel} from '../../../src/BrowserContextPanel';
import {localBrowserContextRequest} from '../../../src/browserContextClient';
const state=(window as any).__browserFixture={attachments:[] as unknown[],closed:0};
function Fixture(){const [open,setOpen]=useState(true);return <><button id="reopen" onClick={event=>{event.currentTarget.focus();setOpen(true);}}>Reopen</button>{open&&<BrowserContextPanel lang={location.search.includes('ko')?'ko':'en'} request={location.search.includes('missing')?undefined:localBrowserContextRequest} projects={[{id:'alpha',label:'Alpha'},{id:'beta',label:'Beta'}]} defaultProjectId="alpha" onClose={()=>{state.closed++;setOpen(false);}} onAttach={(targetId,text)=>state.attachments.push({targetId,text})}/>}</>;}
createRoot(document.getElementById('root')!).render(<Fixture/>);
