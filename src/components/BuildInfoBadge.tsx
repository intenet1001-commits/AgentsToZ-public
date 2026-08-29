import { BUILD_INFO, buildTimeLabel, formatBuildTime } from '../buildInfo';

interface BuildInfoBadgeProps {
  className?: string;
}

/** Static bundle identity shared by the desktop app and standalone web portal. */
export function BuildInfoBadge({ className = '' }: BuildInfoBadgeProps) {
  const label = buildTimeLabel();
  const fullTime = formatBuildTime(BUILD_INFO.builtAt);
  const shortTime = formatBuildTime(BUILD_INFO.builtAt, false);
  const accessibleLabel = fullTime
    ? `앱 버전 ${BUILD_INFO.version} · ${label} ${fullTime} KST`
    : `앱 버전 ${BUILD_INFO.version} · ${label} 시각 없음`;

  return (
    <div
      data-testid="build-info"
      role="note"
      aria-label={accessibleLabel}
      title={accessibleLabel}
      className={`flex items-center gap-1 px-2 py-1 rounded-md border border-zinc-800/70 bg-[#111113]/80 text-[10px] text-zinc-500 tabular-nums whitespace-nowrap shrink-0 ${className}`}
    >
      <span className="text-zinc-400">v{BUILD_INFO.buildNumber}</span>
      {shortTime && <span className="hidden md:inline">· {label} {shortTime}</span>}
    </div>
  );
}
