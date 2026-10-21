import { extractDutyPdf, DUTY_PDF_BYTES, DutyPdfFailure } from './csDutyPdf';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, opendir, realpath, lstat } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { parseProjectMemoryEntries } from './projectMemoryRecall';
import type { DutySource, DutySourceBody } from './csDutyKnowledgeTypes';

export const DUTY_SOURCE_BYTES = 200_000;
export const DUTY_TOTAL_BYTES = 20 * 1024 * 1024;
export const sourceHash = (value: string) => createHash('sha256').update(value).digest('hex');
export class DutyKnowledgeFailure extends Error {}
const fail = (message: string): never => { throw new DutyKnowledgeFailure(message); };
const skip = new Set(['node_modules', 'dist', 'dist-portal', 'dist-guide', 'build', 'target', 'worktrees', 'vendor', 'coverage', 'release']);
const prose = (name: string) => /\.(md|markdown|txt|pdf)$/i.test(name) && !name.startsWith('.');
export type DutyMemoryReader = (root: string) => Promise<{ memoryId: string; body: string } | null>;
export type DutySourceCatalog = { sources: DutySource[]; warnings: string[] };

/** Open the exact file, bound the read, and check both descriptor and path again afterwards. */
export async function readDutySourceFile(root: string, rel: string, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    const path = join(root, rel), r = relative(root, path);
    if (!r || r.startsWith('..') || isAbsolute(r) || r.split('/').some(p => p.startsWith('.')))
        return fail('문서 경로를 확인하세요.');
    if (await realpath(path) !== path) return fail('문서 경로가 변경되었습니다. 목록을 다시 확인하세요.');
    const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const before = await fd.stat();
        const pdf = /\.pdf$/i.test(rel);
        if (!before.isFile() || before.size > (pdf ? DUTY_PDF_BYTES : DUTY_SOURCE_BYTES)) return fail('텍스트 문서는 200KB, PDF 파일은 50MiB 이하여야 합니다.');
        const buffer = Buffer.alloc(before.size + 1);
        let count = 0;
        while (count < buffer.length) {
            signal.throwIfAborted();
            const n = await fd.read(buffer, count, buffer.length - count, count);
            if (!n.bytesRead) break;
            count += n.bytesRead;
        }
        const after = await fd.stat(), current = await lstat(path);
        if (count !== before.size || current.isSymbolicLink() || await realpath(path) !== path
            || [after, current].some(s => s.ino !== before.ino || s.dev !== before.dev || s.size !== before.size || s.mtimeMs !== before.mtimeMs || s.ctimeMs !== before.ctimeMs))
            return fail('문서를 읽는 중 내용이 바뀌었습니다. 다시 확인하세요.');
        if (pdf) return await extractDutyPdf(buffer.subarray(0, count), signal);
        const body = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, count)).replace(/\r\n/g, '\n');
        if (body.includes('\0')) return fail('텍스트 문서만 선택할 수 있습니다.');
        return body;
    } finally { await fd.close(); }
}

export class DutySources {
    constructor(private resolvePath: (id: string) => Promise<string>, private memory: DutyMemoryReader) {}
    async collect(targetId: string, includeMemory: boolean, signal: AbortSignal, onlyIds?: ReadonlySet<string>): Promise<{ catalog: DutySourceCatalog; bodies: Map<string, DutySourceBody> }> {
        const raw = await this.resolvePath(targetId);
        if (!isAbsolute(raw)) return fail('프로젝트 경로를 확인하세요.');
        const excluded: DutySource[] = [];
        const root = await realpath(raw), bodies = new Map<string, DutySourceBody>(), warnings: string[] = [];
        let visited = 0, dirs = 0, total = 0;
        const deadline = Date.now() + 30_000;
        signal = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
        const add = (id: string, kind: DutySource['kind'], title: string, body: string, warning?: string) => {
            if (onlyIds && !onlyIds.has(id)) return;
            const bytes = Buffer.byteLength(body);
            if (bytes > DUTY_SOURCE_BYTES) return fail('선택 항목은 개별 200KB 이하여야 합니다.');
            total += bytes;
            if (total > DUTY_TOTAL_BYTES) return fail('자료 목록의 본문 합계가 20MiB를 넘습니다. 프로젝트 자료를 나누어 주세요.');
            if (bodies.has(id)) return fail('자료 항목 ID가 중복됩니다. 원본을 확인하세요.');
            bodies.set(id, { id, kind, title, body, hash: sourceHash(title + '\n' + body), bytes, ...(warning ? { warning } : {}) });
        };
        const walk = async (dir: string, prefix: string, depth: number): Promise<void> => {
            if (++dirs > 500) return fail('폴더 탐색 상한에 도달했습니다. 자료 폴더를 정리한 뒤 다시 확인하세요.');
            const handle = await opendir(dir);
            for await (const entry of handle) {
                signal.throwIfAborted();
                if (++visited > 10_000 || Date.now() > deadline) return fail('자료 탐색 한도에 도달했습니다.');
                if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
                const rel = prefix + entry.name, full = join(root, rel);
                if (entry.isDirectory()) {
                    if (depth < 3 && !skip.has(entry.name)) {
                        if (await realpath(full) !== full) return fail('폴더 경로가 변경되었습니다.');
                        await walk(full, rel + '/', depth + 1);
                    }
                } else if (entry.isFile() && prose(entry.name)) {
                    if (onlyIds && !onlyIds.has(sourceHash('document\n' + rel))) continue;
                    if (bodies.size + excluded.length >= 200) return fail('문서는 최대 200개까지 확인할 수 있습니다.');
                    const fileBytes = (await lstat(full)).size;
                    const reject = (reason: string) => { warnings.push(rel + ' — ' + reason); excluded.push({id:sourceHash('document\n'+rel),kind:'document',title:rel,hash:sourceHash('unavailable\n'+rel),bytes:fileBytes,unavailable:true,warning:reason}); };
                    if (fileBytes > (/\.pdf$/i.test(rel) ? DUTY_PDF_BYTES : DUTY_SOURCE_BYTES)) { reject(/\.pdf$/i.test(rel) ? 'PDF 파일은 50MiB 이하여야 합니다.' : '텍스트 문서는 200KB 이하여야 합니다.'); continue; }
                    let body: string;
                    try { body = await readDutySourceFile(root, rel, signal); } catch (e) {
                        if (!(e instanceof DutyPdfFailure)) throw e;
                        if (onlyIds) return fail(rel + ' — ' + e.message);
                        reject(e.message); continue;
                    }
                    add(sourceHash('document\n' + rel), 'document', rel, body,
                        /^(AGENTS|CLAUDE)\.md$/i.test(entry.name) ? '개발 지침입니다. 공유할 내용을 직접 확인하세요.' : undefined);
                }
            }
        };
        await walk(root, '', 1);
        if (includeMemory) {
            signal.throwIfAborted();
            const memory = await this.memory(root);
            if (memory) {
                if (Buffer.byteLength(memory.body) > DUTY_TOTAL_BYTES) return fail('장기기억이 자료 상한을 넘습니다.');
                const entries = parseProjectMemoryEntries(memory.body);
                if (entries.length > 1000) return fail('장기기억 선택은 최대 1,000항목입니다.');
                if (!entries.length) add(sourceHash('memory\n' + memory.memoryId + '\n' + sourceHash(memory.body)), 'memory', '장기기억 · 전체 본문', memory.body, '내부 결정이 포함될 수 있습니다. 본문을 확인하세요.');
                for (const e of entries) add(sourceHash('memory\n' + memory.memoryId + '\n' + e.entryKey + (e.identitySource === 'legacy' ? '\n' + e.contentVersionHash : '')), 'memory', e.section + ' / ' + e.title, e.body, '장기기억 · 선택한 항목만 공유합니다.');
            } else warnings.push('이 프로젝트에는 초기화된 장기기억이 없습니다.');
        }
        signal.throwIfAborted();
        return { catalog: { sources: [...[...bodies.values()].map(({ body, ...source }) => source), ...excluded].sort((a, b) => a.title.localeCompare(b.title)), warnings }, bodies };
    }
}
