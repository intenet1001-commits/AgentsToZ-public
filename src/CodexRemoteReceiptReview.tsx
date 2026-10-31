import React, {useState} from 'react';
import {confirmAction} from './confirmAction';
import {reviewCodexNewLocalReceipt, resolveCodexNewLocalReceipt, type CodexNewLocalReceipt} from './qrRemoteControlClient';

export async function confirmCodexRemoteReceipt(
  portId: string,
  receipt: CodexNewLocalReceipt | null | undefined,
  confirm: () => Promise<boolean>,
  resolve: (portId: string, expectedRevision: string) => Promise<void>,
): Promise<boolean> {
  if (!receipt || !(await confirm())) return false;
  await resolve(portId, receipt.revision);
  return true;
}

/** Local, explicit user recovery after a phone's pairing or saved request was lost. */
export function CodexRemoteReceiptReview({portId}: {portId: string}) {
  const [receipt, setReceipt] = useState<CodexNewLocalReceipt | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const review = async () => {
    if (busy) return;
    setBusy(true); setMessage('');
    try { setReceipt(await reviewCodexNewLocalReceipt(portId)); }
    catch (error) { setReceipt(undefined); setMessage(error instanceof Error ? error.message : '요청 상태를 확인하지 못했습니다.'); }
    finally { setBusy(false); }
  };
  const resolve = async () => {
    if (busy || !receipt) return;
    setBusy(true); setMessage('');
    try {
      const confirmed = await confirmCodexRemoteReceipt(portId, receipt,
        () => confirmAction(receipt.state === 'completed'
          ? 'Mac의 Codex 프로젝트에서 원격 새 대화 결과를 확인했나요? 확인을 완료하면 다음 새 대화 요청을 허용합니다.'
          : 'Mac의 Codex 프로젝트에서 원격 요청 상태를 확인했나요? 완료되었거나 전송 전에 중단된 것이 확인된 경우에만 다음 요청을 허용하며, 결과가 불확실하면 계속 보류됩니다.'),
        resolveCodexNewLocalReceipt);
      if (!confirmed) return;
      setReceipt(null);
      setMessage('원격 새 대화 결과 확인을 완료했습니다.');
    } catch (error) {
      setReceipt(undefined);
      setMessage(error instanceof Error ? error.message : '요청 확인을 완료하지 못했습니다. 다시 확인하세요.');
    } finally { setBusy(false); }
  };
  return <section className="rounded-lg border border-zinc-700/60 p-3 text-xs text-zinc-300" aria-label="원격 새 대화 결과 확인">
    <p className="m-0">휴대폰 연결을 잃어 새 대화 결과를 확인하지 못했나요?</p>
    <button type="button" disabled={busy} onClick={() => void review()} className="mt-2 underline">이 프로젝트의 원격 요청 확인</button>
    {receipt === null && <p role="status">확인이 필요한 원격 새 대화 요청이 없습니다.</p>}
    {receipt?.state === 'started' && <div>
      <p role="status">요청 결과를 아직 확인할 수 없습니다. Mac의 Codex 앱에서 상태를 확인하세요. 완료되었거나 전송 전 중단이 확인된 경우에만 다음 요청을 허용하며, 결과가 불확실하면 계속 보류됩니다.</p>
      <button type="button" disabled={busy} onClick={() => void resolve()} className="underline">Mac에서 확인하고 요청 상태 검토</button>
    </div>}
    {receipt?.state === 'completed' && <div>
      <p role="status">완료된 요청이 확인을 기다립니다. 먼저 Mac의 Codex 프로젝트에서 실제 대화를 확인하세요.</p>
      <button type="button" disabled={busy} onClick={() => void resolve()} className="underline">Mac에서 확인 완료</button>
    </div>}
    {message && <p role="status">{message}</p>}
  </section>;
}
