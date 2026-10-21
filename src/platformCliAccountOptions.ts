import type {PlatformCliAccount,PlatformCliProvider} from './platformCliProtocol';

/** Keep credential sources intact; collapse only the duplicate GitHub login in a picker. */
export function platformCliAccountOptions(accounts:PlatformCliAccount[],provider:PlatformCliProvider,selectedId:string):PlatformCliAccount[] {
  const available=accounts.filter(a=>a.provider===provider&&(a.state==='ready'||a.source==='default'));
  if(provider!=='github')return available;
  const login=(a:PlatformCliAccount)=>a.identity?.trim().toLowerCase();
  const managed=available.filter(a=>a.source!=='default'&&a.source!=='native'&&login(a));
  const selectedNative=available.find(a=>a.source==='native'&&a.id===selectedId);
  return available.filter(a=>{
    // A saved native binding must keep its exact credential source until the user changes it.
    if(a.source==='native')return a.id===selectedId||!managed.some(m=>login(m)===login(a));
    if(a.source==='default')return true;
    return !selectedNative||!login(selectedNative)||login(a)!==login(selectedNative);
  });
}
