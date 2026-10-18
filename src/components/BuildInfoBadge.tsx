import { BUILD_INFO, buildTimeLabel, formatBuildTime } from '../buildInfo';

interface BuildInfoBadgeProps {
  className?: string;
}

/** Static bundle identity shared by the desktop app and standalone web portal. */
export function BuildInfoBadge({ className = '' }: BuildInfoBadgeProps) {
  const label = buildTimeLabel();
  const fullTime = formatBuildTime(BUILD_INFO.builtAt);
  const shortTime = formatBuildTime(BUILD_INFO.builtAt, false);
  const sourceStatus = BUILD_INFO.sourcePublished === true
    ? ' · 원격 기본 브랜치 검증됨'
    : BUILD_INFO.sourcePublished === false
      ? ' · 미공개 테스트 빌드'
      : '';
  const sourceLabel = BUILD_INFO.sourceCommit ? ` · 소스 ${BUILD_INFO.sourceCommit.slice(0, 8)}${sourceStatus}` : '';
  const accessibleLabel = fullTime
    ? `앱 버전 ${BUILD_INFO.version} · ${label} ${fullTime} KST${sourceLabel}`
    : `앱 버전 ${BUILD_INFO.version} · ${label} 시각 없음${sourceLabel}`;

  return (
    <div
      data-testid="build-info"
      role="note"
      aria-label={accessibleLabel}
      title={accessibleLabel}
      className={`flex items-center gap-1 px-2 py-1 rounded-md border border-zinc-800/70 bg-[rgb(var(--bg-card-rgb))]/80 text-[10px] text-zinc-500 tabular-nums whitespace-nowrap shrink-0 ${className}`}
    >
      <span className="text-zinc-400">v{BUILD_INFO.buildNumber}</span>
      {BUILD_INFO.sourcePublished === false && <span className="font-semibold text-rose-300">TEST</span>}
      {shortTime && <span className="hidden md:inline">· {label} {shortTime}</span>}
    </div>
  );
}
