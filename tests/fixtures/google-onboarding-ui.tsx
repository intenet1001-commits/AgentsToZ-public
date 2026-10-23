import {createRoot} from 'react-dom/client';
import {GoogleWorkspaceSetupHelp} from '../../src/GoogleWorkspaceSetupHelp';
import {HelpdeskGoogleLoginSetup} from '../../src/HelpdeskGoogleLoginSetup';
import {AutomaticSaveNotice} from '../../src/AutomaticSaveNotice';
import type {PlatformCliAccount} from '../../src/platformCliProtocol';
const accounts:PlatformCliAccount[]=[{id:'pcli_fixture_owner',provider:'supabase',revision:'fixture-account-1',identity:'owner',label:'격리 QA',state:'ready',source:'managed',verifiedEmail:'owner@example.test'}];
createRoot(document.getElementById('root')!).render(<main><h1>격리 테스트 · Google 연결 안내</h1><p>Google·Supabase에 실제 변경을 보내지 않는 UI fixture입니다.</p><button onClick={()=>void fetch('/test/seed-provider',{method:'POST'}).then(()=>location.reload())}>테스트 전용 · 기존 Google Provider 사례 열기</button><GoogleWorkspaceSetupHelp ko projectId="fixture-google"/><HelpdeskGoogleLoginSetup accounts={accounts}/><AutomaticSaveNotice/></main>);
