import { describe, test, expect } from 'bun:test';
import { CLIENT_ERROR_TABLES, CLIENT_ERROR_SQL, MIGRATION_SQL } from '../src/schemaSql';

/**
 * Portal errors happen on a phone, away from the Mac's localhost sidecar.
 *
 * The remote-control screen showed "check your internet" for every unmapped
 * failure, and the real code had nowhere to go: `/api/voc` is a localhost
 * endpoint the phone cannot reach, and `portmgr_voc_inbox` is a service-role
 * write-only outbox the Mac cannot read back. This table is the missing half —
 * the phone writes as an authenticated member, and the Mac reads its own rows
 * back into the local VOC list.
 */
describe('client error table', () => {
  test('is declared as a portmgr table so RLS is applied with the rest', () => {
    expect([...CLIENT_ERROR_TABLES]).toContain('portmgr_client_errors');
  });

  test('records what makes an error actionable and nothing more', () => {
    for (const column of [
      'id text primary key',
      'device_id text',
      'surface text',
      'code text',
      'message text',
      'detail text',
      'app_version text',
      'created_at timestamptz',
    ]) {
      expect(CLIENT_ERROR_SQL).toContain(column);
    }
  });

  test('never stores a local filesystem path or a credential column', () => {
    for (const forbidden of ['folder_path', 'command_path', 'worktree_path', 'token', 'secret', 'service_role']) {
      expect(CLIENT_ERROR_SQL).not.toContain(forbidden);
    }
  });

  test('is per-device like ports, so one Mac reads back its own reports', () => {
    expect(CLIENT_ERROR_SQL).toContain('idx_portmgr_client_errors_device');
  });

  test('ships inside the full schema, not as a manual extra step', () => {
    expect(MIGRATION_SQL).toContain('portmgr_client_errors');
  });

  test('is covered by the authenticated-only RLS policy', () => {
    // rlsPolicySql revokes anon and grants authenticated + service_role.
    const policyIndex = MIGRATION_SQL.indexOf('alter table portmgr_client_errors enable row level security');
    expect(policyIndex).toBeGreaterThan(-1);
    expect(MIGRATION_SQL).toContain('revoke all privileges on table portmgr_client_errors from anon');
  });
});
