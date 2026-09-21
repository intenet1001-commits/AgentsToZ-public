import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stageSwiftManifestCompatibility } from '../src/swiftManifestCompatibility';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(privateVersion: string) {
  const root = mkdtempSync(join(tmpdir(), 'agentstoz-swift-manifest-test-'));
  roots.push(root);
  const api = join(root, 'system', 'ManifestAPI');
  const module = join(api, 'PackageDescription.swiftmodule');
  mkdirSync(module, { recursive: true });
  const publicName = 'arm64-apple-macos.swiftinterface';
  const privateName = 'arm64-apple-macos.private.swiftinterface';
  writeFileSync(join(module, publicName), '// swift-compiler-version: Apple Swift version 6.3.1 effective-5.10\n');
  writeFileSync(join(module, privateName), `// swift-compiler-version: Apple Swift version ${privateVersion}\n`);
  writeFileSync(join(api, 'libPackageDescription.dylib'), 'unchanged-library');
  return { root, api, module, publicName, privateName };
}

test('matching toolchains keep their default libraries and private interfaces', () => {
  const f = fixture('6.3.1');
  expect(stageSwiftManifestCompatibility(f.api, join(f.root, 'scratch'))).toBeNull();
  expect(existsSync(join(f.root, 'scratch'))).toBe(false);
});

test('mixed toolchains omit only mismatched private metadata in a scratch copy', () => {
  const f = fixture('5.10');
  const libraries = stageSwiftManifestCompatibility(f.api, join(f.root, 'scratch'))!;
  const stagedModule = join(libraries, 'ManifestAPI', 'PackageDescription.swiftmodule');
  expect(existsSync(join(stagedModule, f.privateName))).toBe(false);
  expect(readFileSync(join(stagedModule, f.publicName), 'utf8')).toContain('6.3.1');
  expect(readFileSync(join(libraries, 'ManifestAPI', 'libPackageDescription.dylib'), 'utf8')).toBe('unchanged-library');
  expect(readFileSync(join(f.module, f.privateName), 'utf8')).toContain('5.10');
});
