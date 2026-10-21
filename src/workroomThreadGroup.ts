/** Keep every shared message page readable alongside up to eight participant receipts. */
export function sharedThreadTextParts(text:string):string[]{
 const parts:string[]=[];let part='',bytes=0;
 for(const c of text){const size=new TextEncoder().encode(JSON.stringify(c)).length-2;if(bytes+size>1200&&part){parts.push(part);part='';bytes=0;}part+=c;bytes+=size;}
 if(part)parts.push(part);return parts;
}
export function sharedThreadProjectLabel(label:string){let out='';for(const c of label){if(new TextEncoder().encode(out+c).length>100)break;out+=c;}return out;}

/** Typed names never add execution authority: only explicitly selected recipient chips do. */
export function hasUnselectedProjectCall(text:string,selectedLabels:readonly string[]){
 let remaining=text;
 for(const label of [...selectedLabels].sort((a,b)=>b.length-a.length)){
  const token='@'+label;let offset=0;
  while(offset<remaining.length){const at=remaining.indexOf(token,offset);if(at<0)break;const end=at+token.length;
   if((at===0||/\s/u.test(remaining[at-1]!))&&(end===remaining.length||/\s/u.test(remaining[end]!)))remaining=remaining.slice(0,at)+' '.repeat(token.length)+remaining.slice(end);
   offset=end;
  }
 }
 return /(?:^|\s)@[^\s@#]+/u.test(remaining);
}
