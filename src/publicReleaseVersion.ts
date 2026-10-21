/** An orphan snapshot cannot count commits from the private history anchor. */
export const PUBLIC_RELEASE_VERSION_FILES = [
  'build-number.json', 'src-tauri/tauri.conf.json', 'src-tauri/Cargo.toml',
  'src-tauri/Cargo.lock', 'src-tauri/windows-contain/Cargo.lock',
  'mobile/ios/AgentsToZMobile.xcodeproj/project.pbxproj',
] as const;

export function publicReleaseVersionFiles(buildNumber: number, files: ReadonlyMap<string, string>): Map<string, string> {
  if (!Number.isSafeInteger(buildNumber) || buildNumber < 1) throw Error('Invalid public release build number');
  const version = `${buildNumber}.0.0`, result = new Map<string, string>();
  const replace = (source: string, pattern: RegExp, replacement: string, expected: number): string => {
    if ([...source.matchAll(pattern)].length !== expected) throw Error('Public version field count changed');
    return source.replace(pattern, replacement);
  };
  for (const path of PUBLIC_RELEASE_VERSION_FILES) {
    const source = files.get(path);
    if (source === undefined) throw Error(`Public release version file missing: ${path}`);
    let content: string;
    if (path === 'build-number.json') {
      // Keep the already-derived number only. No private commit or ancestry is required or exported.
      content = JSON.stringify({ buildNumber }, null, 2) + '\n';
    } else if (path.endsWith('tauri.conf.json')) {
      const config = JSON.parse(source);
      if (typeof config.version !== 'string') throw Error('Public Tauri version missing');
      content = JSON.stringify({ ...config, version }, null, 2) + '\n';
    } else if (path.endsWith('Cargo.toml')) {
      content = replace(source, /(\[package\][\s\S]*?\nversion\s*=\s*)"[^"]+"/g, `$1"${version}"`, 1);
    } else if (path.endsWith('Cargo.lock')) {
      content = replace(source, /(\[\[package\]\]\nname = "app"\nversion = )"[^"]+"/g, `$1"${version}"`, 1);
    } else {
      content = replace(source, /CURRENT_PROJECT_VERSION = \d+;/g, `CURRENT_PROJECT_VERSION = ${buildNumber};`, 2);
      content = replace(content, /MARKETING_VERSION = \d+\.0\.0;/g, `MARKETING_VERSION = ${version};`, 2);
    }
    result.set(path, content);
  }
  return result;
}
