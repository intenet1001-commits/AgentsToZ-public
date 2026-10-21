/** The portal's QR scanner alone, for tests/portal-qr-scanner-retry.e2e.mjs. Every accepted value is recorded in
 *  `window.__detected` and then refused: as the QR itself (`window.__refuseAs === 'qr'`) or for an app-side reason
 *  (anything else — the shape of 「연결 준비 중입니다…」). Nothing leaves the page. */
import React from 'react';
import {createRoot} from 'react-dom/client';
import {PortalRemoteQrScanner} from '../../src/PortalRemoteQrScanner';
import {PortalRemoteQrError} from '../../src/portalRemoteQr';

const page = window as unknown as {__detected: number[]; __refuseAs?: string};
page.__detected = [];
const onDetected = async () => {
  page.__detected.push(performance.now());
  if (page.__refuseAs === 'qr') throw new PortalRemoteQrError('WRONG_PORTAL', '이 QR은 다른 연결용입니다.');
  throw new Error('연결 준비 중입니다. 잠시 후 다시 시도하세요.');
};
// Opened by a tap, as in the portal (「QR 스캔」): the camera preview may play only after a user gesture.
function Fixture() {
  const [open, setOpen] = React.useState(false);
  return <><button type="button" data-testid="open-scanner" onClick={() => setOpen(true)}>QR 스캔</button>
    <PortalRemoteQrScanner open={open} onClose={() => setOpen(false)} onDetected={onDetected}/></>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
