import {expect,test} from 'bun:test';
import {agentDialoguePairingRows,agentDialoguePairingState,agentDialoguePairingSummary,withAgentDialoguePairingStates} from '../src/agentDialoguePairingRows';

const peers=[
  {endpointId:'e-ops-3',displayName:'아젠투지3호 / 아젠투지(OPS)',kind:'ops' as const,deviceId:'d3'},
  {endpointId:'e-proj-3',displayName:'아젠투지3호 / mcp-series',kind:'project' as const,deviceId:'d3'},
  {endpointId:'e-ops-2',displayName:'아젠투지2호 / 아젠투지(OPS)',kind:'ops' as const,deviceId:'d2'},
];

test('each side waiting is its own state, and an active pairing carries its expiry',()=>{
  const rows=agentDialoguePairingRows({peers,pairings:[
    {peerEndpointId:'e-ops-3',state:'active',acceptedByMe:true,acceptedByPeer:true,expiresAt:'2026-11-03T00:00:00.000Z'},
    {peerEndpointId:'e-proj-3',state:'waiting-peer',acceptedByMe:true,acceptedByPeer:false,expiresAt:null},
  ]});
  expect(rows.map(row=>row.state)).toEqual(['active','waiting-peer','none']);
  expect(rows[0]!.expiresAt).toBe('2026-11-03T00:00:00.000Z');
  expect(agentDialoguePairingSummary(rows)).toEqual({active:1,waiting:1,total:3});
});

test('a pairing the peer started and I have not accepted waits on me',()=>{
  expect(agentDialoguePairingState({state:'waiting-peer',acceptedByMe:false,acceptedByPeer:true})).toBe('waiting-me');
  expect(agentDialoguePairingState({state:'waiting-peer',acceptedByMe:true,acceptedByPeer:false})).toBe('waiting-peer');
  expect(agentDialoguePairingState({state:'expired',acceptedByMe:true,acceptedByPeer:true})).toBe('expired');
  expect(agentDialoguePairingState(undefined)).toBe('none');
});

test('peers that have not loaded show nothing, and search keeps the real counts',()=>{
  expect(agentDialoguePairingRows({peers:null,pairings:null})).toEqual([]);
  const all=agentDialoguePairingRows({peers,pairings:[{peerEndpointId:'e-ops-2',state:'active',acceptedByMe:true,acceptedByPeer:true}]});
  expect(agentDialoguePairingRows({peers,pairings:null,search:'2호'}).map(row=>row.endpointId)).toEqual(['e-ops-2']);
  expect(agentDialoguePairingSummary(all).active).toBe(1);
});

test('the MCP list says waiting-me when only the peer accepted, and leaves every other row as the server sent it',()=>{
  const rows=[
    {peerEndpointId:'a',state:'waiting-peer',acceptedByMe:false,acceptedByPeer:true,expiresAt:null},
    {peerEndpointId:'b',state:'waiting-peer',acceptedByMe:true,acceptedByPeer:false,expiresAt:null},
    {peerEndpointId:'c',state:'active',acceptedByMe:true,acceptedByPeer:true,expiresAt:'2026-11-30T00:00:00.000Z'},
    {peerEndpointId:'d',state:'expired',acceptedByMe:false,acceptedByPeer:true,expiresAt:'2026-10-01T00:00:00.000Z'},
  ];
  const listed=withAgentDialoguePairingStates(rows) as typeof rows;
  expect(listed.map(row=>row.state)).toEqual(['waiting-me','waiting-peer','active','expired']);
  expect(listed[0]).toEqual({...rows[0]!,state:'waiting-me'});
  expect(listed.slice(1)).toEqual(rows.slice(1));
  expect(rows[0]!.state).toBe('waiting-peer');
  expect(withAgentDialoguePairingStates(null)).toBeNull();
});
