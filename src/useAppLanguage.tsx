import React,{useEffect,useSyncExternalStore} from 'react';
import {APP_LANGUAGES,isAppLanguage,isAppLanguagePersisted,readAppLanguage,subscribeAppLanguage,t,writeAppLanguage,type Lang} from './i18n';
export function useAppLanguage():readonly [Lang,(lang:Lang)=>boolean]{
 const lang=useSyncExternalStore(subscribeAppLanguage,readAppLanguage,()=> 'ko' as const);
 useEffect(()=>{document.documentElement.lang=lang;},[lang]);
 return [lang,writeAppLanguage];
}
export function AppLanguagePicker(){
 const [lang,setLang]=useAppLanguage();
 const saved=useSyncExternalStore(subscribeAppLanguage,isAppLanguagePersisted,()=>true);
 return <label className="app-language-picker" style={{display:'inline-flex',flexWrap:'wrap',alignItems:'center',gap:6,padding:'6px 8px',fontSize:12,maxWidth:'100%'}}>
  <span aria-hidden="true">🌐</span><span>{t(lang,'language')}</span>
  <select aria-label={t(lang,'language')} data-testid="app-language" value={lang} onChange={e=>{if(isAppLanguage(e.target.value))setLang(e.target.value);}} style={{font:'inherit',color:'var(--ink, inherit)',background:'var(--surface, transparent)',border:'1px solid var(--line, #777)',borderRadius:8,padding:'8px 4px',minHeight:40,maxWidth:150}}>
   {APP_LANGUAGES.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}
  </select>
  {!saved&&<span role="status" style={{fontSize:12,overflowWrap:'anywhere'}}>{t(lang,'languageNotSaved')}</span>}
 </label>;
}
