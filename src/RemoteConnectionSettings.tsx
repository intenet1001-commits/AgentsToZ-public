import React, { useEffect, useRef, useState } from 'react';
import { Power, Settings2 } from 'lucide-react';

export function RemoteConnectionSettings({ connections, onDisconnect }: {
  connections: Array<{ id: string; name: string }>;
  onDisconnect: (id: string) => Promise<boolean>;
}) {
  const [targetId, setTargetId] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const target = connections.find(connection => connection.id === targetId);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (target && !dialog?.open) dialog?.showModal();
    if (!target && dialog?.open) dialog.close();
  }, [target]);
  const close = () => {
    if (pending) return;
    dialogRef.current?.close();
    setTargetId(null);
    triggerRef.current?.focus();
  };
  return connections.length > 0 ? <details className="remote-connection-settings" data-testid="remote-connection-settings">
    <summary><Settings2 aria-hidden="true" />기기 연결 설정</summary>
    <p>연결 해제 후 다시 쓰려면 그 Mac에서 새 QR을 띄워 이 휴대폰으로 다시 스캔해야 합니다.</p>
    {connections.map(connection => <div className="remote-connection-settings-row" key={connection.id}>
      <span>{connection.name}</span>
      <button type="button" disabled={pending} aria-label={`${connection.name} 연결 해제`} onClick={event => {
        triggerRef.current = event.currentTarget;
        setTargetId(connection.id);
      }}><Power aria-hidden="true" />연결 해제</button>
    </div>)}
    <dialog ref={dialogRef} className="remote-connection-dialog" aria-labelledby="remote-disconnect-title" aria-describedby="remote-disconnect-description"
      onCancel={event => { event.preventDefault(); close(); }}>
      <h2 id="remote-disconnect-title">{target?.name} 연결을 해제할까요?</h2>
      <p id="remote-disconnect-description">이 기기의 연결 정보가 삭제됩니다. 다시 연결하려면 {target?.name}에서 새 QR을 발급받아야 합니다. 다른 기기의 연결은 유지됩니다.</p>
      <div className="remote-connection-dialog-actions">
        <button type="button" autoFocus disabled={pending} onClick={close}>연결 유지</button>
        <button type="button" className="remote-connection-confirm" disabled={pending || !target} onClick={async () => {
          if (!target || pending) return;
          setPending(true);
          try { if (await onDisconnect(target.id)) setTargetId(null); }
          finally { setPending(false); }
        }}>{pending ? '해제 중…' : '연결 해제 확인'}</button>
      </div>
    </dialog>
  </details> : null;
}
