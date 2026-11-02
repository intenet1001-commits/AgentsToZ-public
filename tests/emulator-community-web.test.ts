import {describe, expect, test} from 'bun:test';
import {judgeCommunityAudit} from '../scripts/emulator-e2e/communityWebJourney';

describe('J4 community evidence', () => {
  const row = (id: string, kind: string, state: string, event: string) => ({control_id:id, request_kind:kind, state, event, from_endpoint_id:'a', to_endpoint_id:'b'});
  const dump = {audit:{dialogue_controls:[row('p','projects','pending','insert'),row('p','projects','taken','update'),row('p','projects','done','update'),
    row('t','terminal','pending','insert'),row('t','terminal','taken','update'),row('t','terminal','done','update')]}};
  test('requires completed project and terminal rows in the correct direction', () => {
    expect(judgeCommunityAudit(dump,'a','b')).toEqual({problems:[],counts:{projects:1,terminal:1}});
    expect(judgeCommunityAudit(dump,'b','a').problems).toHaveLength(2);
    expect(judgeCommunityAudit({audit:{dialogue_controls:dump.audit.dialogue_controls.filter(r => r.control_id !== 't')}},'a','b').problems).toContain('no completed terminal control from A to B');
  });
  test('detects duplicate acceptance or replies and missing audit evidence', () => {
    const duplicate={audit:{dialogue_controls:[...dump.audit.dialogue_controls,row('t','terminal','taken','update')]}};
    expect(judgeCommunityAudit(duplicate,'a','b').problems).toContain('control row was taken or answered more than once: terminal');
    expect(judgeCommunityAudit({},'a','b').problems).toHaveLength(2);
  });
});
