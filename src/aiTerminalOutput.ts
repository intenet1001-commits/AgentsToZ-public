type OutputChunk = {seq:number;text:string};

/** Pack PTY callbacks without changing stored cursor boundaries or the v1 wire limits. */
export function terminalOutputPage(source:readonly OutputChunk[], after:number) {
  const chunks:OutputChunk[]=[];
  const encoder=new TextEncoder();
  let bytes=0, nextCursor=after;
  for(const part of source) {
    if(part.seq<=after)continue;
    const last=chunks.at(-1);
    const merge=!!last&&last.text.length+part.text.length<=1024;
    const candidate={seq:part.seq,text:merge?last.text+part.text:part.text};
    const previousBytes=merge?encoder.encode(JSON.stringify(last)).length:0;
    const nextBytes=bytes-previousBytes+encoder.encode(JSON.stringify(candidate)).length;
    if((!merge&&chunks.length>=4)||nextBytes>8500)break;
    if(merge)chunks[chunks.length-1]=candidate;else chunks.push(candidate);
    bytes=nextBytes;nextCursor=part.seq;
  }
  return {chunks,nextCursor,hasMore:(source.at(-1)?.seq??after)>nextCursor,
    truncated:(source[0]?.seq??1)>after+1};
}
