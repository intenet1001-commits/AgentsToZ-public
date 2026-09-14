import type { Session, SupabaseClient } from '@supabase/supabase-js';
import { invoke } from '@tauri-apps/api/core';

const NATIVE_AUTH_BASE = 'http://127.0.0.1:3001/api/auth/native';
const POLL_INTERVAL_MS = 500;
const DEFAULT_TIMEOUT_MS = 10 * 60_000;

function nativeOAuthRequestId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export async function signInNativeSupabase(
  supabase: SupabaseClient,
  options: { timeoutMs?: number; onStatus?: (status: string) => void } = {},
): Promise<Session> {
  const requestId = nativeOAuthRequestId();
  const callbackUrl = `${NATIVE_AUTH_BASE}/callback/${encodeURIComponent(requestId)}`;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const register = await fetch(`${NATIVE_AUTH_BASE}/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId }),
  });
  if (!register.ok) {
    throw new Error(`native OAuth relay registration failed (${register.status})`);
  }

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: callbackUrl,
      skipBrowserRedirect: true,
    },
  });
  if (error) throw error;
  if (!data.url) throw new Error('Supabase did not return a Google OAuth URL.');

  options.onStatus?.('브라우저에서 Google 로그인을 완료하세요.');
  await invoke('open_in_chrome', { url: data.url, profileDirectory: null });

  const deadline = Date.now() + timeoutMs;
  let code = '';
  while (Date.now() < deadline) {
    const response = await fetch(`${NATIVE_AUTH_BASE}/result?request=${encodeURIComponent(requestId)}`);
    if (response.status === 200) {
      const payload = await response.json();
      code = typeof payload.code === 'string' ? payload.code : '';
      if (!code) throw new Error('native OAuth callback returned no authorization code.');
      break;
    }
    if (response.status !== 202) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || `native OAuth callback failed (${response.status})`);
    }
    await delay(POLL_INTERVAL_MS);
  }
  if (!code) throw new Error('Google 로그인 대기 시간이 초과됐습니다. 다시 시도하세요.');

  options.onStatus?.('로그인 세션을 확인하는 중입니다.');
  const exchanged = await supabase.auth.exchangeCodeForSession(code);
  if (exchanged.error) throw exchanged.error;
  if (!exchanged.data.session) throw new Error('Supabase authenticated session was not created.');
  return exchanged.data.session;
}

export async function signInBrowserSupabase(
  supabase: SupabaseClient,
  options: { timeoutMs?: number; onStatus?: (status: string) => void } = {},
): Promise<Session> {
  const redirectTo = new URL('/portal.html', window.location.origin).toString();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo, skipBrowserRedirect: true },
  });
  if (error) throw error;
  if (!data.url) throw new Error('Supabase did not return a Google OAuth URL.');

  const popup = window.open(data.url, 'agentstoz-supabase-oauth', 'popup=yes,width=560,height=760');
  if (!popup) {
    throw new Error('Google 로그인 팝업이 차단됐습니다. 이 사이트의 팝업을 허용한 뒤 다시 시도하세요.');
  }

  options.onStatus?.('팝업에서 Google 로그인을 완료하세요.');
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
      if (sessionError) throw sessionError;
      if (sessionData.session) {
        options.onStatus?.(`Google 로그인 완료: ${sessionData.session.user.email ?? sessionData.session.user.id}`);
        return sessionData.session;
      }
      await delay(POLL_INTERVAL_MS);
    }
    throw new Error('Google 로그인 대기 시간이 초과됐습니다. 다시 시도하세요.');
  } finally {
    if (!popup.closed) popup.close();
  }
}

export const NATIVE_SUPABASE_CALLBACK_URL = `${NATIVE_AUTH_BASE}/callback/*`;
