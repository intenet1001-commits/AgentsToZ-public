import React, {useSyncExternalStore} from 'react';
import {voiceMediaClient} from '../voiceMediaClient';
import './AgentsToZMascot.css';

/**
 * 아젠투지 — the AgentsToZ OPS character (VOC 2026-09-24).
 *
 * Inline SVG on the design-system tokens (copper --accent body, --term face,
 * --ok eyes), so it follows light/dark without an image asset. Like a GIF it
 * cycles typing → holding a mic → waving; while the OPS voice conversation is
 * live it keeps the mic and shows sound waves. It is drawn by the voice dock
 * (AgentsToZVoiceDock), the one 「아젠투지 호출」 entry. Motion stops
 * under prefers-reduced-motion.
 */
export function AgentsToZMascot({size = 32}: {size?: number}) {
  const voice = useSyncExternalStore(voiceMediaClient.subscribe, voiceMediaClient.snapshot, voiceMediaClient.snapshot);
  const speaking = voice.owner === 'voice-ops' && ['preparing', 'listening', 'review'].includes(voice.phase);
  return (
    <svg className="az-mascot" data-mode={speaking ? 'voice' : 'cycle'} data-testid="agentstoz-mascot"
      width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" focusable="false">
      <ellipse className="az-mascot__shadow" cx="32" cy="60" rx="14" ry="2.5" />
      <g className="az-mascot__body">
        {/* cloud head */}
        <g className="az-mascot__skin">
          <circle cx="21" cy="21" r="9" />
          <circle cx="32" cy="15" r="11" />
          <circle cx="43" cy="21" r="9" />
          <rect x="12" y="17" width="40" height="23" rx="11" />
          {/* torso and feet */}
          <rect x="23" y="40" width="18" height="13" rx="5" />
          <rect x="24" y="52" width="6" height="4" rx="2" />
          <rect x="34" y="52" width="6" height="4" rx="2" />
        </g>
        <rect className="az-mascot__screen" x="17" y="21" width="30" height="15" rx="6" />
        <g className="az-mascot__eyes">
          <polyline points="22,25.5 26,28.5 22,31.5" />
          <path d="M31 30.5 q3.5 3 7 0" />
        </g>
        <rect className="az-mascot__screen" x="27" y="43" width="10" height="6" rx="2" />
        <path className="az-mascot__prompt" d="M29 45 l1.5 1.2 -1.5 1.2 M32 47.5 h3" />
      </g>
      {/* pose 1: typing — we see the back of the laptop lid, hands on its top edge */}
      <g className="az-mascot__pose az-mascot__pose--typing">
        <rect className="az-mascot__laptop" x="17" y="43" width="30" height="12" rx="2.5" />
        <circle className="az-mascot__laptop-logo" cx="32" cy="49" r="1.8" />
        <rect className="az-mascot__laptop-base" x="13" y="54.5" width="38" height="3" rx="1.5" />
        <g className="az-mascot__hands">
          <circle className="az-mascot__hand az-mascot__hand--l" cx="24" cy="43" r="2.6" />
          <circle className="az-mascot__hand az-mascot__hand--r" cx="40" cy="43" r="2.6" />
        </g>
      </g>
      {/* pose 2: holding a microphone */}
      <g className="az-mascot__pose az-mascot__pose--mic">
        <rect className="az-mascot__mic-handle" x="45" y="33" width="3" height="10" rx="1.5" transform="rotate(-25 46.5 38)" />
        <circle className="az-mascot__mic-head" cx="49" cy="30" r="4" />
        <circle className="az-mascot__hand" cx="45" cy="42" r="2.6" />
        <path className="az-mascot__wave az-mascot__wave--1" d="M55 26 q3 4 0 8" />
        <path className="az-mascot__wave az-mascot__wave--2" d="M58 23 q5 7 0 14" />
      </g>
      {/* pose 3: waving hello from beside the head */}
      <g className="az-mascot__pose az-mascot__pose--wave">
        <g className="az-mascot__waving-arm">
          <path className="az-mascot__arm-line" d="M41 45 Q51 42 55 34" />
          <circle className="az-mascot__hand" cx="55.5" cy="32.5" r="3" />
        </g>
      </g>
    </svg>
  );
}
