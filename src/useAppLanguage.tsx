import React,{useEffect,useState} from 'react';
import {APP_LANGUAGES,isAppLanguage,LANGUAGE_STORAGE_KEY,readAppLanguage,t,writeAppLanguage,type Lang} from './i18n';
export function useAppLanguage():readonly [Lang,(lang:Lang)=>void]{
 const [lang,setLang]=useState(readAppLanguage);
 useEffect(()=>{
  const change=(e:Event)=>{const value=(e as CustomEvent).detail;setLang(isAppLanguage(value)?value:readAppLanguage());};
  const storage=(e:StorageEvent)=>{if(e.key===LANGUAGE_STORAGE_KEY||e.key===null)setLang(readAppLanguage());};
  window.addEventListener('agentstoz:language',change);window.addEventListener('storage',storage);
  return()=>{window.removeEventListener('agentstoz:language',change);window.removeEventListener('storage',storage);};
 },[]);
 useEffect(()=>{document.documentElement.lang=lang;},[lang]);
 return [lang,writeAppLanguage];
}
export function AppLanguagePicker(){
 const [lang,setLang]=useAppLanguage();
 return <label className="app-language-picker" style={{display:'inline-flex',alignItems:'center',gap:6,padding:'6px 8px',fontSize:12,maxWidth:'100%'}}>
  <span aria-hidden="true">🌐</span><span>{t(lang,'language')}</span>
  <select aria-label={t(lang,'language')} data-testid="app-language" value={lang} onChange={e=>{if(isAppLanguage(e.target.value))setLang(e.target.value);}} style={{font:'inherit',color:'var(--ink, inherit)',background:'var(--surface, transparent)',border:'1px solid var(--line, #777)',borderRadius:8,padding:'8px 4px',minHeight:40,maxWidth:150}}>
   {APP_LANGUAGES.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}
  </select>
 </label>;
}
