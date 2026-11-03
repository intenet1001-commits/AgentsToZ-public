import {useId,type ReactNode} from 'react';

/** Presentation only: the existing actions and their permission checks remain with their owners. */
export function WorkspaceToolGroup({title,children}:{title:string;children:ReactNode}){
  const id=useId();
  return <section className="workspace-tool-group" aria-labelledby={id}>
    <h3 id={id}>{title}</h3>
    <div className="workspace-tool-group__actions">{children}</div>
  </section>;
}
