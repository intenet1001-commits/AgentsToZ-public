import {t,type Lang} from './i18n';
export function OnboardingAppDataSection({onOpen,ko=true,language}:{onOpen?:()=>void;ko?:boolean;language?:Lang}){
  const lang=language??(ko?'ko':'en');
  return <section aria-label={t(lang,'appDataStorage')} data-testid="app-data-connection" className="mt-4 rounded-2xl border border-teal-400/30 bg-teal-500/5 p-5">
    <h3 className="font-semibold">{t(lang,'appDataStorage')}</h3>
    <p className="mt-2 text-sm leading-6">{t(lang,'appDataStorageHelp')}</p>
    <p className="mt-2 text-xs leading-5">{t(lang,'appDataInviteHelp')}</p>
    {onOpen?<button type="button" className="mt-3 min-h-11 rounded-xl border border-teal-400/30 px-4 py-2 text-sm" onClick={onOpen}>{t(lang,'openAppDataStorage')}</button>:<p className="mt-3 text-xs">{t(lang,'appDataContinueHelp')}</p>}
  </section>;
}
