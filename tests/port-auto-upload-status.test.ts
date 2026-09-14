import { describe, expect, test } from 'bun:test';
import { portAutoUploadFailureMessage } from '../src/portAutoUploadStatus';
import { PortDurableFenceError, PORT_UPSERT_FENCE_RPC } from '../src/portDurableFence';

describe('automatic port upload failure status', () => {
  test('includes all uploaded project fields when comparison is required', () => {
    expect(portAutoUploadFailureMessage(new Error('PORT_AUTO_UPLOAD_METADATA_CONFLICT')))
      .toContain('프로젝트 정보를 비교');
  });
  test('identifies native sidecar startup timeout before cloud connectivity', () => {
    const message = portAutoUploadFailureMessage(new Error('DESKTOP_SIDECAR_STARTUP_TIMEOUT'));
    expect(message).toContain('로컬 API가 아직 준비되지 않았습니다');
    expect(message).not.toContain('Supabase');
  });

  test('identifies missing schema from nested fence errors without blaming the connection', () => {
    const error = new PortDurableFenceError('unavailable', PORT_UPSERT_FENCE_RPC,
      'PORT_DURABLE_FENCE_RPC_UNAVAILABLE', {
        code: 'PGRST202', message: `Could not find the function public.${PORT_UPSERT_FENCE_RPC}`,
      });
    for (const value of [
      error,
      { cause: { error: { code: 'PGRST205', message: 'Could not find public.portmgr_port_fences' } } },
      { code: 'PGRST204', message: 'Could not find the sync_generation column' },
      { code: '42703', message: 'column worktree_parent_id does not exist' },
      new Error('PORT_FENCE_PROPAGATION_QUERY_FAILED:42P01 relation portmgr_port_fences does not exist'),
      new Error('PORT_FENCE_SCHEMA_REQUIRED:portmgr_port_fences'),
      { code: '42883' },
    ]) {
      const message = portAutoUploadFailureMessage(value);
      expect(message).toContain('DB 업데이트');
      expect(message).not.toContain('연결');
    }
  });

  test('distinguishes credentials, connectivity and schema cache connection failures', () => {
    for (const error of [{ status: 401 }, { statusCode: 403 }, { code: 'PGRST301' },
      { error: { code: '42501', message: 'permission denied for table portmgr_port_fences' } },
      new Error('PORTMGR_MEMBER_REQUIRED')]) {
      expect(portAutoUploadFailureMessage(error)).toContain('인증과 접근 권한');
    }
    for (const error of [new TypeError('Failed to fetch'), { cause: { code: 'ETIMEDOUT' } },
      { code: 'PGRST002', message: 'Could not query the database for the schema cache' },
      { status: 503 }]) {
      expect(portAutoUploadFailureMessage(error)).toContain('네트워크와 Supabase 연결');
    }
  });

  test('distinguishes stale remote state from local lease contention', () => {
    const rejected = new PortDurableFenceError('rejected', PORT_UPSERT_FENCE_RPC,
      'RPC rejected', { code: '40001', message: 'PORT_FENCE_UPSERT_GENERATION_MISMATCH' });
    for (const error of [rejected, new Error('PORT_FENCE_DELETED'),
      { rpcError: { message: 'PORT_FENCE_UPSERT_OPERATION_REUSED' } }]) {
      expect(portAutoUploadFailureMessage(error)).toContain('최신 원격 상태와 로컬 변경');
    }
    expect(portAutoUploadFailureMessage({ code: 'PORTAL_SAFETY_LEASE_BUSY', status: 409 }))
      .toContain('다른 로컬 작업이 끝난 뒤');
    expect(portAutoUploadFailureMessage({ cause: { code: 'WORKSPACE_LEASE_UNSAFE' } }))
      .toContain('로컬 작업 잠금');
    expect(portAutoUploadFailureMessage(new Error('프로젝트 숨김 안전 잠금을 얻지 못했습니다 (HTTP 403).')))
      .toContain('로컬 작업 잠금');
  });

  test('does not claim an uncertain committed write failed or advise an immediate upload', () => {
    const error = new PortDurableFenceError('invalid-response', PORT_UPSERT_FENCE_RPC,
      'PORT_DURABLE_FENCE_COMMIT_UNKNOWN', new TypeError('Failed to fetch'), true);
    const message = portAutoUploadFailureMessage({ cause: error });
    expect(message).toContain('원격 반영 여부');
    expect(message).not.toContain('중단');
    expect(message).not.toContain('실패');
  });

  test('never displays raw server messages, secrets, paths or arbitrary objects', () => {
    const secret = 'private-service-role-token';
    for (const error of [null, undefined, 42, secret,
      new Error(`Server internals /Users/private/project ${secret}`),
      { code: 'PGRST205', details: `postgres://user:${secret}@private.example/db` },
      { code: '42501', hint: secret },
      { toString() { throw new Error('must not stringify'); } },
    ]) {
      const message = portAutoUploadFailureMessage(error);
      expect(message).not.toContain(secret);
      expect(message).not.toContain('/Users/');
      expect(message).not.toContain('private.example');
      expect(message.length).toBeLessThan(120);
    }
    expect(portAutoUploadFailureMessage({ message: 'unrecognized server internals' }))
      .toContain('원인을 확인하지 못했습니다');
  });

  test('bounds nested error inspection and tolerates cycles or throwing accessors', () => {
    const cycle: Record<string, unknown> = { code: 'PGRST205' };
    cycle.cause = { rpcError: cycle };
    expect(portAutoUploadFailureMessage(cycle)).toContain('DB 업데이트');
    expect(portAutoUploadFailureMessage({ get code() { throw new Error('unreadable'); } }))
      .toContain('원인을 확인하지 못했습니다');
    let reads = 0;
    const unbounded = (): object => ({ get cause() { reads += 1; return unbounded(); } });
    expect(portAutoUploadFailureMessage(unbounded())).toContain('원인을 확인하지 못했습니다');
    expect(reads).toBeLessThanOrEqual(16);
  });
});
