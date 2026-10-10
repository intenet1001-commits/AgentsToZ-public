import {expect,test} from 'bun:test';
import {cleanupRowStatus,cleanupStatusIndex,type CleanupFolderStatus} from '../src/cleanupFolderStatus';

const rows:CleanupFolderStatus[]=[
  {folderPath:'/a/present',folder:'present',memory:'linked'},
  {folderPath:'/a/bare',folder:'present',memory:'none'},
  {folderPath:'/a/gone',folder:'missing',memory:'unknown'},
];
const index=cleanupStatusIndex(rows);

test('a folder that is there can be opened and says what it holds',()=>{
  expect(cleanupRowStatus('/a/present',index)).toMatchObject({openPath:'/a/present',folderLabel:'폴더 있음',memoryLabel:'장기기억 연동'});
  expect(cleanupRowStatus('/a/bare',index)).toMatchObject({openPath:'/a/bare',memoryLabel:'장기기억 없음'});
});

test('a folder that is gone is never offered for opening',()=>{
  expect(cleanupRowStatus('/a/gone',index)).toMatchObject({folder:'missing',openPath:null,folderLabel:'폴더 없음',memoryLabel:'장기기억 알 수 없음'});
});

test('unchecked and path-less rows read as unknown, not as none',()=>{
  // Before the sweep answers, nothing is claimed either way.
  expect(cleanupRowStatus('/a/present',null)).toMatchObject({folder:'unknown',memory:'unknown',openPath:null});
  expect(cleanupRowStatus('/a/never-asked',index)).toMatchObject({folder:'unknown',memory:'unknown'});
  expect(cleanupRowStatus(undefined,index)).toMatchObject({folder:'unknown',openPath:null,folderLabel:'폴더 경로 없음'});
  expect(cleanupRowStatus('',index)).toMatchObject({folderLabel:'폴더 경로 없음'});
});

test('the index ignores malformed rows and keeps the first answer per path',()=>{
  const messy=cleanupStatusIndex([
    {folderPath:'/a/x',folder:'present',memory:'linked'},
    {folderPath:'/a/x',folder:'missing',memory:'unknown'},
    ...([{folderPath:'',folder:'present',memory:'none'},null,undefined] as unknown as CleanupFolderStatus[]),
  ]);
  expect(messy.size).toBe(1);
  expect(cleanupRowStatus('/a/x',messy).folder).toBe('present');
});
