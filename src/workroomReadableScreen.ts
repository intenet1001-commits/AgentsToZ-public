/** Preserve a terminal grid when its visible structure needs columns. Plain prose still wraps on a phone.
 * These are facts of the parsed screen, never guesses from an agent/model name. Do not filter any rows or cells. */
export function workroomReadableLayout(rows:readonly string[],alternate:boolean):'grid'|'flow'{
 if(alternate)return 'grid';
 if(rows.some(row=>/[\u2500-\u257f]{3,}/u.test(row)))return 'grid';
 return rows.filter(row=>/[│┃║]/u.test(row)).length>=2?'grid':'flow';
}

/** Keep all host rows, but follow the last real character rather than a terminal's empty rows below its cursor.
 * DOM geometry also accounts for wrapping in flow mode. This owns no listeners, timers, cache, or terminal input. */
export function workroomReadableTail(element:HTMLElement):number{
 const node=element.firstChild,text=node?.textContent??'',end=text.search(/\s*$/u);
 if(!node||node.nodeType!==3||end<=0)return 0;
 const range=element.ownerDocument.createRange();range.setStart(node,end-1);range.setEnd(node,end);
 const bottom=range.getBoundingClientRect().bottom-element.getBoundingClientRect().top+element.scrollTop;
 const padding=parseFloat(element.ownerDocument.defaultView?.getComputedStyle(element).paddingBottom??'0')||0;
 return Math.max(0,Math.min(element.scrollHeight-element.clientHeight,bottom+padding-element.clientHeight));
}
