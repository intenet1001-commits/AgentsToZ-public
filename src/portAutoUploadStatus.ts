/** Classify known failure signals without rendering server messages or credentials. */
export function portAutoUploadFailureMessage(error: unknown): string {
  const pending: unknown[] = [error];
  const seen = new Set<object>();
  const signals: string[] = [];
  let commitUnknown = false;
  for (let index = 0; index < pending.length && index < 16; index += 1) {
    const value = pending[index];
    if (typeof value === 'string') {
      signals.push(value.slice(0, 2_048));
      continue;
    }
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    const record = value as Record<string, unknown>;
    const read = (key: string): unknown => {
      try { return record[key]; } catch { return undefined; }
    };
    for (const key of ['code', 'name', 'message', 'details', 'hint', 'status', 'statusCode']) {
      const field = read(key);
      if (typeof field === 'string') signals.push(field.slice(0, 2_048));
      else if (typeof field === 'number' && Number.isFinite(field)) signals.push(String(field));
    }
    if (read('mutationMayHaveCommitted') === true) commitUnknown = true;
    for (const key of ['rpcError', 'cause', 'error']) {
      if (pending.length < 16) pending.push(read(key));
    }
  }
  const text = signals.join('\n');

  if (/\bDESKTOP_SIDECAR_STARTUP_TIMEOUT\b/.test(text)) {
    return '자동 업로드 중단 · 로컬 API가 아직 준비되지 않았습니다. 앱을 다시 열어 주세요.';
  }
  if (/\bPORT_AUTO_UPLOAD_PULL_REQUIRED\b/.test(text)) {
    return '자동 업로드 중단 · 연결 설정이 바뀌었습니다. 앱을 다시 열어 원격 상태를 확인해 주세요.';
  }
  if (/\bPORT_AUTO_UPLOAD_METADATA_[A-Z_]+\b/.test(text)) {
    return '자동 업로드 중단 · 이 기기와 원격의 프로젝트 정보를 비교해 주세요. 양쪽 값은 보존했습니다.';
  }

  if (/\b(?:WORKSPACE_LEASE_BUSY|PORTAL_SAFETY_LEASE_BUSY)\b/i.test(text)) {
    return '자동 업로드 대기 · 다른 로컬 작업이 끝난 뒤 다시 시도해 주세요.';
  }
  if (/\b(?:WORKSPACE_LEASE|PORTAL_SAFETY_LEASE)_[A-Z_]+\b|프로젝트 숨김 안전(?:정보|\s*잠금)|작업공간.*잠금/i.test(text)) {
    return '자동 업로드 중단 · 로컬 작업 잠금을 확인한 뒤 다시 시도해 주세요.';
  }
  if (/\b(?:PGRST20[245]|42P01|42703|42883|PORT_DURABLE_FENCE_RPC_UNAVAILABLE|PORT_FENCE_SCHEMA_REQUIRED)\b/i.test(text)
    || /(?:could not find (?:the )?(?:table|function|column)|(?:relation|column|function) [^\n]* does not exist)/i.test(text)) {
    return '자동 업로드 중단 · Supabase DB 업데이트가 필요합니다. 테이블·함수·필수 항목을 확인해 주세요.';
  }
  if (/\b(?:PORT_FENCE_(?:[A-Z_]*(?:MISMATCH|REUSED|MIXED_REPLAY)|DELETED|OWNER_IMMUTABLE)|40001|40P01)\b/i.test(text)) {
    return '자동 업로드 중단 · 원격 상태가 변경되었을 수 있습니다. 최신 원격 상태와 로컬 변경을 확인해 주세요.';
  }
  if (/\b(?:401|403|42501|28000|28P01|PGRST30[123]|PORTMGR_MEMBER_REQUIRED|DESKTOP_SUPABASE_PROXY_DENIED)\b|invalid (?:jwt|api key)|jwt expired|permission denied|row.level security/i.test(text)) {
    return '자동 업로드 중단 · Supabase 인증과 접근 권한을 확인해 주세요.';
  }
  if (commitUnknown || /\bPORT_DURABLE_FENCE_(?:COMMIT_UNKNOWN|INVALID_RESPONSE)\b/i.test(text)) {
    return '자동 업로드 결과 확인 필요 · 원격 반영 여부를 확인한 뒤 다시 시도해 주세요.';
  }
  if (/\b(?:PGRST00[0123]|ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|AbortError|TimeoutError|502|503|504)\b|failed to fetch|fetch failed|load failed|network|timeout|timed out|connection|연결.*실패|시간.*초과/i.test(text)) {
    return '자동 업로드 중단 · 네트워크와 Supabase 연결을 확인한 뒤 다시 시도해 주세요.';
  }
  return '자동 업로드 중단 · 원인을 확인하지 못했습니다. 동기화 상태를 확인해 주세요.';
}
