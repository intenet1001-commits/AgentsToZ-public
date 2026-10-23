import {createRoot} from 'react-dom/client';
import {MacSetupPanel} from '../../../src/MacSetupPanel';
import {OnboardingAppDataSection} from '../../../src/OnboardingAppDataSection';
createRoot(document.getElementById('root')!).render(<main className="mx-auto max-w-3xl space-y-6 p-4"><MacSetupPanel transport={async body=>{const r=await fetch('/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};}}/><OnboardingAppDataSection onOpen={()=>{document.getElementById('result')!.textContent='앱 데이터 연결 화면 열림';}}/><p id="result" role="status"/></main>);
