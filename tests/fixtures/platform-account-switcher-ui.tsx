import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {MacCliAccountSwitcher,NewProjectCliAccounts,ProjectCliAccounts,type NewProjectCliChoice} from '../../src/PlatformAccountSwitcher';
function App(){
  const [choice,setChoice]=useState<NewProjectCliChoice>({});
  return <main className="fixture">
    <section data-testid="fixture-mac"><MacCliAccountSwitcher language="ko"/></section>
    <section data-testid="fixture-project"><ProjectCliAccounts targetId="project-one" language="ko"/></section>
    <section data-testid="fixture-new"><NewProjectCliAccounts language="ko" value={choice} onChange={setChoice}/><p data-testid="new-choice">{JSON.stringify(choice)}</p></section>
  </main>;
}
createRoot(document.getElementById('root')!).render(<App/>);
