import { useCallback, useEffect, useState } from 'react';
import { WifiOff } from 'lucide-react';
import { qrRemoteControlApi } from '../qrRemoteControlClient';
import type { QrRemoteControlStall } from '../qrRemoteControlContract';
import {
  remoteControlLanStallBadgeLabel,
  remoteControlLanStallMessage,
} from '../remoteControlLanRestorePlan';
import { isDeployedWeb } from '../lib/env';

/**
 * Header chip for "this Mac has LAN remote stored but cannot serve it right now".
 *
 * The dialog already explains the stall, but only to someone who already suspected something and
 * opened a popover two levels deep — and the defect this exists for is precisely that LAN remote
 * went silent for 127 consecutive app starts. A phone that was paired before the network changed is
 * the one case the host will not fix by itself, so it needs a surface that costs no clicks to see.
 *
 * Renders nothing in the common case. No badge means "nothing stored is stuck", not "remote is on".
 */
const POLL_MS = 60_000;

export default function RemoteControlStallBadge(
  { onOpen, lang = 'ko' }: { onOpen: () => void; lang?: 'ko' | 'en' },
) {
  const [stall, setStall] = useState<QrRemoteControlStall | null>(null);

  const read = useCallback(async () => {
    // Deployed web has no management origin; asking would only 403 every minute.
    if (isDeployedWeb()) return;
    try {
      const status = await qrRemoteControlApi.status();
      setStall(status.stalled);
    } catch {
      // A failed read is not evidence of a stall. Keep the last answer rather than inventing one.
    }
  }, []);

  useEffect(() => {
    void read();
    // Focus and visibility catch the operator coming back after moving networks; the slow interval
    // covers a Mac left open while Wi-Fi changes under it. The read is a small file plus the
    // interface list, so a minute is cheap — but an interval is still gated on being visible.
    const tick = () => { if (document.visibilityState === 'visible') void read(); };
    const timer = window.setInterval(tick, POLL_MS);
    window.addEventListener('focus', tick);
    document.addEventListener('visibilitychange', tick);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', tick);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [read]);

  if (!stall) return null;
  return (
    <button
      type="button"
      data-testid="remote-control-stall-badge"
      data-stall-reason={stall.reason}
      onClick={onOpen}
      title={remoteControlLanStallMessage(stall)}
      style={{
        display: 'flex', alignItems: 'center', gap: 6, padding: '4px 9px', borderRadius: 7,
        border: '1px solid rgb(var(--warn-rgb) / 0.35)', background: 'rgb(var(--warn-rgb) / 0.09)',
        color: 'var(--warn)', fontSize: 11.5, fontWeight: 600, fontFamily: 'inherit',
        cursor: 'pointer', flexShrink: 0, whiteSpace: 'nowrap',
      }}
    >
      <WifiOff style={{ width: 12, height: 12 }} aria-hidden="true" />
      {remoteControlLanStallBadgeLabel(stall, lang)}
    </button>
  );
}
