import {expect,test} from 'bun:test';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {WORKROOM_DRAFT_DUPLICATE_TAKE_BACK_CONFIRM,WORKROOM_DRAFT_VAULT_CONSENT,WorkroomDraftQueue,queuedSendNote,type WorkroomDraftVaultState} from '../src/WorkroomDraftQueuePanel';

const state=(over:Partial<WorkroomDraftVaultState>):WorkroomDraftVaultState=>({supported:true,enabled:false,vault:null,version:0,bump:()=>{},setEnabled:async()=>{},...over});
const render=(s:WorkroomDraftVaultState)=>renderToStaticMarkup(<WorkroomDraftQueue state={s} scope="local" sessionId="session-aaaa-1111" blocked={false} canQueue
 onQueue={async()=>{}} onSend={async()=>null} onTakeBack={()=>false}/>);

test('without IndexedDB or WebCrypto the composer shows nothing new',()=>{
 expect(render(state({supported:false}))).toBe('');
});
test('the setting is off by default and states its retention, limits, origin and the LAN page exception',()=>{
 const html=render(state({}));
 expect(html).toContain('data-testid="workroom-draft-vault-settings"');
 expect(html).toContain('작성 내용 보관 · 꺼짐');
 expect(html).not.toContain('checked=""');
 expect(html).not.toContain('workroom-draft-queue-add');
 for(const line of WORKROOM_DRAFT_VAULT_CONSENT)expect(html).toContain(line);
 const consent=WORKROOM_DRAFT_VAULT_CONSENT.join(' ');
 for(const fact of ['기본은 꺼져','7일','32개','1MiB','꺼낼 수 없게','정지된 상태','직접 「보내기」','http'])expect(consent).toContain(fact);
});
test('turned on, the queue offers to keep the current request',()=>{
 const html=render(state({enabled:true}));
 expect(html).toContain('작성 내용 보관 · 켜짐');
 expect(html).toContain('checked=""');
 expect(html).toContain('data-testid="workroom-draft-queue-add"');
});

test('an unproven queued send offers only a take-back that warns about a duplicate',()=>{
 const unproven=queuedSendNote({kind:'unproven'})!;
 expect(unproven.takeBack).toBe('duplicate-risk');expect(unproven.text).toContain('다시 보내지 않았습니다');expect(unproven.text).toContain('QR');
 expect(WORKROOM_DRAFT_DUPLICATE_TAKE_BACK_CONFIRM).toContain('중복 실행');
 const receipt=(state:string)=>({id:'queued-draft-1',storeId:'store-1',state,bytes:1,digest:'d',chunks:0,receivedChunks:0,updatedAt:0}) as never;
 expect(queuedSendNote({kind:'sent',receipt:receipt('written')})).toBeNull();
 expect(queuedSendNote({kind:'existing',receipt:receipt('rejected')})!.takeBack).toBe('never-ran');
 expect(queuedSendNote({kind:'existing',receipt:receipt('held')})!.takeBack).toBe('never-ran');
 expect(queuedSendNote({kind:'existing',receipt:receipt('write_started')})!.takeBack).toBeNull();
});
