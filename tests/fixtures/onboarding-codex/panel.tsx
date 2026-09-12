import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import OnboardingPreparation from '../../../src/OnboardingPreparation';
function Fixture(){const [opened,setOpened]=useState(0);return <><OnboardingPreparation onOpenFirstTask={()=>setOpened(n=>n+1)}/><output aria-label="first-task-opens">{opened}</output></>;}
createRoot(document.getElementById('root')!).render(<React.StrictMode><Fixture/></React.StrictMode>);
