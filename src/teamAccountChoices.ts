/**
 * The CLI accounts the 팀 작전 builder (src/WorkroomTeamBuilder.tsx) may offer, read without choosing any. Only the host's `list`
 * is called — never `select`, which writes the project's binding (src/CliAccountPicker.tsx) — so opening the builder changes no
 * account anywhere. A list that fails, that the host does not support, or that comes back malformed is left out: the builder
 * reads a missing AI as 「목록 확인 불가」, never as an empty list or as some other account.
 */
import {useEffect,useRef,useState} from 'react';
import {CLI_ACCOUNT_AGENTS,normalizeCliAccountSelection,type CliAccountAgent} from './cliAccountProtocol';

/** Per AI, the accounts this host lists (ids and names only). An AI missing from the map is a list that could not be read. */
export type TeamAccountChoices=Partial<Record<CliAccountAgent,readonly {id:string;label:string}[]>>;
/** One AI's read-only account list (a CliAccountSelection): the Workroom's `accounts` `list` for one project. */
export type TeamAccountLister=(agent:CliAccountAgent)=>Promise<unknown>;

/** Reads every account-taking AI's list. The selection's own pick (that project's binding) is not kept: a new member does not inherit it. */
export async function readTeamAccountChoices(list:TeamAccountLister):Promise<TeamAccountChoices>{
  const lists=await Promise.all(CLI_ACCOUNT_AGENTS.map(async agent=>{
    try{
      const selection=normalizeCliAccountSelection(await list(agent));
      return selection.agent===agent?[agent,selection.items.map(({id,label})=>({id,label}))] as const:null;
    }catch{return null;}
  }));
  return Object.fromEntries(lists.filter((entry):entry is NonNullable<typeof entry>=>entry!==null));
}

/**
 * The lists while the builder is open (`active`), read again when `key` (the project) changes. `loading` until the first read
 * answers; without a lister (a phone, another Mac, a USE thread) nothing is read and every list stays unavailable.
 */
export function useTeamAccountChoices(list:TeamAccountLister|undefined,key:string,active:boolean):{accounts?:TeamAccountChoices;loading:boolean}{
  const lister=useRef(list);lister.current=list;
  const [state,setState]=useState<{key:string;accounts:TeamAccountChoices}|null>(null);
  const enabled=active&&!!list;
  useEffect(()=>{
    if(!enabled)return;
    let alive=true;setState(null);
    void readTeamAccountChoices(agent=>lister.current?lister.current(agent):Promise.reject(new Error('unavailable'))).then(accounts=>{if(alive)setState({key,accounts});});
    return()=>{alive=false;};
  },[enabled,key]);
  if(!enabled)return {loading:false};
  return state?.key===key?{accounts:state.accounts,loading:false}:{loading:true};
}
