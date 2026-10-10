import React from 'react';
import {createRoot} from 'react-dom/client';
import {BuzzAgentSetupDialog} from '../../../src/BuzzAgentSetupDialog';

createRoot(document.getElementById('root')!).render(
  <BuzzAgentSetupDialog
    deviceName="Fixture Device"
    initialProjectId="project-A"
    projects={[
      {id:'project-A',name:'Project A',folderPath:'/fixture/A'},
      {id:'project-B',name:'Project B',folderPath:'/fixture/B'},
    ]}
    onClose={()=>{}}
    onToast={()=>{}}
  />,
);
