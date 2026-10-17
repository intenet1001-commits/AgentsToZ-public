import React from 'react';
import {createRoot} from 'react-dom/client';
import OnboardingGithubSetup from '../../../src/OnboardingGithubSetup';
const transport=async(body:Record<string,unknown>)=>{
 const response=await fetch('/fixture/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 return {status:response.status,body:await response.json()};
};
createRoot(document.getElementById('root')!).render(<React.StrictMode><OnboardingGithubSetup transport={transport}/></React.StrictMode>);
