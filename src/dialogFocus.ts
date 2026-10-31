/** A disclosure may close while its modal is open. Return to its visible summary instead of focusing hidden UI. */
export function restoreDialogFocus(opener:HTMLElement|null){
  const visible=(element:HTMLElement|null):element is HTMLElement=>!!element?.isConnected&&element.getClientRects().length>0&&getComputedStyle(element).visibility!=='hidden';
  if(visible(opener)&&!opener.closest('details:not([open])')){opener.focus({preventScroll:true});if(document.activeElement===opener)return;}
  for(let parent=opener?.parentElement;parent;parent=parent.parentElement){
    if(parent.tagName!=='DETAILS')continue;
    const summary=parent.querySelector<HTMLElement>(':scope > summary');if(visible(summary)){summary.focus({preventScroll:true});if(document.activeElement===summary)return;}
  }
}
