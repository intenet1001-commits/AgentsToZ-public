import React from 'react';
import {createRoot} from 'react-dom/client';
import '../../src/appearanceTokens.css';
import {WorkroomTeamStatus} from '../../src/WorkroomTeamStatus';

// The 팀 현황 strip alone, as the Workroom mounts it above a session: the test server answers the panel route.
const f=window as any;f.opened=[];
const query=new URLSearchParams(location.search),sessionId=query.get('session')??'leader-1',listed=new Set((query.get('listed')??'leader-1,s-1,s-2').split(','));
createRoot(document.getElementById('root')!).render(<div style={{padding:8}}><WorkroomTeamStatus sessionId={sessionId} visible openable={id=>listed.has(id)} onOpen={id=>f.opened.push(id)}/><p data-testid="below">터미널</p></div>);
