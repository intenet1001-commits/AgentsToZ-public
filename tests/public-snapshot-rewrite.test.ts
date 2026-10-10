import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { applyPublicSnapshotRewrite } from '../src/publicSnapshotRewrite';
import { DEFAULT_REMOTE_CONTROLLER_ORIGIN } from '../src/defaultRemoteControllerOrigin';

const root = new URL('..', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), 'utf8');

describe('public snapshot rewrite', () => {
  test('replaces exactly one occurrence and refuses zero or many', () => {
    const rule = { path: 'a.ts', from: "'x'", to: "'y'" };
    expect(applyPublicSnapshotRewrite("const a = 'x';", rule)).toBe("const a = 'y';");
    expect(() => applyPublicSnapshotRewrite('const a = 1;', rule)).toThrow('PUBLIC_REWRITE_MATCH_COUNT');
    expect(() => applyPublicSnapshotRewrite("'x' + 'x'", rule)).toThrow('PUBLIC_REWRITE_MATCH_COUNT');
    expect(() => applyPublicSnapshotRewrite("'x'", { ...rule, to: "'x'" })).toThrow('PUBLIC_REWRITE_INVALID');
    expect(applyPublicSnapshotRewrite("'x'", { ...rule, to: "'$&$&'" })).toBe("'$&$&'");
  });

  test('the publish rule still matches the private default-origin module exactly once', () => {
    const source = read('src/defaultRemoteControllerOrigin.ts');
    const publish = read('scripts/publish.ts');
    expect(publish).toContain('path: "src/defaultRemoteControllerOrigin.ts"');
    expect(publish).toContain(`to: "'https://agentstoz-guide.vercel.app'"`);
    // The private build keeps its own default; only the snapshot is rewritten.
    const quoted = `'${DEFAULT_REMOTE_CONTROLLER_ORIGIN}'`;
    expect(source.split(quoted).length - 1).toBe(1);
    // In the public snapshot the module already holds the public value.
    const publicSource = (DEFAULT_REMOTE_CONTROLLER_ORIGIN as string) === 'https://agentstoz-guide.vercel.app'
      ? source
      : applyPublicSnapshotRewrite(source, { path: 'src/defaultRemoteControllerOrigin.ts', from: quoted, to: "'https://agentstoz-guide.vercel.app'" });
    expect(publicSource).toContain("export const DEFAULT_REMOTE_CONTROLLER_ORIGIN = 'https://agentstoz-guide.vercel.app';");
  });
});
