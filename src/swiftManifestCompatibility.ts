import { cpSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

function compilerVersion(source: string): string | null {
  return source.match(/^\/\/ swift-compiler-version: Apple Swift version (\d+\.\d+(?:\.\d+)?)/m)?.[1] ?? null;
}

/**
 * Interrupted CLT upgrades can leave Swift 5 private interfaces beside Swift 6
 * public interfaces and runtime libraries. Swift prefers the stale private file,
 * producing either missing initializers or undefined linker symbols. Use only
 * the matching public interface in a build-local copy; never alter the SDK.
 */
export function stageSwiftManifestCompatibility(
  manifestApi: string,
  scratchRoot: string,
): string | null {
  const stale = new Set<string>();
  for (const module of ['PackageDescription', 'CompilerPluginSupport']) {
    for (const architecture of ['arm64', 'x86_64']) {
      const stem = join(manifestApi, `${module}.swiftmodule`, `${architecture}-apple-macos`);
      const publicPath = `${stem}.swiftinterface`;
      const privatePath = `${stem}.private.swiftinterface`;
      if (!existsSync(publicPath) || !existsSync(privatePath)) continue;
      const current = compilerVersion(readFileSync(publicPath, 'utf8'));
      const previous = compilerVersion(readFileSync(privatePath, 'utf8'));
      if (current && previous && current !== previous) stale.add(privatePath);
    }
  }
  if (stale.size === 0) return null;
  const staged = join(scratchRoot, 'swiftpm-libraries', 'ManifestAPI');
  cpSync(manifestApi, staged, {
    recursive: true,
    errorOnExist: true,
    force: false,
    filter: source => !stale.has(source),
  });
  // SwiftPM's documented override takes the parent of ManifestAPI.
  return join(scratchRoot, 'swiftpm-libraries');
}
