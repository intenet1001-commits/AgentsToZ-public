import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCsDutyHost } from '../src/csDutyHost';

/**
 * The unit fakes stub `documents` out entirely, so two real defects reached the app
 * unnoticed: the host was handed `resolve()` — an identity JSON token, not a path — and
 * the root was joined without canonicalising, which rejects every file under /var
 * (a symlink to /private/var, i.e. every temp dir and many real project locations).
 * These tests run against a real directory so neither can come back silently.
 */
const host = (root: string) => createCsDutyHost(
    mkdtempSync(join(tmpdir(), 'duty-appdata-')),
    async () => JSON.stringify(['id', root, { status: 'found' }]),
    async () => root,
);

function project() {
    const root = mkdtempSync(join(tmpdir(), 'duty-docs-'));
    writeFileSync(join(root, 'README.md'), '# 안내\n공유해도 되는 내용');
    writeFileSync(join(root, 'notes.txt'), 'plain text');
    writeFileSync(join(root, 'app.ts'), 'const secret = 1;');
    mkdirSync(join(root, 'docs'));
    writeFileSync(join(root, 'docs', 'faq.md'), '# FAQ\n답변');
    mkdirSync(join(root, '.agent-memory'));
    writeFileSync(join(root, '.agent-memory', 'CORE.md'), '내부 결정');
    mkdirSync(join(root, 'node_modules'));
    writeFileSync(join(root, 'node_modules', 'readme.md'), 'vendor');
    return root;
}

describe('cs duty project documents', () => {
    test('lists prose documents under a temp (symlinked) root and hides internal ones', async () => {
        const root = project();
        const paths = (await host(root).documents('id')).map(d => d.path).sort();
        // /var → /private/var: before canonicalising the root this returned [].
        expect(paths).toEqual(['README.md', 'docs/faq.md', 'notes.txt']);
        expect(paths.some(p => p.startsWith('.'))).toBe(false);
        expect(paths.some(p => p.startsWith('node_modules'))).toBe(false);
    });

    test('reads only listed documents and refuses anything outside them', async () => {
        const root = project(), h = host(root);
        const text = await h.documentText('id', ['README.md', 'docs/faq.md']);
        expect(text).toContain('# README.md');
        expect(text).toContain('공유해도 되는 내용');
        expect(text).toContain('# docs/faq.md');
        for (const escape of ['../../etc/passwd', '.agent-memory/CORE.md', 'app.ts', 'README.md/../.agent-memory/CORE.md']) {
            await expect(h.documentText('id', [escape])).rejects.toThrow();
        }
    });

    test('a symlink pointing outside the project is neither listed nor readable', async () => {
        const root = project(), outside = mkdtempSync(join(tmpdir(), 'duty-outside-'));
        writeFileSync(join(outside, 'secret.md'), 'API_KEY=live');
        symlinkSync(join(outside, 'secret.md'), join(root, 'linked.md'));
        const h = host(root);
        expect((await h.documents('id')).map(d => d.path)).not.toContain('linked.md');
        await expect(h.documentText('id', ['linked.md'])).rejects.toThrow();
    });

    test('an identity token in place of a path fails loudly instead of listing nothing', async () => {
        const bad = createCsDutyHost(mkdtempSync(join(tmpdir(), 'duty-appdata-')), async () => 'id', async () => JSON.stringify(['id', '/tmp', {}]));
        await expect(bad.documents('id')).rejects.toThrow();
    });
});
