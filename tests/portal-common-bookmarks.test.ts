import {test,expect} from 'bun:test';
import {readCommonBookmarkRows} from '../src/portalCommonBookmarks';
test('common catalog retains shared and legacy device rows across every page',async()=>{
 const rows=Array.from({length:1001},(_,i)=>({id:`row-${i}`,device_id:i%2?'legacy-device':'__shared__',url:'https://same.example'}));
 const pages:number[]=[];
 const result=await readCommonBookmarkRows(async(from,to)=>{pages.push(from);return rows.slice(from,to+1)});
 expect(pages).toEqual([0,500,1000]);expect(result).toEqual(rows);
});
test('failed later pages and changing page identities never return a partial catalog',async()=>{
 const page=Array.from({length:500},(_,i)=>({id:`row-${i}`}));
 await expect(readCommonBookmarkRows(async from=>{if(from)throw new Error('offline');return page})).rejects.toThrow('offline');
 await expect(readCommonBookmarkRows(async()=>page)).rejects.toThrow('목록이 변경');
});
test('oversized common catalog fails without dropping old items to fit the budget',async()=>{
 await expect(readCommonBookmarkRows(async()=>[{id:'large',text:'x'.repeat(8*1024*1024)}])).rejects.toThrow('조회 한도');
});
