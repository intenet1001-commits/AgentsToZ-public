export interface EmbeddedBuildInfo {
  buildNumber: number;
  version: string;
  builtAt: string;
  mode: 'production' | 'development';
}

declare const __BUILD_INFO__: EmbeddedBuildInfo;

const fallbackBuildInfo: EmbeddedBuildInfo = {
  buildNumber: 0,
  version: '0.0.0',
  builtAt: '',
  mode: 'development',
};

// Vite replaces this object at bundle time. The fallback keeps isolated unit
// tests and non-Vite tooling safe without presenting a fake release version.
export const BUILD_INFO: EmbeddedBuildInfo = typeof __BUILD_INFO__ === 'undefined'
  ? fallbackBuildInfo
  : __BUILD_INFO__;

const KOREA_TIME_ZONE = 'Asia/Seoul';

/** Formats a UTC build timestamp deterministically for the Korean UI. */
export function formatBuildTime(value: string, includeYear = true): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: KOREA_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const values = Object.fromEntries(
    parts
      .filter(({ type }) => type !== 'literal')
      .map(({ type, value: partValue }) => [type, partValue]),
  );

  const datePart = includeYear
    ? `${values.year}.${values.month}.${values.day}`
    : `${values.month}.${values.day}`;
  return `${datePart} ${values.hour}:${values.minute}:${values.second}`;
}

export function buildTimeLabel(info: EmbeddedBuildInfo = BUILD_INFO): string {
  return info.mode === 'development' ? '개발 서버 시작' : '빌드';
}
