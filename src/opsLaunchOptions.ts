/** A saved launch choice is a preference; it never grants remote or workroom authority. */
export type OpsLaunchOptions = {mode?:'reopen'|'prepare';bypass?:boolean};
export function opsLaunchBypassSupported(agent:string,surface:string):boolean {
  return surface==='orca-floating'||surface==='orca-worktree'||surface==='app'&&agent==='claude';
}
export function opsLaunchOptions(agent:string,surface:string,input:OpsLaunchOptions):OpsLaunchOptions {
  return {...(input.mode===undefined?{}:{mode:input.mode}),...(input.bypass===undefined?{}:{bypass:opsLaunchBypassSupported(agent,surface)&&input.bypass})};
}
